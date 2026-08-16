import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The daily draft job (CLAUDE.md, Decisions 2026-08-16).
 *
 * Three properties carry the design, and each has a test that fails if it stops
 * holding:
 *
 *  1. THE CEILING IS NOT A QUOTA. A short day delivers less, never something
 *     weaker. A run that delivers nothing is `empty` — a success — and sends no
 *     email at all.
 *  2. THE CLAIM COMES FIRST. Nothing that costs money or touches the user's inbox
 *     may run before the day is claimed, because everything before it can run twice.
 *  3. NOTHING IS SENT. This job drafts and notifies; a prospect is reached only
 *     through per-lead approval (2026-08-08).
 */

const { claimRun, completeRun, markNotified, failRun } = vi.hoisted(() => ({
  claimRun: vi.fn(),
  completeRun: vi.fn(),
  markNotified: vi.fn(),
  failRun: vi.fn()
}));

const { getOrCreateDailyCampaign, supabaseFrom } = vi.hoisted(() => ({
  getOrCreateDailyCampaign: vi.fn(),
  supabaseFrom: vi.fn()
}));

vi.mock('../src/services/dailyRun.js', () => ({
  claimRun,
  completeRun,
  markNotified,
  failRun,
  today: () => '2026-08-16'
}));

vi.mock('../src/services/dailyCampaign.js', () => ({ getOrCreateDailyCampaign }));

vi.mock('../src/lib/supabase.js', () => ({
  getSupabaseAdmin: () => ({ from: supabaseFrom }),
  resetSupabaseAdmin: () => {}
}));

vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  sanitizeMeta: (meta) => meta
}));

const { runForUser } = await import('../src/workers/dailyDraftJob.js');

const TARGET = {
  user_id: 'user-1',
  titles: ['director'],
  daily_target: 2,
  fit_notes: 'We sell to K-12 districts.'
};

function candidate(email, hook = 'They rolled out 1:1 Chromebooks across twelve schools.') {
  return {
    email,
    title: 'Director of Technology',
    verification: { status: 'deliverable' },
    research: { hooks: [hook] }
  };
}

/** profiles / leads / unsubscribes reads, all trivially empty unless overridden. */
function tableStub(rows = {}) {
  return (table) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({ data: rows.profile ?? { email: 'user@example.com' } }),
      then: (resolve, reject) => Promise.resolve({ data: rows[table] ?? [] }).then(resolve, reject)
    };
    return chain;
  };
}

let draftLead;
let notify;

beforeEach(() => {
  claimRun.mockReset().mockResolvedValue({ id: 'run-1', status: 'running' });
  completeRun.mockReset().mockResolvedValue('delivered');
  markNotified.mockReset().mockResolvedValue(undefined);
  failRun.mockReset().mockResolvedValue(undefined);
  getOrCreateDailyCampaign.mockReset().mockResolvedValue({ id: 'campaign-daily' });
  supabaseFrom.mockReset().mockImplementation(tableStub());

  draftLead = vi.fn().mockResolvedValue({ fidelityScore: 91 });
  notify = vi.fn().mockResolvedValue({ sent: true });
});

describe('the claim comes first', () => {
  it('does nothing at all when the day is already claimed', async () => {
    claimRun.mockResolvedValue(null);
    const findLeads = vi.fn();

    const result = await runForUser(TARGET, { draftLead, notify, findLeads });

    expect(result).toEqual({ ran: false, reason: 'already_claimed' });
    // The expensive and irreversible things: none of them happened.
    expect(findLeads).not.toHaveBeenCalled();
    expect(draftLead).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('claims before it searches, not after', async () => {
    const order = [];
    claimRun.mockImplementation(async () => {
      order.push('claim');
      return { id: 'run-1' };
    });
    const findLeads = vi.fn(async () => {
      order.push('search');
      return [];
    });

    await runForUser(TARGET, { draftLead, notify, findLeads });

    expect(order).toEqual(['claim', 'search']);
  });
});

describe('the ceiling is not a quota', () => {
  it('delivers only up to daily_target even when more candidates qualify', async () => {
    const findLeads = vi
      .fn()
      .mockResolvedValue([1, 2, 3, 4, 5].map((n) => candidate(`p${n}@district.org`)));

    const result = await runForUser(TARGET, { draftLead, notify, findLeads });

    expect(result.delivered).toBe(2);
    expect(draftLead).toHaveBeenCalledTimes(2);
  });

  it('delivers ONE when only one candidate clears the gates — it does not pad', async () => {
    const findLeads = vi.fn().mockResolvedValue([
      candidate('good@district.org'),
      // Fails gate 7: the shape research returns when it found nothing.
      candidate('thin@district.org', 'growth'),
      // Fails gate 1.
      { ...candidate('unverified@district.org'), verification: { status: 'unknown' } }
    ]);

    const result = await runForUser(TARGET, { draftLead, notify, findLeads });

    expect(result.delivered).toBe(1);
    expect(notify).toHaveBeenCalledWith('user@example.com', 1);
  });

  it('delivers nothing, emails nobody, and records `empty` when no candidate qualifies', async () => {
    const findLeads = vi.fn().mockResolvedValue([candidate('thin@district.org', 'AI')]);
    completeRun.mockResolvedValue('empty');

    const result = await runForUser(TARGET, { draftLead, notify, findLeads });

    expect(result.delivered).toBe(0);
    expect(draftLead).not.toHaveBeenCalled();
    // "0 drafts ready" is worse than silence.
    expect(notify).not.toHaveBeenCalled();
    expect(completeRun).toHaveBeenCalledWith('run-1', {
      candidatesScreened: 1,
      leadsDelivered: 0
    });
  });

  it('delivers nothing when the source returns nothing — the Stage A default', async () => {
    const findLeads = vi.fn().mockResolvedValue([]);

    const result = await runForUser(TARGET, { draftLead, notify, findLeads });

    expect(result).toMatchObject({ ran: true, screened: 0, delivered: 0 });
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('gate 8 blocks at the job level', () => {
  it('drops a draft below the fidelity floor rather than queueing it', async () => {
    draftLead.mockResolvedValue({ fidelityScore: 79 });
    const findLeads = vi.fn().mockResolvedValue([candidate('good@district.org')]);

    const result = await runForUser(TARGET, { draftLead, notify, findLeads });

    expect(draftLead).toHaveBeenCalledTimes(1);
    expect(result.delivered).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('accepts exactly the floor', async () => {
    draftLead.mockResolvedValue({ fidelityScore: 80 });
    const findLeads = vi.fn().mockResolvedValue([candidate('good@district.org')]);

    expect((await runForUser(TARGET, { draftLead, notify, findLeads })).delivered).toBe(1);
  });
});

describe('no re-contacting', () => {
  it('skips an address already in the user’s leads', async () => {
    supabaseFrom.mockImplementation(tableStub({ leads: [{ email: 'known@district.org' }] }));
    const findLeads = vi.fn().mockResolvedValue([candidate('known@district.org')]);

    expect((await runForUser(TARGET, { draftLead, notify, findLeads })).delivered).toBe(0);
  });

  it('skips an address that unsubscribed', async () => {
    supabaseFrom.mockImplementation(tableStub({ unsubscribes: [{ email: 'gone@district.org' }] }));
    const findLeads = vi.fn().mockResolvedValue([candidate('gone@district.org')]);

    expect((await runForUser(TARGET, { draftLead, notify, findLeads })).delivered).toBe(0);
  });

  it('does not deliver the same address twice inside one run', async () => {
    const findLeads = vi
      .fn()
      .mockResolvedValue([candidate('dupe@district.org'), candidate('dupe@district.org')]);

    expect((await runForUser(TARGET, { draftLead, notify, findLeads })).delivered).toBe(1);
  });
});

describe('the notification', () => {
  it('marks notified only when the send actually succeeded', async () => {
    notify.mockResolvedValue({ sent: false, reason: 'not_configured' });
    const findLeads = vi.fn().mockResolvedValue([candidate('good@district.org')]);

    await runForUser(TARGET, { draftLead, notify, findLeads });

    // Drafts were still produced and are in the app; the run stays retryable for
    // the NOTIFICATION alone.
    expect(completeRun).toHaveBeenCalled();
    expect(markNotified).not.toHaveBeenCalled();
  });

  it('is told a count, never the leads', async () => {
    const findLeads = vi.fn().mockResolvedValue([candidate('good@district.org')]);

    await runForUser(TARGET, { draftLead, notify, findLeads });

    const [, second] = notify.mock.calls[0];
    expect(second).toBe(1);
    expect(notify.mock.calls[0]).toHaveLength(2);
  });
});

describe('failure handling', () => {
  it('marks the run failed and rethrows, so the day is not left `running`', async () => {
    const findLeads = vi.fn().mockRejectedValue(new Error('vendor exploded'));

    await expect(runForUser(TARGET, { draftLead, notify, findLeads })).rejects.toThrow(
      'vendor exploded'
    );
    expect(failRun).toHaveBeenCalledWith('run-1', 'user-1');
  });
});
