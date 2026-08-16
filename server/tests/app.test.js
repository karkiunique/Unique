import { describe, it, expect, vi, beforeEach } from 'vitest';

import { useSharedTestServer, withFreshServer } from './helpers/testServer.js';

const { getUser, supabaseFrom } = vi.hoisted(() => ({ getUser: vi.fn(), supabaseFrom: vi.fn() }));

// No real network in tests: Supabase is fully mocked.
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

// The profiles row behind GET /api/me's sign-off name. This suite is about the
// app's wiring, so the row is simply absent — meRoutes.test.js owns that contract.
function emptyProfilesTable() {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: null, error: null })
  };

  return chain;
}

// One server for the whole file: 13 of the 14 requests below go through it, well
// inside the app's 100-per-60s rate limit. The exception is the APP_URL CORS test,
// which has to build its own app — see the comment there.
const httpRequest = useSharedTestServer(createApp);

beforeEach(() => {
  getUser.mockReset();
  supabaseFrom.mockReset();
  supabaseFrom.mockImplementation(() => ({ select: emptyProfilesTable }));
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
});

describe('GET /api/health', () => {
  it('is public and returns ok', async () => {
    const res = await httpRequest('get', '/api/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('voicereach-server');
    expect(typeof res.body.timestamp).toBe('string');
  });

  it('sets helmet security headers', async () => {
    const res = await httpRequest('get', '/api/health');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('GET /api/me', () => {
  it('401s without a token', async () => {
    const res = await httpRequest('get', '/api/me');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Missing or malformed Authorization header' });
  });

  it('401s with an invalid token', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { message: 'bad jwt' } });

    const res = await httpRequest('get', '/api/me').set('Authorization', 'Bearer nope');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid or expired token' });
  });

  it('returns the authenticated user', async () => {
    getUser.mockResolvedValue({
      data: { user: { id: 'user-abc', email: 'dev@example.com' } },
      error: null
    });

    const res = await httpRequest('get', '/api/me').set('Authorization', 'Bearer good.jwt');

    expect(res.status).toBe(200);
    // full_name is the sign-off name (Decisions, 2026-08-13): null here because
    // this fixture has no profile row, which is what the backfill prompt looks for.
    expect(res.body).toEqual({
      user: { id: 'user-abc', email: 'dev@example.com', full_name: null }
    });
  });
});

describe('POST /api/gmail/connect', () => {
  it('401s without a token', async () => {
    const res = await httpRequest('post', '/api/gmail/connect');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Missing or malformed Authorization header' });
  });
});

describe('GET /api/gmail/callback', () => {
  it('is public but 400s without a code and state', async () => {
    const res = await httpRequest('get', '/api/gmail/callback');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing authorization code or state' });
  });

  it('400s when Google reports an error', async () => {
    const res = await httpRequest('get', '/api/gmail/callback?error=access_denied');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Google denied the authorization request' });
  });
});

describe('voice routes', () => {
  it('401s on POST /api/voice/generate without a token', async () => {
    const res = await httpRequest('post', '/api/voice/generate');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Missing or malformed Authorization header' });
  });

  it('401s on GET /api/voice without a token', async () => {
    const res = await httpRequest('get', '/api/voice');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Missing or malformed Authorization header' });
  });
});

describe('app hardening', () => {
  it('returns JSON {error} for unknown routes', async () => {
    const res = await httpRequest('get', '/api/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it('returns 400 {error} for malformed JSON bodies', async () => {
    const res = await httpRequest('post', '/api/me')
      .set('Content-Type', 'application/json')
      .send('{"broken":');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid JSON body' });
  });

  it('does not send CORS headers to a disallowed origin', async () => {
    const res = await httpRequest('get', '/api/health').set('Origin', 'https://evil.example.com');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  /**
   * The only test here that must build its own app: CORS reads APP_URL once, at
   * app-construction time. Routed through the shared server it would prove nothing
   * — that app was built before this test set the variable. `withFreshServer` still
   * constructs it after the assignment below, on a single port it always closes.
   *
   * The origin below MUST stay a non-default value. app.js falls back to
   * DEFAULT_APP_URL ('http://localhost:5173') when APP_URL is unset, and APP_URL is
   * unset under vitest — so asserting the default would pass even if the assignment
   * below were deleted or the app were built before it. Only an origin the fallback
   * cannot produce proves APP_URL was actually read, at the right moment.
   */
  it('allows the configured APP_URL origin', async () => {
    const configuredOrigin = 'https://app.example.com';
    const previous = process.env.APP_URL;
    process.env.APP_URL = configuredOrigin;

    try {
      await withFreshServer(createApp, async (send) => {
        const res = await send('get', '/api/health').set('Origin', configuredOrigin);

        expect(res.headers['access-control-allow-origin']).toBe(configuredOrigin);
      });
    } finally {
      process.env.APP_URL = previous;
    }
  });
});
