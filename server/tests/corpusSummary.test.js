import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { useSharedTestServer } from './helpers/testServer.js';

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

const PATH = '/api/voice/corpus-summary';
const AUTH_HEADER = ['Authorization', 'Bearer good.jwt'];

const KEY = Buffer.alloc(32, 7).toString('base64');
const ENV_KEYS = [
  'NODE_ENV',
  'ENABLE_DEV_ROUTES',
  'TOKEN_ENC_KEY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI'
];
const envBackup = {};

// Quoted reply + signature: the cleaner has plenty to remove. Not suspect.
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

// Nothing stripped at all — suspect under the "no quoted reply removed" rule.
const PLAIN_RAW = 'quick note on the roadmap for next quarter';

// Tag markup that survived into the extracted text — suspect twice over.
const HTML_RAW = '<div>hey Sam</div>\n<p>numbers looked good this quarter</p>';

// Empty after extraction: never reaches the voice builder, so it is not counted.
const RAW_BY_ID = { 'm-1': QUOTED_RAW, 'm-2': PLAIN_RAW, 'm-3': HTML_RAW, 'm-4': '' };

// Every fragment of message content that must never appear in a response or a log.
const CONTENT_FRAGMENTS = [
  'hey Sam',
  'following up on the deck',
  'the original question',
  'quick note on the roadmap',
  'numbers looked good',
  'Ana Silva',
  'acme.com',
  'sam@acme.com',
  'Sam Rivera'
];

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
    data: { messages: [{ id: 'm-1' }, { id: 'm-2' }, { id: 'm-3' }, { id: 'm-4' }] }
  });
  gmailApi.users.messages.get.mockImplementation(async ({ id }) =>
    messageFixture(RAW_BY_ID[id] ?? '')
  );
}

// One server for the whole file: 10 requests, well inside the app's 100-per-60s
// rate limit. See helpers/testServer.js for why per-request binds were a problem.
const httpRequest = useSharedTestServer(createApp);

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
  for (const key of ENV_KEYS) {
    if (envBackup[key] === undefined) delete process.env[key];
    else process.env[key] = envBackup[key];
  }
});

describe('GET /api/voice/corpus-summary — auth', () => {
  it('401s without an Authorization header, and never touches Gmail', async () => {
    mockConnectedGmail();

    const res = await httpRequest('get', PATH);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Missing or malformed Authorization header' });
    expect(gmailApi.users.messages.list).not.toHaveBeenCalled();
  });

  it('401s when the token does not resolve to a user', async () => {
    mockConnectedGmail();
    getUser.mockResolvedValue({ data: { user: null }, error: { message: 'bad jwt' } });

    const res = await authed('get', PATH);

    expect(res.status).toBe(401);
    expect(gmailApi.users.messages.list).not.toHaveBeenCalled();
  });
});

describe('GET /api/voice/corpus-summary — counts only', () => {
  beforeEach(() => {
    mockConnectedGmail();
  });

  it('returns exactly the five counts and nothing else', async () => {
    const res = await authed('get', PATH);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([
      'cappedAt',
      'messageCount',
      'overCharBudget',
      'suspectCount',
      'totalCleanedChars'
    ]);
    expect(res.body.emails).toBeUndefined();
  });

  it('counts the corpus the voice builder would receive, skipping empty bodies', async () => {
    const res = await authed('get', PATH);

    // m-4 extracts to nothing, so it is not part of the corpus.
    expect(res.body.messageCount).toBe(3);
    expect(res.body.totalCleanedChars).toBe(
      QUOTED_CLEANED.length + PLAIN_RAW.length + HTML_RAW.length
    );
    expect(res.body.overCharBudget).toBe(false);
    expect(res.body.cappedAt).toBe(100);
  });

  it('flags the same rows the review UI would flag', async () => {
    const res = await authed('get', PATH);

    // The quoted one cleaned up properly; the plain and the HTML one did not.
    expect(res.body.suspectCount).toBe(2);
  });

  it('returns no body, subject or recipient text at any level', async () => {
    const res = await authed('get', PATH);

    const serialized = JSON.stringify(res.body);
    for (const fragment of CONTENT_FRAGMENTS) {
      expect(serialized).not.toContain(fragment);
    }
    // Every value is a number or a boolean — there is no string to leak through.
    for (const value of Object.values(res.body)) {
      expect(['number', 'boolean']).toContain(typeof value);
    }
  });

  it('sets Cache-Control: no-store', async () => {
    const res = await authed('get', PATH);

    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('logs counts only, never content', async () => {
    await authed('get', PATH);

    const calls = [
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls
    ];

    for (const call of calls) {
      const serialized = JSON.stringify(call);
      for (const fragment of CONTENT_FRAGMENTS) {
        expect(serialized).not.toContain(fragment);
      }
    }

    expect(logger.info).toHaveBeenCalledWith('voice_corpus_summarized', {
      userId: 'user-abc',
      count: 3
    });
  });
});

describe('GET /api/voice/corpus-summary — failures', () => {
  it('400s with {error} when Gmail is not connected', async () => {
    mockProfileRead({ data: { gmail_refresh_token_enc: null }, error: null });

    const res = await authed('get', PATH);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Gmail is not connected' });
  });

  it('500s with a generic {error} when the profile read fails', async () => {
    mockProfileRead({ data: null, error: { message: 'db down' } });

    const res = await authed('get', PATH);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Could not read your sent mail' });
  });
});
