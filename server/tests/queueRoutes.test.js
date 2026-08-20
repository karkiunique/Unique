import { describe, it, expect, vi, beforeEach } from 'vitest';

import { useSharedTestServer } from './helpers/testServer.js';

/**
 * GET /api/target, PUT /api/target, GET /api/queue, POST /api/leads/:id/reject
 * (CLAUDE.md, Decisions 2026-08-16).
 *
 * OWNER SCOPING is the thing under test. Every id here is attacker-controlled —
 * the lead id in the path, any user_id in the body — so the tests assert that the
 * owner filter reaches the QUERY, not merely that the response looked right. A
 * re-query can return an identical result while dropping the filter.
 *
 * PRIVACY: `fit_notes` and a rejection `note` are the user's own words about their
 * business. They go back to their owner and nowhere else, and never to a log.
 */

const { getUser, supabaseFrom } = vi.hoisted(() => ({
  getUser: vi.fn(),
  supabaseFrom: vi.fn()
}));

vi.mock('../src/lib/supabase.js', () => ({
  getSupabaseAdmin: () => ({ auth: { getUser }, from: supabaseFrom }),
  resetSupabaseAdmin: () => {}
}));

vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  sanitizeMeta: (meta) => meta
}));

const { createApp } = await import('../src/app.js');
const { logger } = await import('../src/lib/logger.js');

const OWNER = 'user-owner';
const TOKEN = 'Bearer good.jwt';
const FIT_NOTES = 'We sell classroom software to K-12 districts in California.';

let queries = [];
let answers = {};

function builderFor(table) {
  const query = { table, op: 'select', filters: {}, values: null };
  queries.push(query);

  const chain = {
    select() {
      return chain;
    },
    insert(values) {
      query.op = 'insert';
      query.values = values;
      return chain;
    },
    update(values) {
      query.op = 'update';
      query.values = values;
      return chain;
    },
    upsert(values, options) {
      query.op = 'upsert';
      query.values = values;
      query.options = options;
      return chain;
    },
    eq(column, value) {
      query.filters[column] = value;
      return chain;
    },
    in(column, values) {
      query.filters[column] = values;
      return chain;
    },
    order() {
      return chain;
    },
    maybeSingle: async () => answers[table]?.single ?? { data: null, error: null },
    single: async () => answers[table]?.single ?? { data: null, error: null },
    then: (resolve, reject) =>
      Promise.resolve(answers[table]?.list ?? { data: [], error: null }).then(resolve, reject)
  };

  return chain;
}

function logText() {
  return [...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls]
    .map((call) => JSON.stringify(call))
    .join(' ');
}

const httpRequest = useSharedTestServer(createApp);

function authed(method, path) {
  return httpRequest(method, path).set('Authorization', TOKEN);
}

beforeEach(() => {
  queries = [];
  answers = {};
  supabaseFrom.mockReset().mockImplementation(builderFor);
  getUser.mockReset().mockResolvedValue({
    data: { user: { id: OWNER, email: 'owner@example.com' } },
    error: null
  });
  logger.info.mockReset();
  logger.warn.mockReset();
  logger.error.mockReset();
});

describe('auth', () => {
  it.each([
    ['get', '/api/target'],
    ['put', '/api/target'],
    ['get', '/api/queue'],
    ['post', '/api/leads/lead-1/reject']
  ])('%s %s refuses an unauthenticated caller', async (method, path) => {
    const response = await httpRequest(method, path).send({});

    expect(response.status).toBe(401);
  });
});

describe('PUT /api/target', () => {
  it('writes against the JWT owner, never a user_id from the body', async () => {
    answers.lead_targets = { single: { data: { id: 't1', daily_target: 2 }, error: null } };

    const response = await authed('put', '/api/target').send({
      user_id: 'someone-else',
      titles: ['Director of Technology'],
      dailyTarget: 3,
      fitNotes: FIT_NOTES
    });

    expect(response.status).toBe(200);
    const write = queries.find((q) => q.table === 'lead_targets');
    expect(write.values.user_id).toBe(OWNER);
    expect(write.options).toMatchObject({ onConflict: 'user_id' });
  });

  it('clamps the daily ceiling rather than rejecting it — it is a slider, not a gate', async () => {
    answers.lead_targets = { single: { data: { id: 't1' }, error: null } };

    await authed('put', '/api/target').send({ dailyTarget: 99 });
    expect(queries.find((q) => q.table === 'lead_targets').values.daily_target).toBe(5);

    queries = [];
    await authed('put', '/api/target').send({ dailyTarget: 0 });
    expect(queries.find((q) => q.table === 'lead_targets').values.daily_target).toBe(1);
  });

  /**
   * An ABSENT criterion must round-trip as null, not []. The gates read absent as
   * "no constraint" and empty as the same thing only by accident — storing [] and
   * storing null must not become indistinguishable at the boundary.
   */
  it('stores an omitted criterion as null, not an empty array', async () => {
    answers.lead_targets = { single: { data: { id: 't1' }, error: null } };

    await authed('put', '/api/target').send({ titles: ['Director'], industries: [] });

    const { values } = queries.find((q) => q.table === 'lead_targets');
    expect(values.titles).toEqual(['Director']);
    expect(values.industries).toBeNull();
    expect(values.geos).toBeNull();
  });

  it('never logs fit_notes — it is the user’s own business description', async () => {
    answers.lead_targets = { single: { data: { id: 't1', daily_target: 2 }, error: null } };

    await authed('put', '/api/target').send({ fitNotes: FIT_NOTES });

    expect(logText()).not.toContain(FIT_NOTES);
    expect(logText()).not.toContain('K-12');
    expect(logger.info).toHaveBeenCalled();
  });
});

describe('GET /api/queue', () => {
  it('returns an empty queue when the job has never run', async () => {
    answers.campaigns = { single: { data: null, error: null } };

    const response = await authed('get', '/api/queue');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ campaignId: null, leads: [] });
  });

  it('scopes to the owner and to leads awaiting review', async () => {
    answers.campaigns = { single: { data: { id: 'camp-daily' }, error: null } };
    answers.leads = { list: { data: [{ id: 'lead-1', status: 'generated' }], error: null } };

    const response = await authed('get', '/api/queue');

    expect(response.status).toBe(200);
    const read = queries.find((q) => q.table === 'leads');
    expect(read.filters.user_id).toBe(OWNER);
    expect(read.filters.campaign_id).toBe('camp-daily');
    // 'approved' as well as 'generated': a letter whose send failed after approval
    // must not vanish from the only screen that could retry it.
    expect(read.filters.status).toEqual(['generated', 'approved']);
  });

  it('returns no letter bodies in the list', async () => {
    answers.campaigns = { single: { data: { id: 'camp-daily' }, error: null } };
    answers.leads = {
      list: { data: [{ id: 'lead-1', email: 'p@x.com', status: 'generated' }], error: null }
    };

    const response = await authed('get', '/api/queue');

    const [lead] = response.body.leads;
    expect(lead).not.toHaveProperty('generated_body');
    expect(lead).not.toHaveProperty('edited_body');
  });
});

describe('POST /api/leads/:id/reject', () => {
  beforeEach(() => {
    answers.leads = { single: { data: { id: 'lead-1', status: 'generated' }, error: null } };
  });

  it('records the rejection and marks the lead rejected, not failed', async () => {
    const response = await authed('post', '/api/leads/lead-1/reject').send({
      reason: 'wrong_role'
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id: 'lead-1', status: 'rejected' });

    const rejection = queries.find((q) => q.table === 'lead_rejections');
    expect(rejection.values).toMatchObject({ user_id: OWNER, lead_id: 'lead-1', reason: 'wrong_role' });

    const update = queries.find((q) => q.table === 'leads' && q.op === 'update');
    // NOT 'failed': that is in leadRegenerate's REDRAFTABLE_FROM, and a letter a
    // human declined must never become eligible for redrafting.
    expect(update.values).toEqual({ status: 'rejected' });
    expect(update.filters.user_id).toBe(OWNER);
  });

  it('refuses a reason outside the closed set', async () => {
    const response = await authed('post', '/api/leads/lead-1/reject').send({
      reason: 'i just did not like it'
    });

    expect(response.status).toBe(400);
    expect(queries).toHaveLength(0);
  });

  it('refuses a missing reason — a rejection with no signal is not worth storing', async () => {
    const response = await authed('post', '/api/leads/lead-1/reject').send({});

    expect(response.status).toBe(400);
  });

  it('answers 404 for another user’s lead, never 403', async () => {
    answers.leads = { single: { data: null, error: null } };

    const response = await authed('post', '/api/leads/lead-other/reject').send({
      reason: 'wrong_role'
    });

    // 403 would confirm the id exists.
    expect(response.status).toBe(404);
    expect(queries.some((q) => q.table === 'lead_rejections')).toBe(false);
  });

  it('never logs the note', async () => {
    const note = 'They already buy from our competitor Acme.';

    await authed('post', '/api/leads/lead-1/reject').send({ reason: 'other', note });

    expect(logText()).not.toContain(note);
    expect(logText()).not.toContain('Acme');
    expect(logger.info).toHaveBeenCalled();
  });
});
