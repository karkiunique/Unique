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

function message({ from, id = 'm-1', date = 1738560000000, subject = SUBJECT, to = RECIPIENT }) {
  return {
    id,
    internalDate: String(date),
    payload: {
      headers: [
        { name: 'From', value: `Ana Silva <${from}>` },
        { name: 'To', value: `Sam Rivera <${to}>` },
        { name: 'Subject', value: subject },
        { name: 'Date', value: new Date(date).toUTCString() }
      ]
    }
  };
}

/**
 * send_log rows, newest first — the register's source of truth. The listing reads
 * thread ids from here, NOT from a Gmail search, which is what makes it "ours only".
 */
let sendLogRows = [];

function sendLogChain() {
  const result = { data: sendLogRows, error: null };
  const builder = {
    select: () => builder,
    eq: () => builder,
    not: () => builder,
    order: () => builder,
    limit: async () => result,
    insert,
    update,
    upsert,
    delete: del
  };

  return builder;
}

function profileChain() {
  return {
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
  };
}

/** Routes by table so send_log reads and the profile read are distinguishable. */
function mockSupabase() {
  supabaseFrom.mockImplementation((table) =>
    table === 'send_log' ? sendLogChain() : profileChain()
  );
}

/** `threads` land in send_log AND in Gmail. `gmailOnly` exist in Gmail but were not sent by us. */
function mockThreads(threads, gmailOnly = []) {
  sendLogRows = threads.map((thread, index) => ({
    gmail_thread_id: thread.id,
    sent_at: new Date(1738560000000 - index * 1000).toISOString()
  }));

  const all = [...threads, ...gmailOnly];
  gmailApi.users.threads.get.mockImplementation(async ({ id }) => ({
    data: all.find((thread) => thread.id === id) ?? null
  }));
}

beforeEach(() => {
  for (const key of ENV_KEYS) envBackup[key] = process.env[key];

  process.env.TOKEN_ENC_KEY = KEY;
  process.env.GOOGLE_CLIENT_ID = 'client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
  process.env.GOOGLE_REDIRECT_URI = 'http://localhost:3000/api/gmail/callback';

  sendLogRows = [];
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
  it('sources thread ids from send_log, never an in:sent search, and never fetches bodies', async () => {
    mockThreads([{ id: 't-1', messages: [message({ from: SELF })] }]);

    await listSentThreads('user-1', { limit: 5 });

    // The whole "ours only" guarantee: a mailbox search cannot tell a message we
    // sent from one the user wrote in Gmail, so it must not be used at all.
    expect(gmailApi.users.threads.list).not.toHaveBeenCalled();
    expect(supabaseFrom).toHaveBeenCalledWith('send_log');

    const getArgs = gmailApi.users.threads.get.mock.calls[0][0];
    expect(getArgs.id).toBe('t-1');
    expect(getArgs.format).toBe('metadata');
    expect(getArgs.metadataHeaders).toEqual(['Subject', 'To', 'From', 'Date']);
  });

  it('omits a thread that exists in Gmail but is NOT in send_log', async () => {
    mockThreads(
      [{ id: 't-ours', messages: [message({ from: SELF })] }],
      [
        {
          id: 't-personal',
          messages: [message({ from: SELF, id: 'm-p', subject: 'dinner saturday' })]
        }
      ]
    );

    const threads = await listSentThreads('user-1');

    expect(threads.map((thread) => thread.threadId)).toEqual(['t-ours']);
    expect(gmailApi.users.threads.get).toHaveBeenCalledTimes(1);
  });

  it('skips a thread that is in send_log but has been deleted in Gmail', async () => {
    mockThreads([
      { id: 't-1', messages: [message({ from: SELF })] },
      { id: 't-gone', messages: [] },
      { id: 't-2', messages: [message({ from: SELF, id: 'm-2' })] }
    ]);

    const notFound = new Error('Requested entity was not found.');
    notFound.status = 404;
    gmailApi.users.threads.get.mockImplementation(async ({ id }) => {
      if (id === 't-gone') throw notFound;
      return { data: { id, messages: [message({ from: SELF })] } };
    });

    const threads = await listSentThreads('user-1');

    // One stale row must not take the whole register down.
    expect(threads.map((thread) => thread.threadId)).toEqual(['t-1', 't-2']);
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
    // Two reads: the send_log id lookup, and the profile read that decrypts the token.
    expect(supabaseFrom).toHaveBeenCalledTimes(2);
    expect(supabaseFrom).toHaveBeenCalledWith('send_log');
    expect(supabaseFrom).toHaveBeenCalledWith('profiles');
  });

  it('returns an empty list when nothing has been sent', async () => {
    mockThreads([]);

    expect(await listSentThreads('user-1')).toEqual([]);
    // Nothing in send_log means nothing to show — Gmail is never touched.
    expect(gmailApi.users.threads.get).not.toHaveBeenCalled();
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

describe('listSentThreads — search', () => {
  function threeThreads() {
    mockThreads([
      {
        id: 't-1',
        messages: [message({ from: SELF, subject: 'About The Launch', to: 'sam@corp.com' })]
      },
      {
        id: 't-2',
        messages: [message({ from: SELF, id: 'm-2', subject: 'pricing', to: 'Dana@Other.io' })]
      },
      {
        id: 't-3',
        messages: [message({ from: SELF, id: 'm-3', subject: 'intro call', to: 'kim@third.dev' })]
      }
    ]);
  }

  it('filters on the subject, case-insensitively', async () => {
    threeThreads();

    const threads = await listSentThreads('user-1', { query: 'LAUNCH' });

    expect(threads.map((thread) => thread.threadId)).toEqual(['t-1']);
  });

  it('filters on the recipient, case-insensitively', async () => {
    threeThreads();

    const threads = await listSentThreads('user-1', { query: 'DANA@other.IO' });

    expect(threads.map((thread) => thread.threadId)).toEqual(['t-2']);
  });

  it('returns everything for an empty query and nothing for an unmatched one', async () => {
    threeThreads();

    expect(await listSentThreads('user-1', { query: '  ' })).toHaveLength(3);
    expect(await listSentThreads('user-1', { query: 'nothing matches this' })).toHaveLength(0);
  });

  it('never logs the search query', async () => {
    threeThreads();

    await listSentThreads('user-1', { query: 'dana@other.io' });

    const calls = [
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls
    ];

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const serialized = JSON.stringify(call).toLowerCase();
      expect(serialized).not.toContain('dana');
      expect(serialized).not.toContain('other.io');
    }
  });
});
