import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { oauthClient, gmailApi, OAuth2, gmailFactory } = vi.hoisted(() => {
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
    oauthClient,
    gmailApi,
    // `new google.auth.OAuth2(...)` — the impl must be constructible, so no arrow.
    OAuth2: vi.fn(function OAuth2Mock() {
      return oauthClient;
    }),
    gmailFactory: vi.fn(() => gmailApi)
  };
});

const { supabaseFrom, insert, update, upsert, del } = vi.hoisted(() => ({
  supabaseFrom: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  upsert: vi.fn(),
  del: vi.fn()
}));

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

const { listSentThreads, extractAddress } = await import('../src/services/threads.js');
const { encrypt } = await import('../src/lib/crypto.js');
const { logger } = await import('../src/lib/logger.js');

const KEY = Buffer.alloc(32, 3).toString('base64');
const ENV_KEYS = [
  'TOKEN_ENC_KEY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI'
];
const envBackup = {};

const SELF = 'ana@acme.com';
const RECIPIENT = 'sam@corp.com';
const SUBJECT = 'about the launch';

function message({ from, id = 'm-1', date = 1738560000000, subject = SUBJECT }) {
  return {
    id,
    internalDate: String(date),
    payload: {
      headers: [
        { name: 'From', value: `Ana Silva <${from}>` },
        { name: 'To', value: `Sam Rivera <${RECIPIENT}>` },
        { name: 'Subject', value: subject },
        { name: 'Date', value: new Date(date).toUTCString() }
      ]
    }
  };
}

/** The read chain getAuthedClient needs, plus spies on every write path. */
function mockSupabase() {
  supabaseFrom.mockReturnValue({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({
          data: { gmail_refresh_token_enc: encrypt('rt-xyz') },
          error: null
        })
      })
    }),
    insert,
    update,
    upsert,
    delete: del
  });
}

function mockThreads(threads) {
  gmailApi.users.threads.list.mockResolvedValue({
    data: { threads: threads.map((thread) => ({ id: thread.id })) }
  });
  gmailApi.users.threads.get.mockImplementation(async ({ id }) => ({
    data: threads.find((thread) => thread.id === id) ?? null
  }));
}

beforeEach(() => {
  for (const key of ENV_KEYS) envBackup[key] = process.env[key];

  process.env.TOKEN_ENC_KEY = KEY;
  process.env.GOOGLE_CLIENT_ID = 'client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
  process.env.GOOGLE_REDIRECT_URI = 'http://localhost:3000/api/gmail/callback';

  supabaseFrom.mockReset();
  insert.mockReset();
  update.mockReset();
  upsert.mockReset();
  del.mockReset();
  gmailApi.users.getProfile.mockReset();
  gmailApi.users.threads.list.mockReset();
  gmailApi.users.threads.get.mockReset();
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

  mockSupabase();
  gmailApi.users.getProfile.mockResolvedValue({ data: { emailAddress: SELF } });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (envBackup[key] === undefined) delete process.env[key];
    else process.env[key] = envBackup[key];
  }
});

describe('extractAddress', () => {
  it('pulls the address out of a display-name header', () => {
    expect(extractAddress('Sam Rivera <Sam@Corp.com>')).toBe('sam@corp.com');
    expect(extractAddress('ana@acme.com')).toBe('ana@acme.com');
    expect(extractAddress(undefined)).toBe('');
  });
});

describe('listSentThreads — reply detection', () => {
  it('marks a single-message thread as not replied', async () => {
    mockThreads([{ id: 't-1', messages: [message({ from: SELF })] }]);

    const threads = await listSentThreads('user-1');

    expect(threads).toHaveLength(1);
    expect(threads[0].threadId).toBe('t-1');
    expect(threads[0].subject).toBe(SUBJECT);
    expect(threads[0].to).toBe(RECIPIENT);
    expect(threads[0].replied).toBe(false);
    expect(threads[0].replyCount).toBe(0);
  });

  it('marks a thread replied when a message is NOT from the user', async () => {
    mockThreads([
      {
        id: 't-1',
        messages: [
          message({ from: SELF }),
          message({ from: RECIPIENT, id: 'm-2', date: 1738563600000 })
        ]
      }
    ]);

    const threads = await listSentThreads('user-1');

    expect(threads[0].replied).toBe(true);
    expect(threads[0].replyCount).toBe(1);
  });

  it('does NOT mark a thread replied when every message is from the user', async () => {
    mockThreads([
      {
        id: 't-1',
        messages: [
          message({ from: SELF }),
          message({ from: SELF, id: 'm-2', date: 1738563600000 }),
          message({ from: SELF.toUpperCase(), id: 'm-3', date: 1738567200000 })
        ]
      }
    ]);

    const threads = await listSentThreads('user-1');

    expect(threads[0].replied).toBe(false);
    expect(threads[0].replyCount).toBe(0);
  });

  it('reports the send time of the first message in the thread', async () => {
    mockThreads([
      {
        id: 't-1',
        messages: [
          message({ from: SELF, date: 1738560000000 }),
          message({ from: RECIPIENT, id: 'm-2', date: 1738563600000 })
        ]
      }
    ]);

    const threads = await listSentThreads('user-1');

    expect(threads[0].sentAt).toBe(new Date(1738560000000).toISOString());
  });
});

describe('listSentThreads — access shape', () => {
  it('queries in:sent only and never fetches message bodies', async () => {
    mockThreads([{ id: 't-1', messages: [message({ from: SELF })] }]);

    await listSentThreads('user-1', { limit: 5 });

    expect(gmailApi.users.threads.list).toHaveBeenCalledWith({
      userId: 'me',
      q: 'in:sent',
      maxResults: 5
    });

    const getArgs = gmailApi.users.threads.get.mock.calls[0][0];
    expect(getArgs.format).toBe('metadata');
    expect(getArgs.metadataHeaders).toEqual(['Subject', 'To', 'From', 'Date']);
  });

  it('persists nothing — no insert, update, upsert or delete', async () => {
    mockThreads([
      { id: 't-1', messages: [message({ from: SELF })] },
      {
        id: 't-2',
        messages: [message({ from: SELF, id: 'm-9' }), message({ from: RECIPIENT, id: 'm-10' })]
      }
    ]);

    const threads = await listSentThreads('user-1');

    expect(threads).toHaveLength(2);
    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    // The only table touched is the profile read that decrypts the refresh token.
    expect(supabaseFrom).toHaveBeenCalledTimes(1);
    expect(supabaseFrom).toHaveBeenCalledWith('profiles');
  });

  it('returns an empty list when nothing has been sent', async () => {
    gmailApi.users.threads.list.mockResolvedValue({ data: {} });

    expect(await listSentThreads('user-1')).toEqual([]);
  });

  it('logs counts only, never subjects or recipients', async () => {
    mockThreads([{ id: 't-1', messages: [message({ from: SELF })] }]);

    await listSentThreads('user-1');

    const calls = [
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls
    ];
    for (const call of calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(SUBJECT);
      expect(serialized).not.toContain(RECIPIENT);
    }

    expect(logger.info).toHaveBeenCalledWith('sent_threads_listed', {
      userId: 'user-1',
      count: 1
    });
  });

  it('requires a userId', async () => {
    await expect(listSentThreads('')).rejects.toThrow(/userId/i);
  });
});
