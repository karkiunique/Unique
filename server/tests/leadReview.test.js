import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The batch approval gate.
 *
 * These are the assertions that have to fail if the gate is ever loosened: a
 * lead reaching `approved` without an explicit per-lead approval, an approval
 * for somebody else's lead, a status set straight from a request body, or an
 * edit that does not end up being the thing that would be sent.
 *
 * The Supabase fake records the filters of every query it is handed, because the
 * server bypasses RLS and `user_id` on each query IS the access control — a test
 * that only checked returned rows would pass against a service that filtered
 * nothing and got lucky with the fixtures.
 */

const { supabaseFrom, recordEditCorrections } = vi.hoisted(() => ({
  supabaseFrom: vi.fn(),
  recordEditCorrections: vi.fn()
}));

vi.mock('../src/lib/supabase.js', () => ({
  getSupabaseAdmin: () => ({ from: supabaseFrom }),
  resetSupabaseAdmin: () => {}
}));

vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  sanitizeMeta: (meta) => meta
}));

// The edit-learning loop has its own suite. Here it is a spy, so these tests are
// about WHEN an edit is offered to it, never about what it makes of one.
vi.mock('../src/services/editLearning.js', () => ({ recordEditCorrections }));

const { getLead, updateLead } = await import('../src/services/leadReview.js');
const { logger } = await import('../src/lib/logger.js');

const OWNER = 'user-owner';
const STRANGER = 'user-stranger';
const SUBJECT = 'a question about Blackwood';
const DRAFT = 'hey Marguerite\n\nsaw the raise go through. worth 15 minutes?\n\nthanks,\nAna';
const EDIT = 'hey Marguerite\n\nsaw the raise go through. worth 15 minutes\n\nthanks,\nAna';

// Everything a letter cannot come back from, plus the two that never had one.
const UNAPPROVABLE = ['pending', 'queued', 'sent', 'replied', 'bounced', 'unsubscribed', 'failed'];

let leadRows = [];
let queries = [];

function matchesFilters(row, filters) {
  return Object.entries(filters).every(([column, value]) => row[column] === value);
}

function runQuery(query) {
  const found = leadRows.filter((row) => matchesFilters(row, query.filters));

  if (query.op === 'update') {
    for (const row of found) Object.assign(row, query.values);
  }

  return found;
}

/** Resolve once per query, so awaiting the same builder twice cannot write twice. */
function settle(query) {
  if (!query.settled) query.settled = runQuery(query);
  return query.settled;
}

function builderFor(table, op, values) {
  const query = { table, op, values, columns: '', filters: {}, order: null, settled: null };
  queries.push(query);

  const chain = {
    select(columns = '') {
      query.columns = columns;
      return chain;
    },
    eq(column, value) {
      query.filters[column] = value;
      return chain;
    },
    order(column, options) {
      query.order = { column, ascending: options?.ascending };
      return chain;
    },
    single: async () => ({ data: settle(query)[0] ?? null, error: null }),
    maybeSingle: async () => ({ data: settle(query)[0] ?? null, error: null }),
    then: (onFulfilled, onRejected) =>
      Promise.resolve({ data: settle(query), error: null }).then(onFulfilled, onRejected)
  };

  return chain;
}

function tableFake(table) {
  return {
    update: (values) => builderFor(table, 'update', values),
    select: (columns) => builderFor(table, 'select', null).select(columns)
  };
}

function queriesOn(op) {
  return queries.filter((query) => query.table === 'leads' && query.op === op);
}

function seedLead(overrides = {}) {
  const row = {
    id: `lead-${leadRows.length + 1}`,
    campaign_id: 'camp-1',
    user_id: OWNER,
    email: 'marguerite@blackwood.example',
    first_name: 'Marguerite',
    last_name: 'Okonjo',
    company: 'Blackwood Holdings',
    title: 'Head of Ops',
    status: 'generated',
    fidelity_score: 88,
    generated_subject: SUBJECT,
    generated_body: DRAFT,
    edited_body: null,
    sent_at: null,
    created_at: '2026-08-06T00:00:00.000Z',
    ...overrides
  };
  leadRows.push(row);

  return row;
}

/** The HTTP status a call rejected with, or null if it did not reject at all. */
async function rejectionStatus(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err?.status ?? 'no status';
  }
}

beforeEach(() => {
  leadRows = [];
  queries = [];
  supabaseFrom.mockReset();
  supabaseFrom.mockImplementation(tableFake);
  recordEditCorrections.mockReset();
  recordEditCorrections.mockResolvedValue({ learned: 0 });
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
});

describe('getLead', () => {
  it('returns the letter to its owner', async () => {
    const lead = seedLead();

    const found = await getLead(OWNER, lead.id);

    expect(found.generated_body).toBe(DRAFT);
    expect(found.fidelity_score).toBe(88);
  });

  it("404s on another user's lead, and filters the read on user_id", async () => {
    const lead = seedLead();

    expect(await rejectionStatus(getLead(STRANGER, lead.id))).toBe(404);
    expect(queriesOn('select')[0].filters).toEqual({ id: lead.id, user_id: STRANGER });
  });

  it('404s on an unknown lead id', async () => {
    expect(await rejectionStatus(getLead(OWNER, 'lead-nope'))).toBe(404);
  });
});

describe('the approval gate', () => {
  it('does not approve a lead that was only edited', async () => {
    const lead = seedLead();

    const updated = await updateLead(OWNER, lead.id, { body: EDIT });

    expect(updated.status).toBe('generated');
    expect(leadRows[0].status).toBe('generated');
  });

  it('approves only on an explicit per-lead approval', async () => {
    const lead = seedLead();

    const updated = await updateLead(OWNER, lead.id, { approve: true });

    expect(updated.status).toBe('approved');
    expect(leadRows[0].status).toBe('approved');
  });

  it('cannot be approved by a status in the patch body', async () => {
    const lead = seedLead();

    const status = await rejectionStatus(
      updateLead(OWNER, lead.id, { status: 'approved', user_id: STRANGER, fidelity_score: 100 })
    );

    expect(status).toBe(400);
    expect(leadRows[0].status).toBe('generated');
    expect(leadRows[0].fidelity_score).toBe(88);
    expect(queriesOn('update')).toHaveLength(0);
  });

  it('refuses to approve a lead that has never been drafted for', async () => {
    const lead = seedLead({ status: 'pending', generated_subject: null, generated_body: null });

    expect(await rejectionStatus(updateLead(OWNER, lead.id, { approve: true }))).toBe(400);
    expect(leadRows[0].status).toBe('pending');
    expect(queriesOn('update')).toHaveLength(0);
  });

  it('refuses to approve from any status that is not a live draft', async () => {
    for (const status of UNAPPROVABLE) {
      const lead = seedLead({ status });

      expect(await rejectionStatus(updateLead(OWNER, lead.id, { approve: true }))).toBe(400);
      expect(lead.status).toBe(status);
    }

    expect(queriesOn('update')).toHaveLength(0);
  });

  it("404s on another user's lead and writes nothing", async () => {
    const lead = seedLead();

    expect(await rejectionStatus(updateLead(STRANGER, lead.id, { approve: true }))).toBe(404);
    expect(leadRows[0].status).toBe('generated');
    expect(queriesOn('update')).toHaveLength(0);
  });

  it('refuses to approve a lead with no letter to send', async () => {
    const empty = seedLead({ generated_body: '   ' });
    const unsubjected = seedLead({ generated_subject: '' });

    expect(await rejectionStatus(updateLead(OWNER, empty.id, { approve: true }))).toBe(400);
    expect(await rejectionStatus(updateLead(OWNER, unsubjected.id, { approve: true }))).toBe(400);
    expect(queriesOn('update')).toHaveLength(0);
  });

  it('rejects an approve flag that is not a boolean', async () => {
    const lead = seedLead();

    for (const approve of ['true', 1, {}, 'yes']) {
      expect(await rejectionStatus(updateLead(OWNER, lead.id, { approve }))).toBe(400);
    }

    expect(leadRows[0].status).toBe('generated');
  });

  it('leaves an approved lead approved when it is approved again', async () => {
    const lead = seedLead({ status: 'approved' });

    const updated = await updateLead(OWNER, lead.id, { approve: true });

    expect(updated.status).toBe('approved');
  });

  it('carries user_id on the write itself, not just the ownership check', async () => {
    const lead = seedLead();

    await updateLead(OWNER, lead.id, { approve: true });

    expect(queriesOn('update')[0].filters).toEqual({ id: lead.id, user_id: OWNER });
  });
});

describe('editing a letter', () => {
  it('stores the edit in edited_body and leaves the draft intact', async () => {
    const lead = seedLead();

    const updated = await updateLead(OWNER, lead.id, { body: EDIT });

    expect(updated.edited_body).toBe(EDIT);
    // The diff the edit-learning loop needs survives the edit.
    expect(updated.generated_body).toBe(DRAFT);
  });

  it('stores the subject exactly as sent, byte for byte', async () => {
    const lead = seedLead();

    const updated = await updateLead(OWNER, lead.id, { subject: '  spaced out  ' });

    // Nothing is rewritten after the human reads it — the compose flow's rule.
    expect(updated.generated_subject).toBe('  spaced out  ');
  });

  it('withdraws approval when the words change after it', async () => {
    const lead = seedLead({ status: 'approved' });

    const updated = await updateLead(OWNER, lead.id, { body: EDIT });

    // The approval was for the old letter; the new one has not been approved.
    expect(updated.status).toBe('generated');
  });

  it('approves the edited words when both arrive together', async () => {
    const lead = seedLead();

    const updated = await updateLead(OWNER, lead.id, {
      subject: 'a shorter subject',
      body: EDIT,
      approve: true
    });

    expect(updated.status).toBe('approved');
    expect(updated.edited_body).toBe(EDIT);
    expect(updated.generated_subject).toBe('a shorter subject');
  });

  it('rejects an empty subject, an empty body and an over-long body', async () => {
    const lead = seedLead();

    expect(await rejectionStatus(updateLead(OWNER, lead.id, { subject: '   ' }))).toBe(400);
    expect(await rejectionStatus(updateLead(OWNER, lead.id, { body: '  \n ' }))).toBe(400);
    expect(await rejectionStatus(updateLead(OWNER, lead.id, { body: 'x'.repeat(20001) }))).toBe(400);
    expect(queriesOn('update')).toHaveLength(0);
  });

  it('refuses to edit a letter that has already gone out', async () => {
    const lead = seedLead({ status: 'sent' });

    expect(await rejectionStatus(updateLead(OWNER, lead.id, { body: EDIT }))).toBe(400);
    expect(leadRows[0].edited_body).toBeNull();
  });

  it('400s when the patch carries nothing editable', async () => {
    const lead = seedLead();

    expect(await rejectionStatus(updateLead(OWNER, lead.id, {}))).toBe(400);
    expect(queriesOn('update')).toHaveLength(0);
  });

  it('offers a body edit to the edit-learning loop, against the original draft', async () => {
    const lead = seedLead();

    await updateLead(OWNER, lead.id, { body: EDIT });

    expect(recordEditCorrections).toHaveBeenCalledWith(OWNER, DRAFT, EDIT);
  });

  it('does not run the learning loop for a subject-only edit', async () => {
    const lead = seedLead();

    await updateLead(OWNER, lead.id, { subject: 'a shorter subject' });

    expect(recordEditCorrections).not.toHaveBeenCalled();
  });

  it('keeps the edit when the learning loop falls over', async () => {
    recordEditCorrections.mockRejectedValue(new Error('profile unreadable'));
    const lead = seedLead();

    const updated = await updateLead(OWNER, lead.id, { body: EDIT });

    expect(updated.edited_body).toBe(EDIT);
  });
});

describe('review logging', () => {
  it('logs ids only — never a letter, a name, an employer or an address', async () => {
    const lead = seedLead();

    await getLead(OWNER, lead.id);
    await updateLead(OWNER, lead.id, { body: EDIT });
    await updateLead(OWNER, lead.id, { approve: true });

    const serialized = JSON.stringify([
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls
    ]);

    expect(serialized).not.toContain('saw the raise go through');
    expect(serialized).not.toContain('Marguerite');
    expect(serialized).not.toContain('Blackwood');
    expect(serialized).not.toContain('marguerite@blackwood.example');

    expect(logger.info).toHaveBeenCalledWith('lead_approved', {
      userId: OWNER,
      leadId: lead.id,
      campaignId: 'camp-1'
    });
  });
});
