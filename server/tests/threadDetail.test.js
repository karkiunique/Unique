import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { useSharedTestServer } from './helpers/testServer.js';

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
    OAuth2: vi.fn(function OAuth2Mock() {
      return oauthClient;
    }),
    gmailFactory: vi.fn(() => gmailApi)
  };
});

const { getUser, supabaseFrom, insert, update, upsert, del } = vi.hoisted(() => ({
  getUser: vi.fn(),
  supabaseFrom: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  upsert: vi.fn(),
  del: vi.fn()
}));

const { generateEmail, verifyRecipient } = vi.hoisted(() => ({
  generateEmail: vi.fn(),
  verifyRecipient: vi.fn()
}));

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

vi.mock('../src/services/generate.js', () => ({ generateEmail }));
vi.mock('../src/services/recipientCheck.js', () => ({ verifyRecipient }));

const { createApp } = await import('../src/app.js');
const { getSentThread } = await import('../src/services/threads.js');
const { encrypt } = await import('../src/lib/crypto.js');
const { logger } = await import('../src/lib/logger.js');

const KEY = Buffer.alloc(32, 5).toString('base64');
const ENV_KEYS = [
  'TOKEN_ENC_KEY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI'
];
const envBackup = {};

const AUTH_HEADER = ['Authorization', 'Bearer good.jwt'];
const SELF = 'ana@acme.com';
const RECIPIENT = 'sam@corp.com';
const SUBJECT = 'about the launch';
const SENT_BODY = 'hey Sam\n\nworth 15 minutes next week?\n\nthanks,\nAna';
const REPLY_BODY = 'sure, Thursday works.\n\n> worth 15 minutes next week?';
const OURS = 'thread-ours';
const THEIRS = 'thread-theirs';

/** Who is allowed to read what. The send_log rows ARE the authorization. */
let ownedThreads = {};

function sendLogChain() {
  const filters = {};
  const builder = {
    select: () => builder,
    eq: (column, value) => {
      filters[column] = value;
      return builder;
    },
    not: () => builder,
    order: () => builder,
    limit: async () => {
      const owned = ownedThreads[filters.user_id] ?? [];

      if (filters.gmail_thread_id !== undefined) {
        const match = owned.includes(filters.gmail_thread_id);
        return { data: match ? [{ id: 'send-log-row' }] : [], error: null };
      }

      return {
        data: owned.map((id) => ({ gmail_thread_id: id, sent_at: '2026-08-01T00:00:00.000Z' })),
        error: null
      };
    },
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

function fullMessage({ id, from, to, subject, body, date, messageId }) {
  return {
    id,
    internalDate: String(date),
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: from },
        { name: 'To', value: to },
        { name: 'Subject', value: subject },
        { name: 'Message-ID', value: messageId },
        { name: 'Date', value: new Date(date).toUTCString() }
      ],
      body: { data: Buffer.from(body, 'utf8').toString('base64url') }
    }
  };
}

function mockThread() {
  gmailApi.users.threads.get.mockResolvedValue({
    data: {
      id: OURS,
      messages: [
        fullMessage({
          id: 'm-1',
          from: `Ana Silva <${SELF}>`,
          to: `Sam Rivera <${RECIPIENT}>`,
          subject: SUBJECT,
          body: SENT_BODY,
          date: 1738560000000,
          messageId: '<first@mail.gmail.com>'
        }),
        fullMessage({
          id: 'm-2',
          from: `Sam Rivera <${RECIPIENT}>`,
          to: `Ana Silva <${SELF}>`,
          subject: `Re: ${SUBJECT}`,
          body: REPLY_BODY,
          date: 1738563600000,
          messageId: '<second@mail.gmail.com>'
        })
      ]
    }
  });
}

// One server for the whole file: 4 requests, well inside the app's 100-per-60s
// rate limit. See helpers/testServer.js for why per-request binds were a problem.
const httpRequest = useSharedTestServer(createApp);

function authed(method, path) {
  return httpRequest(method, path).set(...AUTH_HEADER);
}

beforeEach(() => {
  for (const key of ENV_KEYS) envBackup[key] = process.env[key];

  process.env.TOKEN_ENC_KEY = KEY;
  process.env.GOOGLE_CLIENT_ID = 'client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
  process.env.GOOGLE_REDIRECT_URI = 'http://localhost:3000/api/gmail/callback';

  ownedThreads = { 'user-abc': [OURS], 'user-other': [THEIRS] };

  getUser.mockReset();
  supabaseFrom.mockReset();
  insert.mockReset();
  update.mockReset();
  upsert.mockReset();
  del.mockReset();
  gmailApi.users.getProfile.mockReset();
  gmailApi.users.threads.get.mockReset();
  gmailApi.users.threads.list.mockReset();
  OAuth2.mockReset();
  OAuth2.mockImplementation(function OAuth2Mock() {
    return oauthClient;
  });
  gmailFactory.mockReset();
  gmailFactory.mockImplementation(() => gmailApi);
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();

  supabaseFrom.mockImplementation((table) =>
    table === 'send_log' ? sendLogChain() : profileChain()
  );
  getUser.mockResolvedValue({
    data: { user: { id: 'user-abc', email: 'dev@example.com' } },
    error: null
  });
  gmailApi.users.getProfile.mockResolvedValue({ data: { emailAddress: SELF } });
  mockThread();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (envBackup[key] === undefined) delete process.env[key];
    else process.env[key] = envBackup[key];
  }
});

describe('getSentThread — authorization', () => {
  it('404s a threadId that is not in this user\'s send_log, and NEVER calls Gmail', async () => {
    await expect(getSentThread('user-abc', 'thread-guessed')).rejects.toMatchObject({
      status: 404
    });

    expect(gmailApi.users.threads.get).not.toHaveBeenCalled();
    expect(gmailApi.users.getProfile).not.toHaveBeenCalled();
    expect(gmailFactory).not.toHaveBeenCalled();
  });

  it('404s another user\'s threadId — one user cannot read another\'s mail', async () => {
    // THEIRS is a real thread, owned by user-other. user-abc must not reach it.
    await expect(getSentThread('user-abc', THEIRS)).rejects.toMatchObject({ status: 404 });

    expect(gmailApi.users.threads.get).not.toHaveBeenCalled();
  });

  it('requires a userId and a threadId', async () => {
    await expect(getSentThread('', OURS)).rejects.toThrow(/userId/i);
    await expect(getSentThread('user-abc', '')).rejects.toThrow(/threadId/i);
    expect(gmailApi.users.threads.get).not.toHaveBeenCalled();
  });

  it('404s when the thread has been deleted in Gmail since we sent it', async () => {
    const notFound = new Error('Requested entity was not found.');
    notFound.status = 404;
    gmailApi.users.threads.get.mockRejectedValue(notFound);

    await expect(getSentThread('user-abc', OURS)).rejects.toMatchObject({ status: 404 });
  });
});

describe('getSentThread — content', () => {
  it('returns each message with its headers and plain-text body', async () => {
    const thread = await getSentThread('user-abc', OURS);

    expect(thread.threadId).toBe(OURS);
    expect(thread.messages).toHaveLength(2);

    const [sent, reply] = thread.messages;

    expect(sent.subject).toBe(SUBJECT);
    expect(sent.to).toBe(`Sam Rivera <${RECIPIENT}>`);
    expect(sent.body).toBe(SENT_BODY);
    expect(sent.fromSelf).toBe(true);
    expect(sent.messageId).toBe('<first@mail.gmail.com>');
    expect(sent.sentAt).toBe(new Date(1738560000000).toISOString());

    expect(reply.fromSelf).toBe(false);
    expect(reply.messageId).toBe('<second@mail.gmail.com>');
  });

  it('fetches format:full — the detail view needs the actual bodies', async () => {
    await getSentThread('user-abc', OURS);

    expect(gmailApi.users.threads.get).toHaveBeenCalledWith({
      userId: 'me',
      id: OURS,
      format: 'full'
    });
  });

  it('does NOT apply the ingestion cleaner — the user sees what was really sent', async () => {
    const thread = await getSentThread('user-abc', OURS);

    // cleanEmailBody would strip the quoted line and the sign-off block. This is a
    // conversation the user is reading, not voice-profile input.
    expect(thread.messages[1].body).toContain('> worth 15 minutes next week?');
    expect(thread.messages[0].body).toContain('thanks,\nAna');
  });

  it('persists nothing — no insert, update, upsert or delete', async () => {
    await getSentThread('user-abc', OURS);

    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('logs ids and a count only — never a subject, recipient or body', async () => {
    await getSentThread('user-abc', OURS);

    const calls = [
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls
    ];

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(SUBJECT);
      expect(serialized).not.toContain(RECIPIENT);
      expect(serialized).not.toContain('worth 15 minutes');
      expect(serialized).not.toContain('Thursday');
    }

    expect(logger.info).toHaveBeenCalledWith('sent_thread_read', {
      userId: 'user-abc',
      threadId: OURS,
      count: 2
    });
  });
});

describe('GET /api/threads/:threadId', () => {
  it('401s without a token, and never calls Gmail', async () => {
    const res = await httpRequest('get', `/api/threads/${OURS}`);

    expect(res.status).toBe(401);
    expect(gmailApi.users.threads.get).not.toHaveBeenCalled();
  });

  it('returns the thread for its owner', async () => {
    const res = await authed('get', `/api/threads/${OURS}`);

    expect(res.status).toBe(200);
    expect(res.body.threadId).toBe(OURS);
    expect(res.body.messages).toHaveLength(2);
    expect(res.body.messages[0].body).toBe(SENT_BODY);
  });

  it('404s a thread the user did not send from Unique', async () => {
    const res = await authed('get', `/api/threads/${THEIRS}`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Thread not found' });
    expect(gmailApi.users.threads.get).not.toHaveBeenCalled();
  });

  it('400s an implausible thread id with {error} JSON', async () => {
    const res = await authed('get', '/api/threads/bad.id');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid thread id' });
    expect(gmailApi.users.threads.get).not.toHaveBeenCalled();
  });
});
