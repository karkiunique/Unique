import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

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

const { createApp } = await import('../src/app.js');
const { buildMimeMessage, sendEmail } = await import('../src/services/send.js');
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

describe('POST /api/send — the confirmation gate', () => {
  beforeEach(() => {
    mockConnectedGmail();
  });

  it('401s without a token', async () => {
    const res = await request(createApp()).post('/api/send').send({ to: TO, confirmed: true });

    expect(res.status).toBe(401);
    expect(gmailApi.users.messages.send).not.toHaveBeenCalled();
  });

  it('400s when confirmed is omitted, and never calls Gmail send', async () => {
    const res = await request(createApp())
      .post('/api/send')
      .set(...AUTH_HEADER)
      .send({ to: TO, subject: SUBJECT, body: BODY });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Explicit confirmation required before sending' });
    expect(gmailApi.users.messages.send).not.toHaveBeenCalled();
  });

  it('400s when confirmed is false, and never calls Gmail send', async () => {
    const res = await request(createApp())
      .post('/api/send')
      .set(...AUTH_HEADER)
      .send({ to: TO, subject: SUBJECT, body: BODY, confirmed: false });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Explicit confirmation required before sending' });
    expect(gmailApi.users.messages.send).not.toHaveBeenCalled();
  });

  it("400s when confirmed is the string 'true' — strict boolean only", async () => {
    const res = await request(createApp())
      .post('/api/send')
      .set(...AUTH_HEADER)
      .send({ to: TO, subject: SUBJECT, body: BODY, confirmed: 'true' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Explicit confirmation required before sending' });
    expect(gmailApi.users.messages.send).not.toHaveBeenCalled();
  });

  it('400s for other truthy stand-ins (1, "yes"), and never calls Gmail send', async () => {
    for (const confirmed of [1, 'yes', {}, ['true']]) {
      gmailApi.users.messages.send.mockClear();

      const res = await request(createApp())
        .post('/api/send')
        .set(...AUTH_HEADER)
        .send({ to: TO, subject: SUBJECT, body: BODY, confirmed });

      expect(res.status).toBe(400);
      expect(gmailApi.users.messages.send).not.toHaveBeenCalled();
    }
  });

  it('sends and returns the gmail ids when confirmed is exactly true', async () => {
    const res = await request(createApp())
      .post('/api/send')
      .set(...AUTH_HEADER)
      .send({ to: TO, subject: SUBJECT, body: BODY, confirmed: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ messageId: 'msg-1', threadId: 'thr-1' });
    expect(gmailApi.users.messages.send).toHaveBeenCalledTimes(1);
  });

  it('sends exactly the subject and body it was given, unmodified', async () => {
    await request(createApp())
      .post('/api/send')
      .set(...AUTH_HEADER)
      .send({ to: TO, subject: SUBJECT, body: BODY, confirmed: true });

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
      const res = await request(createApp())
        .post('/api/send')
        .set(...AUTH_HEADER)
        .send({ ...payload, confirmed: true });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: message });
    }

    expect(gmailApi.users.messages.send).not.toHaveBeenCalled();
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
    const res = await request(createApp()).post('/api/send/generate').send({ to: TO, goal: 'x' });

    expect(res.status).toBe(401);
  });

  it('returns the draft and NEVER calls gmail.users.messages.send', async () => {
    const res = await request(createApp())
      .post('/api/send/generate')
      .set(...AUTH_HEADER)
      .send({ to: TO, recipientName: 'Sam', company: 'Corp', goal: 'ask for 15 minutes' });

    expect(res.status).toBe(200);
    expect(res.body.subject).toBe(SUBJECT);
    expect(res.body.fidelityScore).toBe(91);
    expect(generateEmail).toHaveBeenCalledTimes(1);
    // Drafting cannot send. This is the whole reason the two routes are separate.
    expect(gmailApi.users.messages.send).not.toHaveBeenCalled();
  });

  it('400s without a recipient or a goal, and never drafts', async () => {
    const missingTo = await request(createApp())
      .post('/api/send/generate')
      .set(...AUTH_HEADER)
      .send({ goal: 'ask for 15 minutes' });

    expect(missingTo.status).toBe(400);
    expect(missingTo.body).toEqual({ error: 'A recipient email address is required' });

    const missingGoal = await request(createApp())
      .post('/api/send/generate')
      .set(...AUTH_HEADER)
      .send({ to: TO });

    expect(missingGoal.status).toBe(400);
    expect(missingGoal.body).toEqual({ error: 'A goal for the email is required' });
    expect(generateEmail).not.toHaveBeenCalled();
    expect(gmailApi.users.messages.send).not.toHaveBeenCalled();
  });
});

describe('send logging', () => {
  it('never logs the recipient, subject or body', async () => {
    mockConnectedGmail();

    await request(createApp())
      .post('/api/send')
      .set(...AUTH_HEADER)
      .send({ to: TO, subject: SUBJECT, body: BODY, confirmed: true });

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
