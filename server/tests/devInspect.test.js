import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { useSharedTestServer, withFreshServer } from './helpers/testServer.js';

const { oauthClient, gmailApi, OAuth2, gmailFactory } = vi.hoisted(() => {
  const oauthClient = {
    generateAuthUrl: vi.fn(),
    getToken: vi.fn(),
    setCredentials: vi.fn()
  };
  const gmailApi = { users: { messages: { list: vi.fn(), get: vi.fn() } } };

  return {
    oauthClient,
    gmailApi,
    // `new google.auth.OAuth2(...)` — the impl must be constructible, so no arrow.
    OAuth2: vi.fn(function OAuth2Mock() {
      return oauthClient;
    }),
    gmailFactory: vi.fn(() => gmailApi)
  };
});

const { getUser, supabaseFrom } = vi.hoisted(() => ({
  getUser: vi.fn(),
  supabaseFrom: vi.fn()
}));

// No real Google calls in tests.
vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2 },
    gmail: gmailFactory
  }
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
const { encrypt } = await import('../src/lib/crypto.js');
const { logger } = await import('../src/lib/logger.js');

const KEY = Buffer.alloc(32, 5).toString('base64');
const ENV_KEYS = [
  'NODE_ENV',
  'ENABLE_DEV_ROUTES',
  'TOKEN_ENC_KEY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI'
];
const envBackup = {};

// Quoted reply + signature: everything below "following up on the deck" is junk.
const QUOTED_RAW = [
  'hey Sam',
  '',
  'following up on the deck',
  '',
  '--',
  'Ana Silva',
  'https://acme.com',
  '',
  'On Mon, 3 Feb 2025 at 09:12, Sam Rivera <sam@acme.com> wrote:',
  '> the original question'
].join('\n');
const QUOTED_CLEANED = 'hey Sam\n\nfollowing up on the deck';

// Nothing to strip.
const PLAIN_RAW = 'quick note on the roadmap for next quarter';

// A sender that put tag markup inside a text/plain part.
const HTML_RAW = '<div>hey Sam</div>\n<p>numbers looked good this quarter</p>';

const RAW_BY_ID = { 'm-1': QUOTED_RAW, 'm-2': PLAIN_RAW, 'm-3': HTML_RAW };

const AUTH_HEADER = ['Authorization', 'Bearer good.jwt'];

function b64url(text) {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function messageFixture(text) {
  return { data: { payload: { mimeType: 'text/plain', body: { data: b64url(text) } } } };
}

/** Supabase chain used by getAuthedClient: from().select().eq().maybeSingle() */
function mockProfileRead(result) {
  supabaseFrom.mockReturnValue({
    select: () => ({ eq: () => ({ maybeSingle: async () => result }) })
  });
}

function mockConnectedGmail() {
  mockProfileRead({ data: { gmail_refresh_token_enc: encrypt('rt-xyz') }, error: null });
  gmailApi.users.messages.list.mockResolvedValue({
    data: { messages: [{ id: 'm-1' }, { id: 'm-2' }, { id: 'm-3' }] }
  });
  gmailApi.users.messages.get.mockImplementation(async ({ id }) =>
    messageFixture(RAW_BY_ID[id] ?? '')
  );
}

function enableDevRoutes() {
  process.env.NODE_ENV = 'test';
  process.env.ENABLE_DEV_ROUTES = 'true';
}

/**
 * app.js decides whether to MOUNT the dev router at construction time, so a shared
 * server has to be built with the gate already on. The two variables are restored
 * straight afterwards: what each request is gated by is the env each test sets in
 * its own beforeEach, which the router re-checks on every call.
 *
 * The gating describe below does NOT use this — those tests are about the
 * mount-time decision itself and must keep building their own app per test.
 */
function appWithDevRoutesMounted() {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    ENABLE_DEV_ROUTES: process.env.ENABLE_DEV_ROUTES
  };

  enableDevRoutes();
  try {
    return createApp();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// Shared by the two describes that exercise the route rather than the gate: 10
// requests, well inside the app's 100-per-60s rate limit.
const httpRequest = useSharedTestServer(appWithDevRoutesMounted);

function authed(method, path) {
  return httpRequest(method, path).set(...AUTH_HEADER);
}

beforeEach(() => {
  for (const key of ENV_KEYS) envBackup[key] = process.env[key];

  process.env.NODE_ENV = 'test';
  delete process.env.ENABLE_DEV_ROUTES;
  process.env.TOKEN_ENC_KEY = KEY;
  process.env.GOOGLE_CLIENT_ID = 'client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
  process.env.GOOGLE_REDIRECT_URI = 'http://localhost:3000/api/gmail/callback';

  getUser.mockReset();
  supabaseFrom.mockReset();
  gmailApi.users.messages.list.mockReset();
  gmailApi.users.messages.get.mockReset();
  // restoreMocks:true wipes implementations between tests — re-arm the constructors.
  OAuth2.mockReset();
  OAuth2.mockImplementation(function OAuth2Mock() {
    return oauthClient;
  });
  gmailFactory.mockReset();
  gmailFactory.mockImplementation(() => gmailApi);
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();

  getUser.mockResolvedValue({
    data: { user: { id: 'user-abc', email: 'dev@example.com' } },
    error: null
  });
});

afterEach(() => {
  // No test may leak NODE_ENV / ENABLE_DEV_ROUTES into another.
  for (const key of ENV_KEYS) {
    if (envBackup[key] === undefined) delete process.env[key];
    else process.env[key] = envBackup[key];
  }
});

/**
 * The only describe here that still builds its own app, deliberately. Each test sets
 * NODE_ENV / ENABLE_DEV_ROUTES and then asserts what app.js DID WITH THEM at
 * construction. Routed through the shared server these would assert the router's
 * per-request re-check instead, and the mount-time gate would stop being tested.
 *
 * `withFreshServer` builds the app after the env is set — same construction-time
 * semantics as before — but binds one port per test instead of one per request.
 */
describe('GET /api/dev/ingest-preview — gating', () => {
  it('404s when ENABLE_DEV_ROUTES is unset', async () => {
    await withFreshServer(createApp, async (send) => {
      const res = await send('get', '/api/dev/ingest-preview').set(...AUTH_HEADER);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not found' });
      // Do not delete: the header is the ONLY discriminator between the two 404s.
      // Both bodies are byte-identical, so status+body alone cannot tell "app.js
      // never mounted the router" from "it mounted and the per-request re-check
      // 404'd". devInspect.js sets Cache-Control: no-store at line 81, BEFORE its
      // gate at line 85 — so a no-store here means the router was reached, i.e.
      // mounted. Absent header = never mounted, which is what this test guards.
      expect(res.headers['cache-control']).toBeUndefined();
    });
  });

  it('404s in production even when ENABLE_DEV_ROUTES is true', async () => {
    process.env.NODE_ENV = 'production';
    process.env.ENABLE_DEV_ROUTES = 'true';
    mockConnectedGmail();

    await withFreshServer(createApp, async (send) => {
      const res = await send('get', '/api/dev/ingest-preview').set(...AUTH_HEADER);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not found' });
      expect(res.body.emails).toBeUndefined();
      // As above: no Cache-Control proves the router was never mounted in
      // production, not merely that its re-check refused the request.
      expect(res.headers['cache-control']).toBeUndefined();
      expect(gmailApi.users.messages.list).not.toHaveBeenCalled();
    });
  });

  for (const value of ['false', '0', '1', 'TRUE', 'yes', '']) {
    it(`404s for ENABLE_DEV_ROUTES='${value}' (exact 'true' match only)`, async () => {
      process.env.ENABLE_DEV_ROUTES = value;

      await withFreshServer(createApp, async (send) => {
        const res = await send('get', '/api/dev/ingest-preview').set(...AUTH_HEADER);

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'Not found' });
      });
    });
  }

  it('401s without a token when enabled', async () => {
    enableDevRoutes();

    await withFreshServer(createApp, async (send) => {
      const res = await send('get', '/api/dev/ingest-preview');

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Missing or malformed Authorization header' });
    });
  });
});

describe('GET /api/dev/ingest-preview — corpus', () => {
  beforeEach(() => {
    enableDevRoutes();
    mockConnectedGmail();
  });

  it('returns the summary counts for the corpus the voice builder would receive', async () => {
    const res = await authed('get', '/api/dev/ingest-preview');

    expect(res.status).toBe(200);
    expect(res.body.emails).toHaveLength(3);
    expect(res.body.summary.messageCount).toBe(3);
    expect(res.body.summary.cappedAt).toBe(100);
    expect(res.body.summary.overCharBudget).toBe(false);
    expect(res.body.summary.totalCleanedChars).toBe(
      res.body.emails.reduce((total, email) => total + email.cleanedChars, 0)
    );
  });

  it('flags the quoted reply and signature it stripped', async () => {
    const res = await authed('get', '/api/dev/ingest-preview');
    const email = res.body.emails[0];

    expect(email.index).toBe(0);
    expect(email.cleaned).toBe(QUOTED_CLEANED);
    expect(email.removed).toEqual({ quotedReply: true, signature: true, html: false });
    expect(email.rawChars).toBe(QUOTED_RAW.length);
    expect(email.cleanedChars).toBe(QUOTED_CLEANED.length);
    expect(email.strippedChars).toBe(QUOTED_RAW.length - QUOTED_CLEANED.length);
    // The whole point of the route: none of the other party's text survives.
    expect(email.cleaned).not.toContain('the original question');
    expect(email.cleaned).not.toContain('Ana Silva');
    expect(email.cleaned).not.toContain('acme.com');
  });

  it('flags nothing removed for a clean body', async () => {
    const res = await authed('get', '/api/dev/ingest-preview');
    const email = res.body.emails[1];

    expect(email.cleaned).toBe(PLAIN_RAW);
    expect(email.removed).toEqual({ quotedReply: false, signature: false, html: false });
    expect(email.strippedChars).toBe(0);
  });

  it('flags html markup that survived into the extracted text', async () => {
    const res = await authed('get', '/api/dev/ingest-preview');
    const email = res.body.emails[2];

    expect(email.removed.html).toBe(true);
    expect(email.removed.quotedReply).toBe(false);
    expect(email.removed.signature).toBe(false);
  });

  it('omits raw by default and includes it with ?includeRaw=1', async () => {
    const withoutRaw = await authed('get', '/api/dev/ingest-preview');

    for (const email of withoutRaw.body.emails) {
      expect(email.raw).toBeUndefined();
    }

    const withRaw = await authed('get', '/api/dev/ingest-preview?includeRaw=1');

    expect(withRaw.status).toBe(200);
    expect(withRaw.body.emails[0].raw).toBe(QUOTED_RAW);
    expect(withRaw.body.emails[0].raw).toContain('On Mon, 3 Feb 2025');
  });

  it('sets Cache-Control: no-store so the corpus is never cached', async () => {
    const res = await authed('get', '/api/dev/ingest-preview');

    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('logs counts only, never bodies', async () => {
    await authed('get', '/api/dev/ingest-preview?includeRaw=1');

    const calls = [
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls
    ];

    for (const call of calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain('following up on the deck');
      expect(serialized).not.toContain('the original question');
      expect(serialized).not.toContain('quick note on the roadmap');
      expect(serialized).not.toContain('numbers looked good');
    }

    expect(logger.info).toHaveBeenCalledWith('dev_ingest_preview', {
      userId: 'user-abc',
      count: 3
    });
  });
});

describe('GET /api/dev/ingest-preview — failures', () => {
  beforeEach(() => {
    enableDevRoutes();
  });

  it('400s with {error} when Gmail is not connected', async () => {
    mockProfileRead({ data: { gmail_refresh_token_enc: null }, error: null });

    const res = await authed('get', '/api/dev/ingest-preview');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Gmail is not connected' });
  });

  it('500s with a generic {error} when the profile read fails', async () => {
    mockProfileRead({ data: null, error: { message: 'db down' } });

    const res = await authed('get', '/api/dev/ingest-preview');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Could not load the ingestion preview' });
  });
});
