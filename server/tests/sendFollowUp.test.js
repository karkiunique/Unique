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

const { getUser, supabaseFrom, upsert } = vi.hoisted(() => ({
  getUser: vi.fn(),
  supabaseFrom: vi.fn(),
  upsert: vi.fn()
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
const { sendEmail, withReplyPrefix } = await import('../src/services/send.js');
const { encrypt } = await import('../src/lib/crypto.js');
const { logger } = await import('../src/lib/logger.js');

const KEY = Buffer.alloc(32, 9).toString('base64');
const ENV_KEYS = [
  'TOKEN_ENC_KEY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI'
];
const envBackup = {};

const AUTH_HEADER = ['Authorization', 'Bearer good.jwt'];
const USER = 'user-abc';
const FROM = 'ana@acme.com';
const TO = 'sam@corp.com';
const SUBJECT = 'about the launch';
const BODY = 'hey Sam\n\ncircling back on this.\n\nthanks,\nAna';
const OURS = 'thread-ours';
const THEIRS = 'thread-theirs';
const PARENT_MESSAGE_ID = '<first@mail.gmail.com>';

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
    upsert
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
    update: () => ({ eq: async () => ({ data: null, error: null }) })
  };
}

function sentMime() {
  const raw = gmailApi.users.messages.send.mock.calls[0][0].requestBody.raw;
  return Buffer.from(raw, 'base64url').toString('utf8');
}

function sentRequestBody() {
  return gmailApi.users.messages.send.mock.calls[0][0].requestBody;
}

function allLogCalls() {
  return [...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls];
}

// One server for the whole file: 11 requests, well inside the app's 100-per-60s
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

  ownedThreads = { [USER]: [OURS], 'user-other': [THEIRS] };

  getUser.mockReset();
  supabaseFrom.mockReset();
  upsert.mockReset();
  gmailApi.users.getProfile.mockReset();
  gmailApi.users.messages.send.mockReset();
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
  upsert.mockResolvedValue({ data: null, error: null });
  getUser.mockResolvedValue({ data: { user: { id: USER, email: 'dev@example.com' } }, error: null });
  gmailApi.users.getProfile.mockResolvedValue({ data: { emailAddress: FROM } });
  gmailApi.users.messages.send.mockResolvedValue({ data: { id: 'msg-1', threadId: OURS } });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (envBackup[key] === undefined) delete process.env[key];
    else process.env[key] = envBackup[key];
  }
});

describe('withReplyPrefix', () => {
  it('adds "Re: " once and never twice', () => {
    expect(withReplyPrefix(SUBJECT)).toBe(`Re: ${SUBJECT}`);
    expect(withReplyPrefix(`Re: ${SUBJECT}`)).toBe(`Re: ${SUBJECT}`);
    expect(withReplyPrefix(`RE: ${SUBJECT}`)).toBe(`RE: ${SUBJECT}`);
    expect(withReplyPrefix(`re:${SUBJECT}`)).toBe(`re:${SUBJECT}`);
  });
});

describe('sendEmail — recording what we sent', () => {
  it('writes the Gmail ids to send_log after a successful send', async () => {
    await sendEmail(USER, { to: TO, subject: SUBJECT, body: BODY });

    expect(supabaseFrom).toHaveBeenCalledWith('send_log');
    expect(upsert).toHaveBeenCalledTimes(1);

    const [row, options] = upsert.mock.calls[0];

    // Ids only. No subject, no recipient, no body ever reaches this table.
    expect(row).toEqual({
      user_id: USER,
      lead_id: null,
      gmail_message_id: 'msg-1',
      gmail_thread_id: OURS
    });
    expect(Object.keys(row)).toHaveLength(4);
    // on conflict do nothing: a retry must not duplicate the row.
    expect(options).toEqual({ onConflict: 'user_id,gmail_message_id', ignoreDuplicates: true });
  });

  it('does NOT fail the send when the send_log write rejects', async () => {
    upsert.mockRejectedValue(new Error('database is down'));

    const result = await sendEmail(USER, { to: TO, subject: SUBJECT, body: BODY });

    // The mail already left the mailbox. Reporting a failure here would be a lie
    // that invites a duplicate send.
    expect(result).toEqual({ messageId: 'msg-1', threadId: OURS });
    expect(gmailApi.users.messages.send).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('send_log_write_failed', {
      userId: USER,
      messageId: 'msg-1',
      threadId: OURS
    });
  });

  it('does NOT fail the send when the send_log write returns an error', async () => {
    upsert.mockResolvedValue({ data: null, error: { message: 'unique violation' } });

    const result = await sendEmail(USER, { to: TO, subject: SUBJECT, body: BODY });

    expect(result).toEqual({ messageId: 'msg-1', threadId: OURS });
  });

  it('does not change the HTTP response when the send_log write fails', async () => {
    upsert.mockRejectedValue(new Error('database is down'));

    const res = await authed('post', '/api/send').send({
      to: TO,
      subject: SUBJECT,
      body: BODY,
      confirmed: true
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ messageId: 'msg-1', threadId: OURS });
  });
});

describe('sendEmail — follow-up in an existing thread', () => {
  it('sets In-Reply-To and References and passes the threadId to Gmail', async () => {
    await sendEmail(USER, {
      to: TO,
      subject: SUBJECT,
      body: BODY,
      threadId: OURS,
      inReplyTo: PARENT_MESSAGE_ID
    });

    const mime = sentMime();

    // Both halves are needed: headers thread it in the recipient's client,
    // threadId groups it in Gmail.
    expect(mime).toContain(`In-Reply-To: ${PARENT_MESSAGE_ID}`);
    expect(mime).toContain(`References: ${PARENT_MESSAGE_ID}`);
    expect(sentRequestBody().threadId).toBe(OURS);
  });

  it('wraps a bare Message-ID in angle brackets', async () => {
    await sendEmail(USER, {
      to: TO,
      subject: SUBJECT,
      body: BODY,
      threadId: OURS,
      inReplyTo: 'first@mail.gmail.com'
    });

    expect(sentMime()).toContain(`In-Reply-To: ${PARENT_MESSAGE_ID}`);
  });

  it('prefixes the subject with "Re: " exactly once', async () => {
    await sendEmail(USER, { to: TO, subject: SUBJECT, body: BODY, threadId: OURS });

    expect(sentMime()).toContain(`Subject: Re: ${SUBJECT}`);
  });

  it('does not double-prefix a subject that already starts with Re:', async () => {
    await sendEmail(USER, { to: TO, subject: `Re: ${SUBJECT}`, body: BODY, threadId: OURS });

    const mime = sentMime();

    expect(mime).toContain(`Subject: Re: ${SUBJECT}`);
    expect(mime).not.toContain('Subject: Re: Re:');
  });

  it('leaves a first send untouched — no Re:, no threading headers, no threadId', async () => {
    await sendEmail(USER, { to: TO, subject: SUBJECT, body: BODY });

    const mime = sentMime();

    expect(mime).toContain(`Subject: ${SUBJECT}`);
    expect(mime).not.toContain('Re: ');
    expect(mime).not.toContain('In-Reply-To:');
    expect(mime).not.toContain('References:');
    expect(sentRequestBody().threadId).toBeUndefined();
  });

  it('404s a threadId that is not in this user\'s send_log, before touching Gmail', async () => {
    await expect(
      sendEmail(USER, { to: TO, subject: SUBJECT, body: BODY, threadId: THEIRS })
    ).rejects.toMatchObject({ status: 404 });

    expect(gmailApi.users.messages.send).not.toHaveBeenCalled();
    expect(gmailFactory).not.toHaveBeenCalled();
  });

  it('records the follow-up in send_log like any other send', async () => {
    await sendEmail(USER, {
      to: TO,
      subject: SUBJECT,
      body: BODY,
      threadId: OURS,
      inReplyTo: PARENT_MESSAGE_ID
    });

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0].gmail_thread_id).toBe(OURS);
  });
});

/**
 * A follow-up is still a send. It goes through the SAME route and the SAME gate —
 * there is no second path to gmail.users.messages.send to weaken.
 */
describe('POST /api/send — a follow-up is still gated', () => {
  function postSend(payload) {
    return authed('post', '/api/send').send(payload);
  }

  it('400s a follow-up with confirmed omitted, and never calls Gmail send', async () => {
    const res = await postSend({
      to: TO,
      subject: SUBJECT,
      body: BODY,
      threadId: OURS,
      inReplyTo: PARENT_MESSAGE_ID
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Explicit confirmation required before sending' });
    expect(gmailApi.users.messages.send).not.toHaveBeenCalled();
  });

  it('400s a follow-up with confirmed:false or the string \'true\'', async () => {
    for (const confirmed of [false, 'true', 1, {}]) {
      gmailApi.users.messages.send.mockClear();

      const res = await postSend({
        to: TO,
        subject: SUBJECT,
        body: BODY,
        threadId: OURS,
        confirmed
      });

      expect(res.status).toBe(400);
      expect(gmailApi.users.messages.send).not.toHaveBeenCalled();
    }
  });

  it('sends the follow-up when confirmed is exactly true', async () => {
    const res = await postSend({
      to: TO,
      subject: SUBJECT,
      body: BODY,
      threadId: OURS,
      inReplyTo: PARENT_MESSAGE_ID,
      confirmed: true
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ messageId: 'msg-1', threadId: OURS });
    expect(sentRequestBody().threadId).toBe(OURS);
  });

  it('404s a follow-up on a thread the user did not send from Unique', async () => {
    const res = await postSend({
      to: TO,
      subject: SUBJECT,
      body: BODY,
      threadId: THEIRS,
      confirmed: true
    });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Thread not found' });
    expect(gmailApi.users.messages.send).not.toHaveBeenCalled();
  });

  it('400s an implausible threadId or inReplyTo with {error} JSON', async () => {
    const badThread = await postSend({
      to: TO,
      subject: SUBJECT,
      body: BODY,
      threadId: 'not a thread id',
      confirmed: true
    });

    expect(badThread.status).toBe(400);
    expect(badThread.body).toEqual({ error: 'Invalid thread id' });

    const badReplyTo = await postSend({
      to: TO,
      subject: SUBJECT,
      body: BODY,
      threadId: OURS,
      inReplyTo: 'has spaces <and> brackets',
      confirmed: true
    });

    expect(badReplyTo.status).toBe(400);
    expect(badReplyTo.body).toEqual({ error: 'Invalid in-reply-to message id' });
    expect(gmailApi.users.messages.send).not.toHaveBeenCalled();
  });
});

describe('follow-up logging', () => {
  it('never logs the recipient, subject or body', async () => {
    await authed('post', '/api/send').send({
      to: TO,
      subject: SUBJECT,
      body: BODY,
      threadId: OURS,
      inReplyTo: PARENT_MESSAGE_ID,
      confirmed: true
    });

    const calls = allLogCalls();

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(TO);
      expect(serialized).not.toContain(SUBJECT);
      expect(serialized).not.toContain('circling back');
    }

    expect(logger.info).toHaveBeenCalledWith('email_sent', {
      userId: USER,
      messageId: 'msg-1',
      threadId: OURS
    });
  });

  it('never logs the recipient or subject when the send_log write fails', async () => {
    upsert.mockRejectedValue(new Error('database is down'));

    await sendEmail(USER, { to: TO, subject: SUBJECT, body: BODY });

    for (const call of allLogCalls()) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(TO);
      expect(serialized).not.toContain(SUBJECT);
      expect(serialized).not.toContain('circling back');
    }
  });
});
