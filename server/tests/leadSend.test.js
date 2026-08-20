import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * POST /api/leads/:id/send — the only route from an approved lead to an inbox
 * (CLAUDE.md, Decisions 2026-08-19).
 *
 * This is the send path, so the tests assert on the CALL wherever the outcome
 * could look identical while the gate was bypassed. That is not pedantry: this
 * project has already shipped a route variant that sent mail with no
 * confirmation and passed a fully green suite, and TODO.md records that two
 * owner-filter holes survived their first mutation round because the outward 404
 * came from a different layer.
 *
 * Three gates, and one test each for the way each one fails open:
 *   1. approval  — read through selectSendableLeads, never a re-query
 *   2. fidelity  — the stored score, with edited_body as the escape hatch
 *   3. exact confirmation — of the letter that will ACTUALLY go out
 */

const { selectSendableLeads, sendEmail, supabaseFrom } = vi.hoisted(() => ({
  selectSendableLeads: vi.fn(),
  sendEmail: vi.fn(),
  supabaseFrom: vi.fn()
}));

vi.mock('../src/services/leadReview.js', () => ({ selectSendableLeads }));
vi.mock('../src/services/send.js', () => ({ sendEmail }));
vi.mock('../src/lib/supabase.js', () => ({
  getSupabaseAdmin: () => ({ from: supabaseFrom }),
  resetSupabaseAdmin: () => {}
}));
vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  sanitizeMeta: (meta) => meta
}));

const { sendApprovedLead, fidelityVerdict } = await import('../src/services/leadSend.js');

const OWNER = 'user-1';
const LEAD = 'lead-1';
const SUBJECT = 'twelve schools, one rollout';
const BODY = 'Dana — saw the Chromebook rollout.\n\nWorth 15 minutes?\n\nUnique';

let gateRow;
let updates;

function stubTables() {
  supabaseFrom.mockImplementation(() => {
    const query = { filters: {}, values: null };
    const chain = {
      select: () => chain,
      update(values) {
        query.values = values;
        updates.push(query);
        return chain;
      },
      eq(column, value) {
        query.filters[column] = value;
        return chain;
      },
      maybeSingle: async () => ({ data: gateRow, error: null }),
      then: (resolve, reject) => Promise.resolve({ error: null }).then(resolve, reject)
    };
    return chain;
  });
}

function confirmed(overrides = {}) {
  return { confirmed: true, subject: SUBJECT, body: BODY, ...overrides };
}

beforeEach(() => {
  updates = [];
  gateRow = { id: LEAD, campaign_id: 'camp-1', fidelity_score: 91, edited_body: null, status: 'approved' };
  stubTables();
  selectSendableLeads.mockReset().mockResolvedValue([{ id: LEAD, email: 'dana@x.org', subject: SUBJECT, body: BODY }]);
  sendEmail.mockReset().mockResolvedValue({ messageId: 'm1', threadId: 't1' });
});

describe('the happy path', () => {
  it('sends the approved letter and marks it sent', async () => {
    const result = await sendApprovedLead(OWNER, LEAD, confirmed());

    expect(sendEmail).toHaveBeenCalledWith(OWNER, {
      to: 'dana@x.org',
      subject: SUBJECT,
      body: BODY
    });
    expect(result).toEqual({ id: LEAD, status: 'sent', threadId: 't1' });

    const [update] = updates.filter((u) => u.values);
    expect(update.values.status).toBe('sent');
    expect(update.values.gmail_message_id).toBe('m1');
    expect(update.filters.user_id).toBe(OWNER);
  });
});

describe('gate 1 — approval', () => {
  /**
   * ON THE CALL, NOT THE OUTCOME. A version that re-queried `leads` for the
   * letter would return the same body and send the same mail while skipping the
   * approval filter entirely, and an outcome assertion cannot see the difference.
   */
  it('reads the letter through selectSendableLeads', async () => {
    await sendApprovedLead(OWNER, LEAD, confirmed());

    expect(selectSendableLeads).toHaveBeenCalledWith(OWNER, 'camp-1');
  });

  it('refuses when the lead is not in the sendable set', async () => {
    selectSendableLeads.mockResolvedValue([]);

    await expect(sendApprovedLead(OWNER, LEAD, confirmed())).rejects.toMatchObject({ status: 409 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('refuses a lead belonging to someone else with 404, never 403', async () => {
    gateRow = null;

    await expect(sendApprovedLead(OWNER, 'someone-elses', confirmed())).rejects.toMatchObject({
      status: 404
    });
    // 403 would confirm the id exists.
    expect(selectSendableLeads).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe('gate 2 — the fidelity floor, server-side', () => {
  it('refuses an untouched draft below the floor', async () => {
    gateRow.fidelity_score = 79;

    await expect(sendApprovedLead(OWNER, LEAD, confirmed())).rejects.toMatchObject({ status: 422 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('allows exactly the floor', async () => {
    gateRow.fidelity_score = 80;

    await expect(sendApprovedLead(OWNER, LEAD, confirmed())).resolves.toMatchObject({ status: 'sent' });
  });

  it('refuses an unscored draft — unscored is not passing', async () => {
    gateRow.fidelity_score = null;

    await expect(sendApprovedLead(OWNER, LEAD, confirmed())).rejects.toMatchObject({ status: 422 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  /**
   * THE ESCAPE HATCH (§ 3). Once the human has rewritten it the words are theirs,
   * so the model's score no longer describes what is being sent. Never trap
   * someone behind a number the model cannot reach.
   */
  it('allows an edited letter however bad the stored score', async () => {
    gateRow.fidelity_score = 12;
    gateRow.edited_body = 'I rewrote this myself.';

    await expect(sendApprovedLead(OWNER, LEAD, confirmed())).resolves.toMatchObject({ status: 'sent' });
  });

  it('does not treat whitespace as an edit', async () => {
    gateRow.fidelity_score = 40;
    gateRow.edited_body = '   \n  ';

    await expect(sendApprovedLead(OWNER, LEAD, confirmed())).rejects.toMatchObject({ status: 422 });
  });

  it('cannot be talked past by the client', async () => {
    gateRow.fidelity_score = 20;

    // Every shape a caller might try to smuggle a passing score in with.
    await expect(
      sendApprovedLead(OWNER, LEAD, confirmed({ fidelityScore: 99, fidelity_score: 99, score: 99 }))
    ).rejects.toMatchObject({ status: 422 });
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe('gate 3 — confirmation of the exact content', () => {
  it('refuses without explicit confirmation', async () => {
    await expect(sendApprovedLead(OWNER, LEAD, { subject: SUBJECT, body: BODY })).rejects.toMatchObject({
      status: 400
    });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('refuses a truthy-but-not-true confirmation', async () => {
    await expect(
      sendApprovedLead(OWNER, LEAD, { confirmed: 'yes', subject: SUBJECT, body: BODY })
    ).rejects.toMatchObject({ status: 400 });
  });

  /**
   * The failure this gate exists for: a human approves one letter while a
   * different one goes out. A boolean confirmation cannot tell them apart.
   */
  it('refuses when the confirmed body is not what would be sent', async () => {
    await expect(
      sendApprovedLead(OWNER, LEAD, confirmed({ body: 'a completely different letter' }))
    ).rejects.toMatchObject({ status: 409 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('refuses when the confirmed subject differs', async () => {
    await expect(
      sendApprovedLead(OWNER, LEAD, confirmed({ subject: 'something else entirely' }))
    ).rejects.toMatchObject({ status: 409 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('tolerates only leading and trailing whitespace', async () => {
    await expect(
      sendApprovedLead(OWNER, LEAD, confirmed({ subject: `  ${SUBJECT}  `, body: `\n${BODY}\n` }))
    ).resolves.toMatchObject({ status: 'sent' });
  });
});

describe('fidelityVerdict', () => {
  it.each([
    [{ fidelity_score: 91, edited_body: null }, true, 'scored'],
    [{ fidelity_score: 79, edited_body: null }, false, 'below_floor'],
    [{ fidelity_score: null, edited_body: null }, false, 'unscored'],
    [{ fidelity_score: 5, edited_body: 'mine' }, true, 'edited'],
    [{}, false, 'unscored']
  ])('%j -> allowed=%s (%s)', (row, allowed, reason) => {
    expect(fidelityVerdict(row)).toEqual({ allowed, reason });
  });
});
