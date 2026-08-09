import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The send gate: which letters a campaign may actually put in somebody's inbox.
 *
 * Two guarantees, and both must fail loudly if they are ever relaxed. ONLY
 * `approved` leads come back — a lead a human never approved is not sendable at
 * any status, including the ones that look finished. And the letter that comes
 * back is the EDITED one where an edit exists, because the user's words win over
 * the model's; a gate that handed the send worker `generated_body` would send
 * something the reviewer had already rejected in favour of their own wording.
 */

const { supabaseFrom } = vi.hoisted(() => ({ supabaseFrom: vi.fn() }));

vi.mock('../src/lib/supabase.js', () => ({
  getSupabaseAdmin: () => ({ from: supabaseFrom }),
  resetSupabaseAdmin: () => {}
}));

vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  sanitizeMeta: (meta) => meta
}));

vi.mock('../src/services/editLearning.js', () => ({ recordEditCorrections: vi.fn() }));

const { selectSendableLeads, outgoingLetter } = await import('../src/services/leadReview.js');
const { logger } = await import('../src/lib/logger.js');

const OWNER = 'user-owner';
const STRANGER = 'user-stranger';
const CAMPAIGN_ID = 'camp-1';
const SUBJECT = 'a question about Blackwood';
const DRAFT = 'hey Marguerite\n\nsaw the raise go through. worth 15 minutes?\n\nthanks,\nAna';
const EDIT = 'hey Marguerite\n\nsaw the raise. worth 15 minutes next week?\n\nthanks,\nAna';

let leadRows = [];
let queries = [];

function matchesFilters(row, filters) {
  return Object.entries(filters).every(([column, value]) => row[column] === value);
}

function builderFor(table, op) {
  const query = { table, op, columns: '', filters: {}, order: null };
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
    then: (onFulfilled, onRejected) =>
      Promise.resolve({
        data: leadRows.filter((row) => matchesFilters(row, query.filters)),
        error: null
      }).then(onFulfilled, onRejected)
  };

  return chain;
}

function tableFake(table) {
  return { select: (columns) => builderFor(table, 'select').select(columns) };
}

function seedLead(status, overrides = {}) {
  const row = {
    id: `lead-${leadRows.length + 1}`,
    campaign_id: CAMPAIGN_ID,
    user_id: OWNER,
    email: `person${leadRows.length + 1}@blackwood.example`,
    first_name: 'Marguerite',
    last_name: 'Okonjo',
    company: 'Blackwood Holdings',
    title: 'Head of Ops',
    status,
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

beforeEach(() => {
  leadRows = [];
  queries = [];
  supabaseFrom.mockReset();
  supabaseFrom.mockImplementation(tableFake);
  logger.info.mockClear();
});

describe('outgoingLetter', () => {
  it('prefers the edit over the draft, and falls back when there is none', () => {
    expect(outgoingLetter({ generated_body: DRAFT, edited_body: EDIT }).body).toBe(EDIT);
    expect(outgoingLetter({ generated_body: DRAFT, edited_body: null }).body).toBe(DRAFT);
    // A blank edit is not an edit — it must never blank out a letter.
    expect(outgoingLetter({ generated_body: DRAFT, edited_body: '   ' }).body).toBe(DRAFT);
  });
});

describe('selectSendableLeads', () => {
  it('returns approved leads only', async () => {
    const approved = seedLead('approved');
    seedLead('generated');
    seedLead('pending');
    seedLead('failed');
    seedLead('sent');
    seedLead('replied');

    const sendable = await selectSendableLeads(OWNER, CAMPAIGN_ID);

    expect(sendable.map((letter) => letter.id)).toEqual([approved.id]);
  });

  it('asks the database for approved leads and re-checks the status it got back', async () => {
    seedLead('approved');

    await selectSendableLeads(OWNER, CAMPAIGN_ID);

    expect(queries[0].filters).toEqual({
      campaign_id: CAMPAIGN_ID,
      user_id: OWNER,
      status: 'approved'
    });
  });

  it('drops a row the query returned that is not approved after all', async () => {
    // The query filter is the fast path; the in-memory check is the one that
    // still holds if a future edit loosens it. Simulated by a fake that ignores
    // the status filter, exactly as a mistaken query would.
    supabaseFrom.mockImplementation(() => ({
      select: () => ({
        eq: function eq() {
          return this;
        },
        order: function order() {
          return this;
        },
        then: (onFulfilled) => Promise.resolve({ data: leadRows, error: null }).then(onFulfilled)
      })
    }));

    seedLead('generated');
    seedLead('queued');

    expect(await selectSendableLeads(OWNER, CAMPAIGN_ID)).toEqual([]);
  });

  it("sends the edited words, not the model's", async () => {
    const edited = seedLead('approved', { edited_body: EDIT });

    const [letter] = await selectSendableLeads(OWNER, CAMPAIGN_ID);

    expect(letter).toEqual({ id: edited.id, email: edited.email, subject: SUBJECT, body: EDIT });
  });

  it("returns nothing for another user's campaign, and filters on user_id", async () => {
    seedLead('approved');

    expect(await selectSendableLeads(STRANGER, CAMPAIGN_ID)).toEqual([]);
    expect(queries[0].filters.user_id).toBe(STRANGER);
  });

  it('skips an approved lead whose letter is empty', async () => {
    seedLead('approved', { generated_body: '  ', edited_body: null });
    seedLead('approved', { generated_subject: '' });

    expect(await selectSendableLeads(OWNER, CAMPAIGN_ID)).toEqual([]);
  });

  it('logs ids and a count only — never a letter or a recipient', async () => {
    seedLead('approved', { edited_body: EDIT });

    await selectSendableLeads(OWNER, CAMPAIGN_ID);

    const serialized = JSON.stringify(logger.info.mock.calls);

    expect(serialized).not.toContain('saw the raise');
    expect(serialized).not.toContain('Marguerite');
    expect(serialized).not.toContain('blackwood.example');
    expect(logger.info).toHaveBeenCalledWith('sendable_leads_selected', {
      userId: OWNER,
      campaignId: CAMPAIGN_ID,
      count: 1
    });
  });
});
