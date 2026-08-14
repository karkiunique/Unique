import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { useSharedTestServer } from './helpers/testServer.js';

/**
 * The three outcomes of POST /api/unsubscribe/:token — 'unsubscribed',
 * 'already', and a 400 — because the public page renders differently for each
 * and must never present "already removed" as a failure.
 *
 * Backed by an in-memory table so idempotency is a real assertion (no duplicate
 * row) rather than a mocked call count.
 */

// This suite exercises no Gmail call; the mock only keeps the real SDK out of the graph.
const { OAuth2, gmailFactory } = vi.hoisted(() => {
  const oauthClient = {
    generateAuthUrl: vi.fn(),
    getToken: vi.fn(),
    setCredentials: vi.fn()
  };
  const gmailApi = {
    users: {
      getProfile: vi.fn(),
      messages: { list: vi.fn(), get: vi.fn(), send: vi.fn() },
      threads: { list: vi.fn(), get: vi.fn() }
    }
  };

  return {
    // `new google.auth.OAuth2(...)` — the impl must be constructible, so no arrow.
    OAuth2: vi.fn(function OAuth2Mock() {
      return oauthClient;
    }),
    gmailFactory: vi.fn(() => gmailApi)
  };
});

const { rows, supabaseFrom } = vi.hoisted(() => ({ rows: [], supabaseFrom: vi.fn() }));

vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2 },
    gmail: gmailFactory
  }
}));

vi.mock('../src/lib/supabase.js', () => ({
  getSupabaseAdmin: () => ({ auth: { getUser: vi.fn() }, from: supabaseFrom }),
  resetSupabaseAdmin: () => {}
}));

vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  sanitizeMeta: (meta) => meta
}));

const { createApp } = await import('../src/app.js');
const { signToken } = await import('../src/lib/unsubscribe.js');
const { logger } = await import('../src/lib/logger.js');

const SECRET = 'unsub-secret-for-tests';
const USER_ID = 'user-abc';
const RECIPIENT = 'sam@corp.com';

let envBackup;

/** A minimal stand-in for the `unsubscribes` table: select().eq().eq().maybeSingle() + upsert(). */
function unsubscribesTable() {
  return {
    select() {
      const filters = {};
      const builder = {
        eq(column, value) {
          filters[column] = value;
          return builder;
        },
        maybeSingle() {
          const found = rows.find((row) =>
            Object.entries(filters).every(([column, value]) => row[column] === value)
          );
          return Promise.resolve({ data: found ? { id: found.id } : null, error: null });
        }
      };
      return builder;
    },
    upsert(values) {
      const exists = rows.some(
        (row) => row.user_id === values.user_id && row.email === values.email
      );
      if (!exists) rows.push({ id: `row-${rows.length + 1}`, ...values });
      return Promise.resolve({ data: null, error: null });
    }
  };
}

// One server for the whole file: 8 requests, well inside the app's 100-per-60s
// rate limit. The idempotency tests below need two calls against the SAME app,
// which this gives them by construction — see helpers/testServer.js.
const httpRequest = useSharedTestServer(createApp);

beforeEach(() => {
  envBackup = process.env.UNSUB_SECRET;
  process.env.UNSUB_SECRET = SECRET;

  rows.length = 0;
  supabaseFrom.mockReset();
  supabaseFrom.mockImplementation(() => unsubscribesTable());
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
});

afterEach(() => {
  if (envBackup === undefined) delete process.env.UNSUB_SECRET;
  else process.env.UNSUB_SECRET = envBackup;
});

describe('POST /api/unsubscribe/:token — outcome status', () => {
  it("returns status 'unsubscribed' on the first call", async () => {
    const token = signToken({ u: USER_ID, e: RECIPIENT });

    const res = await httpRequest('post', `/api/unsubscribe/${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'unsubscribed' });
    expect(rows).toHaveLength(1);
  });

  it("returns status 'already' on a second call and creates no duplicate row", async () => {
    const token = signToken({ u: USER_ID, e: RECIPIENT });

    const first = await httpRequest('post', `/api/unsubscribe/${token}`);
    const second = await httpRequest('post', `/api/unsubscribe/${token}`);

    expect(first.body).toEqual({ status: 'unsubscribed' });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ status: 'already' });
    expect(rows).toHaveLength(1);
  });

  it('treats the same address in different case as already unsubscribed', async () => {
    await httpRequest('post', `/api/unsubscribe/${signToken({ u: USER_ID, e: RECIPIENT })}`);
    const res = await httpRequest(
      'post',
      `/api/unsubscribe/${signToken({ u: USER_ID, e: 'Sam@Corp.com' })}`
    );

    expect(res.body).toEqual({ status: 'already' });
    expect(rows).toHaveLength(1);
  });

  it('400s on an invalid token and writes nothing', async () => {
    const res = await httpRequest('post', '/api/unsubscribe/not-a-real-token');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
    expect(rows).toHaveLength(0);
  });

  it('never logs the recipient address, on either outcome', async () => {
    const token = signToken({ u: USER_ID, e: RECIPIENT });

    await httpRequest('post', `/api/unsubscribe/${token}`);
    await httpRequest('post', `/api/unsubscribe/${token}`);

    const calls = [
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls
    ];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(JSON.stringify(call)).not.toContain(RECIPIENT);
      expect(JSON.stringify(call)).not.toContain('corp.com');
    }
  });
});
