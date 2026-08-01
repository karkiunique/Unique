import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

const { supabaseFrom } = vi.hoisted(() => ({ supabaseFrom: vi.fn() }));

// No real Google calls in tests.
vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2 },
    gmail: gmailFactory
  }
}));

vi.mock('../src/lib/supabase.js', () => ({
  getSupabaseAdmin: () => ({ from: supabaseFrom }),
  resetSupabaseAdmin: () => {}
}));

vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  sanitizeMeta: (meta) => meta
}));

const {
  buildAuthUrl,
  handleCallback,
  getAuthedClient,
  fetchSentEmails,
  decodeOAuthState,
  encodeOAuthState,
  extractPlainTextBody,
  stripQuotedReplies,
  stripSignature,
  cleanEmailBody,
  GMAIL_SCOPES
} = await import('../src/services/gmail.js');
const { encrypt } = await import('../src/lib/crypto.js');
const { logger } = await import('../src/lib/logger.js');

const KEY = Buffer.alloc(32, 5).toString('base64');
const envBackup = {};

function b64url(text) {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function messageFixture(text) {
  return {
    data: {
      payload: { mimeType: 'text/plain', body: { data: b64url(text) } }
    }
  };
}

/** Supabase chain used by getAuthedClient: from().select().eq().maybeSingle() */
function mockProfileRead(result) {
  supabaseFrom.mockReturnValue({
    select: () => ({ eq: () => ({ maybeSingle: async () => result }) })
  });
}

/** Supabase chain used by handleCallback: from().update().eq().select() */
function mockProfileUpdate(result) {
  const capture = {};
  supabaseFrom.mockReturnValue({
    update: (payload) => {
      capture.payload = payload;
      return {
        eq: (column, value) => {
          capture.eq = [column, value];
          return { select: async () => result };
        }
      };
    }
  });
  return capture;
}

beforeEach(() => {
  for (const key of [
    'TOKEN_ENC_KEY',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_REDIRECT_URI'
  ]) {
    envBackup[key] = process.env[key];
  }

  process.env.TOKEN_ENC_KEY = KEY;
  process.env.GOOGLE_CLIENT_ID = 'client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
  process.env.GOOGLE_REDIRECT_URI = 'http://localhost:3000/api/gmail/callback';

  oauthClient.generateAuthUrl.mockReset();
  oauthClient.getToken.mockReset();
  oauthClient.setCredentials.mockReset();
  gmailApi.users.messages.list.mockReset();
  gmailApi.users.messages.get.mockReset();
  supabaseFrom.mockReset();
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

  oauthClient.generateAuthUrl.mockImplementation((opts) => {
    const params = new URLSearchParams({
      access_type: String(opts.access_type),
      prompt: String(opts.prompt),
      scope: (opts.scope || []).join(' '),
      state: String(opts.state)
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  });
});

afterEach(() => {
  for (const [key, value] of Object.entries(envBackup)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('extractPlainTextBody', () => {
  it('finds text/plain inside nested multipart parts', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'application/pdf', filename: 'deck.pdf', body: { data: b64url('binary') } },
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: b64url('the real body') } },
            { mimeType: 'text/html', body: { data: b64url('<p>the html body</p>') } }
          ]
        }
      ]
    };

    expect(extractPlainTextBody(payload)).toBe('the real body');
  });

  it('falls back to stripped html when there is no text/plain part', () => {
    const payload = {
      mimeType: 'multipart/alternative',
      parts: [{ mimeType: 'text/html', body: { data: b64url('<p>hey Sam</p><p>quick one</p>') } }]
    };

    expect(extractPlainTextBody(payload)).toContain('hey Sam');
    expect(extractPlainTextBody(payload)).not.toContain('<p>');
  });

  it('normalises CRLF line endings', () => {
    const payload = { mimeType: 'text/plain', body: { data: b64url('one\r\ntwo') } };

    expect(extractPlainTextBody(payload)).toBe('one\ntwo');
  });

  it('returns an empty string for a missing or bodyless payload', () => {
    expect(extractPlainTextBody(null)).toBe('');
    expect(extractPlainTextBody({ mimeType: 'multipart/mixed', parts: [] })).toBe('');
  });
});

describe('stripQuotedReplies', () => {
  it("drops lines starting with '>'", () => {
    const text = 'sounds good\n\n> what about tuesday?\n> - Sam';

    expect(stripQuotedReplies(text)).toBe('sounds good');
  });

  it("drops everything from an 'On ... wrote:' line onward", () => {
    const text = [
      'yes, tuesday works',
      '',
      'On Mon, 3 Feb 2025 at 09:12, Sam Rivera <sam@acme.com> wrote:',
      'are you free tuesday?'
    ].join('\n');

    expect(stripQuotedReplies(text)).toBe('yes, tuesday works');
  });

  it("handles a wrapped 'On ... wrote:' header", () => {
    const text = [
      'yes, tuesday works',
      '',
      'On Mon, 3 Feb 2025 at 09:12, Sam Rivera',
      '<sam@acme.com> wrote:',
      'are you free tuesday?'
    ].join('\n');

    expect(stripQuotedReplies(text)).toBe('yes, tuesday works');
  });

  it('drops an -----Original Message----- block', () => {
    const text = 'thanks!\n\n-----Original Message-----\nFrom: Sam';

    expect(stripQuotedReplies(text)).toBe('thanks!');
  });

  it('leaves an unquoted body untouched', () => {
    expect(stripQuotedReplies('just a normal note')).toBe('just a normal note');
  });
});

describe('stripSignature', () => {
  it("drops everything after a '--' delimiter line", () => {
    const text = 'hey Sam\n\nlets talk friday\n\n--\nAna Silva\nHead of Growth\nAcme';

    expect(stripSignature(text)).toBe('hey Sam\n\nlets talk friday');
  });

  it('drops trailing lines that look like a signature (phone / url)', () => {
    const text = 'hey Sam\n\nlets talk friday\n\nAna Silva\n+1 415 555 0132\nhttps://acme.com';

    const result = stripSignature(text);

    expect(result).toBe('hey Sam\n\nlets talk friday\n\nAna Silva');
    expect(result).not.toContain('555');
    expect(result).not.toContain('acme.com');
  });

  it('keeps a body with no signature at all', () => {
    expect(stripSignature('hey Sam\n\nlets talk friday')).toBe('hey Sam\n\nlets talk friday');
  });
});

describe('cleanEmailBody', () => {
  it('strips signature and quoted reply together', () => {
    const raw = [
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
    ].join('\r\n');

    expect(cleanEmailBody(raw)).toBe('hey Sam\n\nfollowing up on the deck');
  });

  it('collapses runs of blank lines', () => {
    expect(cleanEmailBody('one\n\n\n\ntwo')).toBe('one\n\ntwo');
  });

  it('returns an empty string for empty input', () => {
    expect(cleanEmailBody('')).toBe('');
    expect(cleanEmailBody(undefined)).toBe('');
  });
});

describe('buildAuthUrl', () => {
  it('requests gmail.readonly only', () => {
    const url = decodeURIComponent(buildAuthUrl('user-1'));

    expect(url).toContain('https://www.googleapis.com/auth/gmail.readonly');
    expect(url).not.toContain('gmail.send');
    expect(url).not.toContain('gmail.modify');
    // The full-mailbox scope, pinned so nobody ever widens to it.
    expect(url).not.toContain('mail.google.com');
    expect(GMAIL_SCOPES).toHaveLength(1);
    expect(GMAIL_SCOPES).toEqual(['https://www.googleapis.com/auth/gmail.readonly']);
  });

  it('asks for offline access with a forced consent prompt', () => {
    buildAuthUrl('user-1');

    const opts = oauthClient.generateAuthUrl.mock.calls[0][0];
    expect(opts.access_type).toBe('offline');
    expect(opts.prompt).toBe('consent');
  });

  it('carries the user id in an opaque state param', () => {
    buildAuthUrl('user-42');

    const { state } = oauthClient.generateAuthUrl.mock.calls[0][0];
    expect(state).not.toContain('user-42');
    expect(decodeOAuthState(state)).toBe('user-42');
  });

  it('rejects a state that was not issued by us', () => {
    expect(() => decodeOAuthState('not-a-real-state')).toThrow(/state/i);
    expect(() => decodeOAuthState('')).toThrow(/state/i);
  });
});

describe('handleCallback', () => {
  it('stores the refresh token encrypted and marks the profile connected', async () => {
    oauthClient.getToken.mockResolvedValue({ tokens: { refresh_token: 'rt-abc-123' } });
    const capture = mockProfileUpdate({ data: [{ id: 'user-1' }], error: null });

    const result = await handleCallback('auth-code', encodeOAuthState('user-1'));

    expect(result).toEqual({ userId: 'user-1' });
    expect(capture.eq).toEqual(['id', 'user-1']);
    expect(capture.payload.gmail_connected).toBe(true);
    expect(capture.payload.gmail_refresh_token_enc).not.toBe('rt-abc-123');
    expect(capture.payload.gmail_refresh_token_enc).not.toContain('rt-abc-123');
  });

  it('rejects a missing code before calling Google', async () => {
    await expect(handleCallback('', encodeOAuthState('user-1'))).rejects.toThrow(/code/i);
    expect(oauthClient.getToken).not.toHaveBeenCalled();
  });

  it('rejects an invalid state before calling Google', async () => {
    await expect(handleCallback('auth-code', 'tampered')).rejects.toThrow(/state/i);
    expect(oauthClient.getToken).not.toHaveBeenCalled();
  });

  it('rejects when Google returns no refresh token', async () => {
    oauthClient.getToken.mockResolvedValue({ tokens: { access_token: 'at-only' } });

    await expect(handleCallback('auth-code', encodeOAuthState('user-1'))).rejects.toThrow(
      /refresh token/i
    );
  });

  it('never leaks the authorization code when the exchange fails', async () => {
    oauthClient.getToken.mockRejectedValue(new Error('invalid_grant for code auth-code-secret'));

    await expect(handleCallback('auth-code-secret', encodeOAuthState('user-1'))).rejects.toThrow(
      /Could not exchange/i
    );
  });
});

describe('getAuthedClient', () => {
  it('decrypts the stored token in memory and sets it on the client', async () => {
    mockProfileRead({ data: { gmail_refresh_token_enc: encrypt('rt-xyz') }, error: null });

    await getAuthedClient('user-1');

    expect(oauthClient.setCredentials).toHaveBeenCalledWith({ refresh_token: 'rt-xyz' });
  });

  it('rejects when Gmail is not connected', async () => {
    mockProfileRead({ data: { gmail_refresh_token_enc: null }, error: null });

    await expect(getAuthedClient('user-1')).rejects.toThrow(/not connected/i);
  });
});

describe('fetchSentEmails', () => {
  beforeEach(() => {
    mockProfileRead({ data: { gmail_refresh_token_enc: encrypt('rt-xyz') }, error: null });
    gmailApi.users.messages.get.mockImplementation(async () =>
      messageFixture('hey Sam\n\nfollowing up on the deck')
    );
  });

  it('caps at the 100 most recent sent emails', async () => {
    const page = (count, token) => ({
      data: {
        messages: Array.from({ length: count }, (_, i) => ({ id: `m-${token || 'a'}-${i}` })),
        nextPageToken: token
      }
    });
    gmailApi.users.messages.list
      .mockResolvedValueOnce(page(60, 'page-2'))
      .mockResolvedValueOnce(page(60, undefined));

    const bodies = await fetchSentEmails('user-1');

    expect(bodies).toHaveLength(100);
    expect(gmailApi.users.messages.get).toHaveBeenCalledTimes(100);
    expect(gmailApi.users.messages.list).toHaveBeenCalledTimes(2);
    expect(gmailApi.users.messages.list.mock.calls[1][0].maxResults).toBe(40);
  });

  it('uses whatever exists when there are fewer than 100', async () => {
    gmailApi.users.messages.list.mockResolvedValue({
      data: { messages: [{ id: 'm-1' }, { id: 'm-2' }, { id: 'm-3' }] }
    });

    const bodies = await fetchSentEmails('user-1');

    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toBe('hey Sam\n\nfollowing up on the deck');
  });

  it('queries in:sent and returns an empty list when the mailbox is empty', async () => {
    gmailApi.users.messages.list.mockResolvedValue({ data: {} });

    const bodies = await fetchSentEmails('user-1');

    expect(bodies).toEqual([]);
    expect(gmailApi.users.messages.list.mock.calls[0][0].q).toBe('in:sent');
  });

  it('appends an after: filter when one is supplied', async () => {
    gmailApi.users.messages.list.mockResolvedValue({ data: { messages: [{ id: 'm-1' }] } });
    const after = new Date('2025-02-03T00:00:00.000Z');

    await fetchSentEmails('user-1', { after });

    const expected = Math.floor(after.getTime() / 1000);
    expect(gmailApi.users.messages.list.mock.calls[0][0].q).toBe(`in:sent after:${expected}`);
  });

  it('logs counts only, never bodies', async () => {
    gmailApi.users.messages.list.mockResolvedValue({ data: { messages: [{ id: 'm-1' }] } });

    await fetchSentEmails('user-1');

    for (const call of logger.info.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('following up on the deck');
    }
    expect(logger.info).toHaveBeenCalledWith('gmail_sent_fetched', { userId: 'user-1', count: 1 });
  });

  it('drops messages whose cleaned body is empty', async () => {
    gmailApi.users.messages.list.mockResolvedValue({
      data: { messages: [{ id: 'm-1' }, { id: 'm-2' }] }
    });
    gmailApi.users.messages.get
      .mockResolvedValueOnce(messageFixture('  \n  '))
      .mockResolvedValueOnce(messageFixture('a real body worth keeping'));

    const bodies = await fetchSentEmails('user-1');

    expect(bodies).toEqual(['a real body worth keeping']);
  });
});
