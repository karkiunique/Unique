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
    // `new google.auth.OAuth2(...)` — the impl must be constructible, so no arrow.
    OAuth2: vi.fn(function OAuth2Mock() {
      return oauthClient;
    }),
    gmailFactory: vi.fn(() => gmailApi)
  };
});

const { getUser, supabaseFrom, generateEmail } = vi.hoisted(() => ({
  getUser: vi.fn(),
  supabaseFrom: vi.fn(),
  generateEmail: vi.fn()
}));

const { verifyRecipient } = vi.hoisted(() => ({ verifyRecipient: vi.fn() }));

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

// Anthropic never runs in this suite: the drafting service is stubbed wholesale
// so /send/generate can be exercised without a model call.
vi.mock('../src/services/generate.js', () => ({ generateEmail }));

// Same reasoning for DNS: the route is the subject here, and the resolver is
// exercised in recipientCheck.test.js.
vi.mock('../src/services/recipientCheck.js', () => ({ verifyRecipient }));

const { createApp } = await import('../src/app.js');
const { buildMimeMessage, sendEmail, classifyGmailFailure, GMAIL_FAILURE } = await import(
  '../src/services/send.js'
);
const { encrypt } = await import('../src/lib/crypto.js');
const { logger } = await import('../src/lib/logger.js');

const KEY = Buffer.alloc(32, 7).toString('base64');
const ENV_KEYS = [
  'TOKEN_ENC_KEY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI'
];
const envBackup = {};

const AUTH_HEADER = ['Authorization', 'Bearer good.jwt'];
// From, To, Subject, MIME-Version, Content-Type, Content-Transfer-Encoding.
// Pinned so an injected CRLF that creates a 7th line fails loudly.
const EXPECTED_HEADER_LINES = 6;
const FROM = 'ana@acme.com';
const TO = 'sam@corp.com';
const SUBJECT = 'about the launch';
const BODY = [
  'hey Sam',
  '',
  'saw the launch go out. worth 15 minutes next week?',
  '',
  'thanks,',
  'Ana',
  '',
  "Don't want emails from me? [Unsubscribe](http://localhost:5173/u/abc.def)"
].join('\n');

/** One chain object covering both reads (getAuthedClient) and writes (disconnect). */
function mockProfileChain(readResult) {
  const capture = {};
  supabaseFrom.mockReturnValue({
    select: () => ({ eq: () => ({ maybeSingle: async () => readResult }) }),
    update: (payload) => {
      capture.update = payload;
      return {
        eq: async (column, value) => {
          capture.eq = [column, value];
          return { data: null, error: null };
        }
      };
    },
    // The send_log record written after a successful send (migration 003). Ids
    // only; the follow-up and register behaviour it feeds is covered in
    // sendFollowUp.test.js.
    upsert: async (payload) => {
      capture.upsert = payload;
      return { data: null, error: null };
    }
  });
  return capture;
}

function mockConnectedGmail() {
  const capture = mockProfileChain({
    data: { gmail_refresh_token_enc: encrypt('rt-xyz') },
    error: null
  });
  gmailApi.users.getProfile.mockResolvedValue({ data: { emailAddress: FROM } });
  gmailApi.users.messages.send.mockResolvedValue({ data: { id: 'msg-1', threadId: 'thr-1' } });
  return capture;
}

/** The body of a MIME message, without splitting on blank lines inside it. */
function mimeBody(mime) {
  const separator = mime.indexOf('\r\n\r\n');
  return separator === -1 ? '' : mime.slice(separator + 4);
}

function sentMime() {
  const raw = gmailApi.users.messages.send.mock.calls[0][0].requestBody.raw;
  return Buffer.from(raw, 'base64url').toString('utf8');
}

// One server for the whole file: 36 requests, comfortably inside the app's
// 100-per-60s rate limit. Every HTTP call below goes through it, so the suite
// binds one port rather than one per request — see helpers/testServer.js.
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

  getUser.mockReset();
  supabaseFrom.mockReset();
  generateEmail.mockReset();
  gmailApi.users.getProfile.mockReset();
  gmailApi.users.messages.send.mockReset();
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

describe('buildMimeMessage', () => {
  it('writes the required RFC 2822 headers followed by the body', () => {
    const mime = buildMimeMessage({
      from: FROM,
      to: TO,
      subject: SUBJECT,
      body: 'line one\nline two'
    });

    const headers = mime.slice(0, mime.indexOf('\r\n\r\n')).split('\r\n');

    expect(headers[0]).toBe(`From: ${FROM}`);
    expect(headers[1]).toBe(`To: ${TO}`);
    expect(headers[2]).toBe(`Subject: ${SUBJECT}`);
    expect(headers).toContain('MIME-Version: 1.0');
    expect(headers).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(mimeBody(mime)).toBe('line one\r\nline two');
  });

  it('RFC 2047 encodes a non-ASCII subject', () => {
    const subject = 'café ☕ next week?';
    const mime = buildMimeMessage({ from: FROM, to: TO, subject, body: 'hi' });

    const expected = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;

    expect(mime).toContain(`Subject: ${expected}`);
    expect(mime).not.toContain(`Subject: ${subject}`);
  });

  it('leaves a plain ASCII subject unencoded', () => {
    const mime = buildMimeMessage({ from: FROM, to: TO, subject: SUBJECT, body: 'hi' });

    expect(mime).toContain(`Subject: ${SUBJECT}`);
    expect(mime).not.toContain('=?UTF-8?B?');
  });

  it('strips CR/LF out of header values so headers cannot be injected', () => {
    const mime = buildMimeMessage({
      from: FROM,
      to: TO,
      subject: 'hello\r\nBcc: victim@corp.com',
      body: 'hi'
    });

    const headerBlock = mime.slice(0, mime.indexOf('\r\n\r\n'));
    const headers = headerBlock.split('\r\n');

    // Asserted per LINE, not as a raw substring. The neutralised value still
    // legitimately CONTAINS the text "Bcc: victim@corp.com" — folded into the
    // Subject. The invariant is that it never STARTS a header line of its own.
    expect(headers).toHaveLength(EXPECTED_HEADER_LINES);
    expect(headers.some((line) => /^Bcc:/i.test(line))).toBe(false);
    expect(headers.filter((line) => /^Subject:/i.test(line))).toHaveLength(1);
    expect(headerBlock).not.toContain('\r\nBcc:');
  });

  it('strips CR/LF out of the recipient header so To cannot inject either', () => {
    const mime = buildMimeMessage({
      from: FROM,
      to: `${TO}\r\nBcc: victim@corp.com`,
      subject: SUBJECT,
      body: 'hi'
    });

    const headerBlock = mime.slice(0, mime.indexOf('\r\n\r\n'));
    const headers = headerBlock.split('\r\n');

    // From/To are interpolated straight into the header block, so sanitizeHeader
    // is the ONLY thing standing between a crafted address and a real Bcc line.
    expect(headers).toHaveLength(EXPECTED_HEADER_LINES);
    expect(headers.some((line) => /^Bcc:/i.test(line))).toBe(false);
    expect(headers.filter((line) => /^To:/i.test(line))).toHaveLength(1);
    expect(headerBlock).not.toContain('\r\nBcc:');
  });

  it('rejects a message with a missing field', () => {
    expect(() => buildMimeMessage({ from: FROM, to: TO, subject: '', body: 'hi' })).toThrow(
      /required/i
    );
    expect(() => buildMimeMessage({ from: FROM, to: TO, subject: SUBJECT, body: '' })).toThrow(
      /required/i
    );
  });
});

describe('sendEmail', () => {
  it('base64url-encodes the MIME message and calls gmail.users.messages.send', async () => {
    mockConnectedGmail();

    const result = await sendEmail('user-1', { to: TO, subject: SUBJECT, body: BODY });

    expect(result).toEqual({ messageId: 'msg-1', threadId: 'thr-1' });
    expect(gmailApi.users.messages.send).toHaveBeenCalledTimes(1);

    const arg = gmailApi.users.messages.send.mock.calls[0][0];
    expect(arg.userId).toBe('me');
    // base64url: no +, no /, no = padding.
    expect(arg.requestBody.raw).not.toMatch(/[+/=]/);
    expect(sentMime()).toBe(buildMimeMessage({ from: FROM, to: TO, subject: SUBJECT, body: BODY }));
  });

  it('reads the sender address from gmail.users.getProfile', async () => {
    mockConnectedGmail();

    await sendEmail('user-1', { to: TO, subject: SUBJECT, body: BODY });

    expect(gmailApi.users.getProfile).toHaveBeenCalledWith({ userId: 'me' });
    expect(sentMime()).toContain(`From: ${FROM}`);
  });

  it('rejects an implausible recipient address with 400 before calling Gmail', async () => {
    mockConnectedGmail();

    await expect(
      sendEmail('user-1', { to: 'not-an-email', subject: SUBJECT, body: BODY })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      sendEmail('user-1', { to: '', subject: SUBJECT, body: BODY })
    ).rejects.toMatchObject({ status: 400 });

    expect(gmailApi.users.messages.send).not.toHaveBeenCalled();
  });

  it('sets gmail_connected=false when Gmail answers 401 (auth revoked)', async () => {
    const capture = mockConnectedGmail();
    const revoked = new Error('invalid_grant');
    revoked.status = 401;
    gmailApi.users.messages.send.mockRejectedValue(revoked);

    await expect(
      sendEmail('user-1', { to: TO, subject: SUBJECT, body: BODY })
    ).rejects.toThrow(/revoked/i);

    expect(capture.update).toEqual({ gmail_connected: false });
    expect(capture.eq).toEqual(['id', 'user-1']);
  });

  it('never echoes Gmail\'s own error message', async () => {
    mockConnectedGmail();
    const failure = new Error(`rejected message for ${TO}: ${SUBJECT}`);
    failure.status = 500;
    gmailApi.users.messages.send.mockRejectedValue(failure);

    await expect(sendEmail('user-1', { to: TO, subject: SUBJECT, body: BODY })).rejects.toThrow(
      /Gmail rejected the message/
    );
  });
});

/**
 * 403 is overloaded. A token granted before gmail.send existed and a transient
 * rate limit both arrive as 403, and only the first one warrants clearing the
 * connection. Treating them the same disconnects healthy accounts.
 */
describe('classifyGmailFailure', () => {
  function gmailError(status, extra = {}) {
    const err = new Error('boom');
    err.status = status;
    return Object.assign(err, extra);
  }

  it('reads 401 as a revoked grant', () => {
    expect(classifyGmailFailure(gmailError(401))).toBe(GMAIL_FAILURE.REVOKED);
  });

  it('reads a 403 insufficientPermissions reason as a scope problem', () => {
    const err = gmailError(403, { errors: [{ reason: 'insufficientPermissions' }] });

    expect(classifyGmailFailure(err)).toBe(GMAIL_FAILURE.INSUFFICIENT_SCOPE);
  });

  it('reads ACCESS_TOKEN_SCOPE_INSUFFICIENT out of the nested response shape', () => {
    const err = gmailError(403, {
      response: {
        data: { error: { details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }
      }
    });

    expect(classifyGmailFailure(err)).toBe(GMAIL_FAILURE.INSUFFICIENT_SCOPE);
  });

  it('reads every rate-limit reason as rate limiting, not revocation', () => {
    for (const reason of ['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded']) {
      const err = gmailError(403, {
        response: { data: { error: { errors: [{ reason }] } } }
      });

      expect(classifyGmailFailure(err)).toBe(GMAIL_FAILURE.RATE_LIMITED);
    }
  });

  it('falls back to the message text only for narrow, specific wording', () => {
    const scoped = gmailError(403);
    scoped.message = 'Request had insufficient authentication scopes.';

    expect(classifyGmailFailure(scoped)).toBe(GMAIL_FAILURE.INSUFFICIENT_SCOPE);

    const vague = gmailError(403);
    vague.message = 'Permission denied.';

    expect(classifyGmailFailure(vague)).toBe(GMAIL_FAILURE.OTHER);
  });

  it('treats an unrecognised or absent 403 reason as OTHER', () => {
    expect(classifyGmailFailure(gmailError(403))).toBe(GMAIL_FAILURE.OTHER);
    expect(classifyGmailFailure(gmailError(403, { errors: [{ reason: 'domainPolicy' }] }))).toBe(
      GMAIL_FAILURE.OTHER
    );
  });

  it('classifies malformed error objects without throwing', () => {
    const malformed = [
      null,
      undefined,
      {},
      'a string',
      { status: 403, errors: null, response: null },
      { status: 403, errors: 'nope', response: { data: null } },
      { status: 403, response: { data: { error: null } } },
      { status: 403, response: { data: { error: { errors: [null, {}, { reason: 7 }] } } } },
      { status: 403, message: null }
    ];

    for (const err of malformed) {
      expect(() => classifyGmailFailure(err)).not.toThrow();
      expect(classifyGmailFailure(err)).toBe(GMAIL_FAILURE.OTHER);
    }
  });

  it('leaves non-4xx statuses alone', () => {
    expect(classifyGmailFailure(gmailError(500))).toBe(GMAIL_FAILURE.OTHER);
    expect(classifyGmailFailure(gmailError(429))).toBe(GMAIL_FAILURE.OTHER);
  });
});

describe('sendEmail — responding to a Gmail 403', () => {
  function rejectSendWith(err) {
    gmailApi.users.messages.send.mockRejectedValue(err);
  }

  function gmail403(extra) {
    const err = new Error('boom');
    err.status = 403;
    return Object.assign(err, extra);
  }

  async function sendAndCatch() {
    return sendEmail('user-1', { to: TO, subject: SUBJECT, body: BODY }).catch((err) => err);
  }

  it('asks for re-approval — not "revoked" — when the token predates a scope', async () => {
    const capture = mockConnectedGmail();
    rejectSendWith(gmail403({ errors: [{ reason: 'insufficientPermissions' }] }));

    const thrown = await sendAndCatch();

    // Still disconnects: that is what drives the UI back to Connect, which is
    // the recovery path. Only the wording changes.
    expect(capture.update).toEqual({ gmail_connected: false });
    expect(thrown.message).not.toMatch(/revoked/i);
    expect(thrown.message).toMatch(/re-approval|permission/i);
    expect(thrown.status).toBe(400);
    // A distinct event, so scope failures are separable from real revocations.
    expect(logger.error).toHaveBeenCalledWith('gmail_scope_insufficient', {
      userId: 'user-1',
      status: 403
    });
    expect(logger.error).not.toHaveBeenCalledWith('gmail_auth_revoked', expect.anything());
  });

  it('does NOT disconnect on a rate-limit 403, and returns a retryable error', async () => {
    const capture = mockConnectedGmail();
    rejectSendWith(
      gmail403({ response: { data: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } } })
    );

    const thrown = await sendAndCatch();

    // The whole point of the fix: a transient limit must not cost a re-consent.
    expect(capture.update).toBeUndefined();
    expect(thrown.message).toMatch(/rate limiting|try again/i);
    expect(thrown.message).not.toMatch(/revoked|reconnect/i);
    expect(thrown.status).toBe(429);
    expect(logger.error).toHaveBeenCalledWith('gmail_rate_limited', {
      userId: 'user-1',
      status: 403
    });
  });

  it('does NOT disconnect on a 403 with an unrecognised reason', async () => {
    const capture = mockConnectedGmail();
    rejectSendWith(gmail403({ errors: [{ reason: 'domainPolicy' }] }));

    const thrown = await sendAndCatch();

    expect(capture.update).toBeUndefined();
    expect(thrown.message).toBe('Gmail rejected the message');
  });

  it('does NOT disconnect on a 403 carrying no reason at all', async () => {
    const capture = mockConnectedGmail();
    rejectSendWith(gmail403({}));

    await sendAndCatch();

    expect(capture.update).toBeUndefined();
  });

  it('keeps Gmail\'s raw error text out of both the logs and the thrown message', async () => {
    mockConnectedGmail();
    const raw = `Delegation denied for ${TO} on "${SUBJECT}"`;
    rejectSendWith(
      gmail403({ message: raw, errors: [{ reason: 'insufficientPermissions', message: raw }] })
    );

    const thrown = await sendAndCatch();

    expect(thrown.message).not.toContain(raw);
    expect(thrown.message).not.toContain('Delegation denied');
    expect(thrown.message).not.toContain(TO);
    expect(thrown.message).not.toContain(SUBJECT);

    const calls = [
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls
    ];

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain('Delegation denied');
      expect(serialized).not.toContain(TO);
      expect(serialized).not.toContain(SUBJECT);
    }
  });
});

describe('POST /api/send — the confirmation gate', () => {
  beforeEach(() => {
    mockConnectedGmail();
  });

  it('401s without a token', async () => {
    const res = await httpRequest('post', '/api/send').send({ to: TO, confirmed: true });

    expect(res.status).toBe(401);
    expect(gmailApi.users.messages.send).not.toHaveBeenCalled();
  });

  it('400s when confirmed is omitted, and never calls Gmail send', async () => {
    const res = await authed('post', '/api/send').send({ to: TO, subject: SUBJECT, body: BODY });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Explicit confirmation required before sending' });
    expect(gmailApi.users.messages.send).not.toHaveBeenCalled();
  });

  it('400s when confirmed is false, and never calls Gmail send', async () => {
    const res = await authed('post', '/api/send').send({
      to: TO,
      subject: SUBJECT,
      body: BODY,
      confirmed: false
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Explicit confirmation required before sending' });
    expect(gmailApi.users.messages.send).not.toHaveBeenCalled();
  });

  it("400s when confirmed is the string 'true' — strict boolean only", async () => {
    const res = await authed('post', '/api/send').send({
      to: TO,
      subject: SUBJECT,
      body: BODY,
      confirmed: 'true'
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Explicit confirmation required before sending' });
    expect(gmailApi.users.messages.send).not.toHaveBeenCalled();
  });

  it('400s for other truthy stand-ins (1, "yes"), and never calls Gmail send', async () => {
    for (const confirmed of [1, 'yes', {}, ['true']]) {
      gmailApi.users.messages.send.mockClear();

      const res = await authed('post', '/api/send').send({
        to: TO,
        subject: SUBJECT,
        body: BODY,
        confirmed
      });

      expect(res.status).toBe(400);
      expect(gmailApi.users.messages.send).not.toHaveBeenCalled();
    }
  });

  it('sends and returns the gmail ids when confirmed is exactly true', async () => {
    const res = await authed('post', '/api/send').send({
      to: TO,
      subject: SUBJECT,
      body: BODY,
      confirmed: true
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ messageId: 'msg-1', threadId: 'thr-1' });
    expect(gmailApi.users.messages.send).toHaveBeenCalledTimes(1);
  });

  it('sends exactly the subject and body it was given, unmodified', async () => {
    await authed('post', '/api/send').send({
      to: TO,
      subject: SUBJECT,
      body: BODY,
      confirmed: true
    });

    const mime = sentMime();

    expect(mime).toContain(`Subject: ${SUBJECT}`);
    expect(mime).toContain(`To: ${TO}`);
    expect(mimeBody(mime)).toBe(BODY.replace(/\n/g, '\r\n'));
  });

  it('400s with {error} for a missing recipient, subject or body', async () => {
    const cases = [
      [{ subject: SUBJECT, body: BODY }, 'A recipient email address is required'],
      [{ to: TO, body: BODY }, 'A subject is required'],
      [{ to: TO, subject: SUBJECT }, 'A body is required']
    ];

    for (const [payload, message] of cases) {
      const res = await authed('post', '/api/send').send({ ...payload, confirmed: true });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: message });
    }

    expect(gmailApi.users.messages.send).not.toHaveBeenCalled();
  });
});

/**
 * A failed send that needs re-consent is useless to the user unless the UI can
 * put the button in front of them. The route names the recovery as a stable
 * CODE so the client never has to match on the wording of the message.
 */
describe('POST /api/send — the recovery action', () => {
  const RECONNECT = 'reconnect_gmail';

  function gmail403(extra) {
    const err = new Error('boom');
    err.status = 403;
    return Object.assign(err, extra);
  }

  async function postSend() {
    return authed('post', '/api/send').send({
      to: TO,
      subject: SUBJECT,
      body: BODY,
      confirmed: true
    });
  }

  beforeEach(() => {
    mockConnectedGmail();
  });

  it('names reconnect_gmail when the token predates a scope we now need', async () => {
    gmailApi.users.messages.send.mockRejectedValue(
      gmail403({ errors: [{ reason: 'insufficientPermissions' }] })
    );

    const res = await postSend();

    expect(res.status).toBe(400);
    expect(res.body.action).toBe(RECONNECT);
    expect(res.body.error).toMatch(/re-approval|permission/i);
  });

  it('names reconnect_gmail when the grant was revoked', async () => {
    const revoked = new Error('invalid_grant');
    revoked.status = 401;
    gmailApi.users.messages.send.mockRejectedValue(revoked);

    const res = await postSend();

    expect(res.status).toBe(400);
    expect(res.body.action).toBe(RECONNECT);
  });

  it('does NOT name it on a rate-limit 403, and still does not disconnect', async () => {
    const capture = mockConnectedGmail();
    gmailApi.users.messages.send.mockRejectedValue(
      gmail403({ response: { data: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } } })
    );

    const res = await postSend();

    expect(res.status).toBe(429);
    expect(res.body.action).toBeUndefined();
    // A transient limit must not cost the user a re-consent.
    expect(capture.update).toBeUndefined();
  });

  it('does NOT name it on an unrecognised failure', async () => {
    gmailApi.users.messages.send.mockRejectedValue(
      gmail403({ errors: [{ reason: 'domainPolicy' }] })
    );

    const res = await postSend();

    // The recovery code is the assertion that matters: an unrecognised failure
    // must never send the user round a re-consent it cannot fix.
    expect(res.body.action).toBeUndefined();
    expect(res.status).toBe(502);
    // A 5xx is masked on the way out (lib/httpError.js), so the client sees the
    // generic line, not the service's 'Gmail rejected the message' — that throw
    // is asserted at the service level above.
    expect(res.body.error).toBe('Could not send the email');
  });

  it('adds nothing to a successful send', async () => {
    const res = await postSend();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ messageId: 'msg-1', threadId: 'thr-1' });
  });
});

describe('POST /api/send/generate', () => {
  beforeEach(() => {
    mockConnectedGmail();
    generateEmail.mockResolvedValue({
      subject: SUBJECT,
      body: BODY,
      fidelityScore: 91,
      violations: []
    });
  });

  it('401s without a token', async () => {
    const res = await httpRequest('post', '/api/send/generate').send({ to: TO, goal: 'x' });

    expect(res.status).toBe(401);
  });

  it('returns the draft and NEVER calls gmail.users.messages.send', async () => {
    const res = await authed('post', '/api/send/generate').send({
      to: TO,
      recipientName: 'Sam',
      company: 'Corp',
      goal: 'ask for 15 minutes'
    });

    expect(res.status).toBe(200);
    expect(res.body.subject).toBe(SUBJECT);
    expect(res.body.fidelityScore).toBe(91);
    expect(generateEmail).toHaveBeenCalledTimes(1);
    // Drafting cannot send. This is the whole reason the two routes are separate.
    expect(gmailApi.users.messages.send).not.toHaveBeenCalled();
  });

  it('400s without a recipient or a goal, and never drafts', async () => {
    const missingTo = await authed('post', '/api/send/generate').send({
      goal: 'ask for 15 minutes'
    });

    expect(missingTo.status).toBe(400);
    expect(missingTo.body).toEqual({ error: 'A recipient email address is required' });

    const missingGoal = await authed('post', '/api/send/generate').send({ to: TO });

    expect(missingGoal.status).toBe(400);
    expect(missingGoal.body).toEqual({ error: 'A goal for the email is required' });
    expect(generateEmail).not.toHaveBeenCalled();
    expect(gmailApi.users.messages.send).not.toHaveBeenCalled();
  });
});

/**
 * The recipient check protects the USER'S mailbox: they send from their own
 * Gmail, so a bounce lands on their personal sender reputation. It is advisory
 * only — it persists nothing and blocks nothing.
 */
describe('POST /api/send/verify-recipient', () => {
  const OK_RESULT = { status: 'ok', reasons: [], hasMx: true };

  beforeEach(() => {
    verifyRecipient.mockReset();
    verifyRecipient.mockResolvedValue(OK_RESULT);
  });

  it('401s without a token, and never runs the check', async () => {
    const res = await httpRequest('post', '/api/send/verify-recipient').send({ to: TO });

    expect(res.status).toBe(401);
    expect(verifyRecipient).not.toHaveBeenCalled();
  });

  it('returns the verification result for a valid body', async () => {
    const warn = { status: 'warn', reasons: ['role_address'], hasMx: true };
    verifyRecipient.mockResolvedValue(warn);

    const res = await authed('post', '/api/send/verify-recipient').send({ to: 'info@corp.com' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(warn);
    expect(verifyRecipient).toHaveBeenCalledWith('info@corp.com');
  });

  it('marks the response no-store — a per-recipient verdict is not cacheable', async () => {
    const res = await authed('post', '/api/send/verify-recipient').send({ to: TO });

    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('400s on a missing or malformed body, and never runs the check', async () => {
    const payloads = [{}, { to: '' }, { to: '   ' }, { to: 42 }, { to: null }, { to: ['a@b.com'] }];

    for (const payload of payloads) {
      const res = await authed('post', '/api/send/verify-recipient').send(payload);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'A recipient email address is required' });
    }

    const noBody = await authed('post', '/api/send/verify-recipient');

    expect(noBody.status).toBe(400);
    expect(verifyRecipient).not.toHaveBeenCalled();
  });

  it('keeps the recipient address — and its domain — out of every log line', async () => {
    verifyRecipient.mockResolvedValue({ status: 'invalid', reasons: ['no_mx'], hasMx: false });

    await authed('post', '/api/send/verify-recipient').send({ to: TO });

    const calls = [
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls
    ];

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(TO);
      // Not even the domain: it still reveals who is being contacted.
      expect(serialized).not.toContain('corp.com');
    }

    // The whole log line: an id and an outcome.
    expect(logger.info).toHaveBeenCalledWith('recipient_verified', {
      userId: 'user-abc',
      status: 'invalid'
    });
  });

  it('persists nothing — no table is touched on this path', async () => {
    await authed('post', '/api/send/verify-recipient').send({ to: TO });

    // requireAuth verifies the JWT via auth.getUser; that is not persistence.
    // A `.from(...)` call would be, and there is none.
    expect(supabaseFrom).not.toHaveBeenCalled();
  });

  it('cannot send: gmail.users.messages.send is never reached', async () => {
    await authed('post', '/api/send/verify-recipient').send({ to: TO });

    expect(gmailApi.users.messages.send).not.toHaveBeenCalled();
  });
});

describe('send logging', () => {
  it('never logs the recipient, subject or body', async () => {
    mockConnectedGmail();

    await authed('post', '/api/send').send({
      to: TO,
      subject: SUBJECT,
      body: BODY,
      confirmed: true
    });

    const calls = [
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls
    ];

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(TO);
      expect(serialized).not.toContain(SUBJECT);
      expect(serialized).not.toContain('saw the launch go out');
      expect(serialized).not.toContain('Unsubscribe');
    }

    expect(logger.info).toHaveBeenCalledWith('email_sent', {
      userId: 'user-abc',
      messageId: 'msg-1',
      threadId: 'thr-1'
    });
  });
});
