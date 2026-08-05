import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const { getUser } = vi.hoisted(() => ({ getUser: vi.fn() }));

// No real network in tests: Supabase is fully mocked.
vi.mock('../src/lib/supabase.js', () => ({
  getSupabaseAdmin: () => ({ auth: { getUser } }),
  resetSupabaseAdmin: () => {}
}));

vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  sanitizeMeta: (meta) => meta
}));

const { createApp } = await import('../src/app.js');
const { logger } = await import('../src/lib/logger.js');

beforeEach(() => {
  getUser.mockReset();
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
});

describe('GET /api/health', () => {
  it('is public and returns ok', async () => {
    const res = await request(createApp()).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('voicereach-server');
    expect(typeof res.body.timestamp).toBe('string');
  });

  it('sets helmet security headers', async () => {
    const res = await request(createApp()).get('/api/health');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('GET /api/me', () => {
  it('401s without a token', async () => {
    const res = await request(createApp()).get('/api/me');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Missing or malformed Authorization header' });
  });

  it('401s with an invalid token', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { message: 'bad jwt' } });

    const res = await request(createApp()).get('/api/me').set('Authorization', 'Bearer nope');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid or expired token' });
  });

  it('returns the authenticated user', async () => {
    getUser.mockResolvedValue({
      data: { user: { id: 'user-abc', email: 'dev@example.com' } },
      error: null
    });

    const res = await request(createApp()).get('/api/me').set('Authorization', 'Bearer good.jwt');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user: { id: 'user-abc', email: 'dev@example.com' } });
  });
});

describe('POST /api/gmail/connect', () => {
  it('401s without a token', async () => {
    const res = await request(createApp()).post('/api/gmail/connect');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Missing or malformed Authorization header' });
  });
});

describe('GET /api/gmail/callback', () => {
  it('is public but 400s without a code and state', async () => {
    const res = await request(createApp()).get('/api/gmail/callback');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing authorization code or state' });
  });

  it('400s when Google reports an error', async () => {
    const res = await request(createApp()).get('/api/gmail/callback?error=access_denied');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Google denied the authorization request' });
  });
});

describe('voice routes', () => {
  it('401s on POST /api/voice/generate without a token', async () => {
    const res = await request(createApp()).post('/api/voice/generate');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Missing or malformed Authorization header' });
  });

  it('401s on GET /api/voice without a token', async () => {
    const res = await request(createApp()).get('/api/voice');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Missing or malformed Authorization header' });
  });
});

describe('app hardening', () => {
  it('returns JSON {error} for unknown routes', async () => {
    const res = await request(createApp()).get('/api/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it('returns 400 {error} for malformed JSON bodies', async () => {
    const res = await request(createApp())
      .post('/api/me')
      .set('Content-Type', 'application/json')
      .send('{"broken":');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid JSON body' });
  });

  it('does not send CORS headers to a disallowed origin', async () => {
    const res = await request(createApp())
      .get('/api/health')
      .set('Origin', 'https://evil.example.com');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows the configured APP_URL origin', async () => {
    const previous = process.env.APP_URL;
    process.env.APP_URL = 'http://localhost:5173';

    const res = await request(createApp())
      .get('/api/health')
      .set('Origin', 'http://localhost:5173');

    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');

    process.env.APP_URL = previous;
  });
});
