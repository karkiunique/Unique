import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

// Only the two factories the googleapis mock needs are bound out here: this
// suite exercises no Gmail call, it just keeps the real SDK out of the app graph.
const { OAuth2, gmailFactory } = vi.hoisted(() => {
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

const { getUser, supabaseFrom, upsert } = vi.hoisted(() => ({
  getUser: vi.fn(),
  supabaseFrom: vi.fn(),
  upsert: vi.fn()
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
const { signToken, verifyToken } = await import('../src/lib/unsubscribe.js');
const { logger } = await import('../src/lib/logger.js');

const ENV_KEYS = ['UNSUB_SECRET'];
const envBackup = {};

const SECRET = 'unsub-secret-for-tests';
const OTHER_SECRET = 'a-completely-different-secret';
const USER_ID = 'user-abc';
const RECIPIENT = 'sam@corp.com';

function withSecret(secret, fn) {
  const previous = process.env.UNSUB_SECRET;
  process.env.UNSUB_SECRET = secret;
  try {
    return fn();
  } finally {
    process.env.UNSUB_SECRET = previous;
  }
}

beforeEach(() => {
  for (const key of ENV_KEYS) envBackup[key] = process.env[key];
  process.env.UNSUB_SECRET = SECRET;

  getUser.mockReset();
  supabaseFrom.mockReset();
  upsert.mockReset();
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();

  upsert.mockResolvedValue({ data: null, error: null });
  supabaseFrom.mockReturnValue({ upsert });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (envBackup[key] === undefined) delete process.env[key];
    else process.env[key] = envBackup[key];
  }
});

describe('signToken / verifyToken', () => {
  it('round-trips a payload', () => {
    const token = signToken({ u: USER_ID, e: RECIPIENT });

    expect(verifyToken(token)).toEqual({ u: USER_ID, e: RECIPIENT });
  });

  it('produces a URL-safe token that does not expose the payload verbatim', () => {
    const token = signToken({ u: USER_ID, e: RECIPIENT });

    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(token).not.toContain(RECIPIENT);
    expect(encodeURIComponent(token)).toBe(token);
  });

  it('rejects a tampered payload', () => {
    const token = signToken({ u: USER_ID, e: RECIPIENT });
    const [payload, signature] = token.split('.');
    const tampered = `${Buffer.from(
      JSON.stringify({ u: 'someone-else', e: RECIPIENT }),
      'utf8'
    ).toString('base64url')}.${signature}`;

    expect(payload).not.toBe('');
    expect(() => verifyToken(tampered)).toThrow(/invalid/i);
  });

  it('rejects a tampered signature', () => {
    const token = signToken({ u: USER_ID, e: RECIPIENT });
    const [payload, signature] = token.split('.');
    const flipped = signature[0] === 'A' ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;

    expect(() => verifyToken(`${payload}.${flipped}`)).toThrow(/invalid/i);
  });

  it('rejects a token signed with a different secret', () => {
    const foreign = withSecret(OTHER_SECRET, () => signToken({ u: USER_ID, e: RECIPIENT }));

    expect(() => verifyToken(foreign)).toThrow(/invalid/i);
  });

  it('rejects malformed tokens', () => {
    expect(() => verifyToken('')).toThrow(/invalid/i);
    expect(() => verifyToken('no-separator')).toThrow(/invalid/i);
    expect(() => verifyToken('.sig')).toThrow(/invalid/i);
    expect(() => verifyToken('payload.')).toThrow(/invalid/i);
    expect(() => verifyToken(null)).toThrow(/invalid/i);
  });
});

describe('POST /api/unsubscribe/:token', () => {
  it('is public — it records the unsubscribe with no Authorization header', async () => {
    const token = signToken({ u: USER_ID, e: RECIPIENT });

    const res = await request(createApp()).post(`/api/unsubscribe/${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unsubscribed: true });
    expect(getUser).not.toHaveBeenCalled();
  });

  it('inserts the user id and email carried by the token, on conflict do nothing', async () => {
    const token = signToken({ u: USER_ID, e: 'Sam@Corp.com' });

    await request(createApp()).post(`/api/unsubscribe/${token}`);

    expect(supabaseFrom).toHaveBeenCalledWith('unsubscribes');
    expect(upsert).toHaveBeenCalledWith(
      { user_id: USER_ID, email: RECIPIENT },
      { onConflict: 'user_id,email', ignoreDuplicates: true }
    );
  });

  it('400s on an invalid token and writes nothing', async () => {
    const res = await request(createApp()).post('/api/unsubscribe/not-a-real-token');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('400s on a token signed with a different secret', async () => {
    const foreign = withSecret(OTHER_SECRET, () => signToken({ u: USER_ID, e: RECIPIENT }));

    const res = await request(createApp()).post(`/api/unsubscribe/${foreign}`);

    expect(res.status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('400s when the signed payload is missing the user id or email', async () => {
    const noEmail = signToken({ u: USER_ID });

    const res = await request(createApp()).post(`/api/unsubscribe/${noEmail}`);

    expect(res.status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('500s with a generic {error} when the write fails', async () => {
    upsert.mockResolvedValue({ data: null, error: { message: 'db down' } });
    const token = signToken({ u: USER_ID, e: RECIPIENT });

    const res = await request(createApp()).post(`/api/unsubscribe/${token}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Could not record the unsubscribe' });
  });

  it('never logs the unsubscribed address', async () => {
    const token = signToken({ u: USER_ID, e: RECIPIENT });

    await request(createApp()).post(`/api/unsubscribe/${token}`);

    const calls = [
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls
    ];
    for (const call of calls) {
      expect(JSON.stringify(call)).not.toContain(RECIPIENT);
    }

    expect(logger.info).toHaveBeenCalledWith('unsubscribed', { userId: USER_ID });
  });
});
