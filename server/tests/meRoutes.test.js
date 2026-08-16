import { describe, it, expect, vi, beforeEach } from 'vitest';

import { useSharedTestServer } from './helpers/testServer.js';

/**
 * GET and PATCH /api/me — the sign-off name (Decisions, 2026-08-13).
 *
 * The service is NOT mocked here: the point of this file is the route's contract
 * end to end — who it lets in, whose row it writes, what it refuses, and what it
 * is allowed to say about any of it.
 *
 * OWNER SCOPING: the owner is the verified JWT's user id and nothing else. The
 * body is attacker-controlled, so a `user_id` in it must never reach a query.
 *
 * PRIVACY: `full_name` is PII. It goes back to its owner and nowhere else, and it
 * never reaches a log line.
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
const STRANGER = 'user-stranger';
const EMAIL = 'dev@example.com';
const NAME = 'Unique Karki';
const TOKEN = 'Bearer good.jwt';

let queries = [];
let answer = { data: null, error: null };

function builderFor(table, op, values) {
  const query = { table, op, values, filters: {} };
  queries.push(query);

  const chain = {
    select: () => chain,
    eq(column, value) {
      query.filters[column] = value;
      return chain;
    },
    maybeSingle: async () => answer
  };

  return chain;
}

function logLines() {
  return [...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls];
}

// One server for the whole file: 16 requests, well inside the app's 100-per-60s
// rate limit. See helpers/testServer.js for why per-request binds were a problem.
const httpRequest = useSharedTestServer(createApp);

function authed(method, path) {
  return httpRequest(method, path).set('Authorization', TOKEN);
}

beforeEach(() => {
  queries = [];
  answer = { data: { full_name: NAME }, error: null };

  getUser.mockReset();
  getUser.mockResolvedValue({ data: { user: { id: OWNER, email: EMAIL } }, error: null });

  supabaseFrom.mockReset();
  supabaseFrom.mockImplementation((table) => ({
    select: () => builderFor(table, 'select', null),
    update: (values) => builderFor(table, 'update', values)
  }));

  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
});

describe('GET /api/me', () => {
  it('returns the signed-in user with their sign-off name', async () => {
    const res = await authed('get', '/api/me');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user: { id: OWNER, email: EMAIL, full_name: NAME } });
    // Read from the caller's own row, by the id on their token.
    expect(queries[0].table).toBe('profiles');
    expect(queries[0].filters).toEqual({ id: OWNER });
  });

  /** What the backfill prompt keys off: a pre-006 account answers null, not an error. */
  it('answers null for an account that has no name yet', async () => {
    answer = { data: null, error: null };

    const res = await authed('get', '/api/me');

    expect(res.status).toBe(200);
    expect(res.body.user.full_name).toBeNull();
  });

  it('still answers when the name lookup fails, rather than 500ing the page', async () => {
    answer = { data: null, error: { message: 'connection reset' } };

    const res = await authed('get', '/api/me');

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(OWNER);
    expect(res.body.user.full_name).toBeNull();
  });

  it('401s without a token', async () => {
    const res = await httpRequest('get', '/api/me');

    expect(res.status).toBe(401);
    expect(queries).toHaveLength(0);
  });
});

describe('PATCH /api/me', () => {
  it('saves the name on the caller\'s own row', async () => {
    const res = await authed('patch', '/api/me').send({ full_name: NAME });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user: { id: OWNER, full_name: NAME } });

    const [write] = queries;
    expect(write.op).toBe('update');
    expect(write.table).toBe('profiles');
    expect(write.values).toEqual({ full_name: NAME });
    expect(write.filters).toEqual({ id: OWNER });
  });

  /**
   * The body is attacker-controlled. A user_id in it must be ignored outright —
   * not merely overridden later, where a future refactor could reorder it back.
   */
  it('ignores any owner named in the body and writes the token\'s user', async () => {
    const res = await authed('patch', '/api/me').send({
      id: STRANGER,
      user_id: STRANGER,
      full_name: NAME
    });

    expect(res.status).toBe(200);
    expect(queries[0].filters).toEqual({ id: OWNER });
    expect(JSON.stringify(queries[0].filters)).not.toContain(STRANGER);
    expect(res.body.user.id).toBe(OWNER);
  });

  it('401s without a token, and writes nothing', async () => {
    const res = await httpRequest('patch', '/api/me').send({ full_name: NAME });

    expect(res.status).toBe(401);
    expect(queries).toHaveLength(0);
  });

  it('400s a blank name and writes nothing', async () => {
    for (const full_name of [undefined, '', '   ', null, 42]) {
      queries = [];

      const res = await authed('patch', '/api/me').send({ full_name });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/name/i);
      expect(queries).toHaveLength(0);
    }
  });

  it('400s a name past the length cap', async () => {
    const res = await authed('patch', '/api/me').send({ full_name: 'a'.repeat(500) });

    expect(res.status).toBe(400);
    expect(queries).toHaveLength(0);
  });

  it('404s when the profile row is missing', async () => {
    answer = { data: null, error: null };

    const res = await authed('patch', '/api/me').send({ full_name: NAME });

    expect(res.status).toBe(404);
  });

  it('never logs the name, on the happy path or the failure path', async () => {
    await authed('patch', '/api/me').send({ full_name: NAME });

    answer = { data: null, error: { message: `could not write ${NAME}` } };
    const failed = await authed('patch', '/api/me').send({ full_name: NAME });

    expect(failed.status).toBe(500);
    // A 5xx from the driver never echoes its message either.
    expect(failed.body.error).not.toContain(NAME);

    for (const line of logLines()) {
      const serialized = JSON.stringify(line);
      expect(serialized).not.toContain(NAME);
      expect(serialized).not.toContain('Unique');
      expect(serialized).not.toContain(EMAIL);
    }
    expect(logger.error).toHaveBeenCalledWith('sender_name_update_failed', {
      userId: OWNER,
      status: 500,
      name: 'Error'
    });
  });
});
