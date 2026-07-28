import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getUser } = vi.hoisted(() => ({ getUser: vi.fn() }));

// Never touch real Supabase in tests.
vi.mock('../src/lib/supabase.js', () => ({
  getSupabaseAdmin: () => ({ auth: { getUser } }),
  resetSupabaseAdmin: () => {}
}));

vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  sanitizeMeta: (meta) => meta
}));

const { requireAuth, extractBearerToken } = await import('../src/middleware/auth.js');

function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = vi.fn((code) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((payload) => {
    res.body = payload;
    return res;
  });
  return res;
}

function mockReq(authorization) {
  return {
    headers: authorization === undefined ? {} : { authorization },
    path: '/api/me',
    method: 'GET'
  };
}

beforeEach(() => {
  getUser.mockReset();
});

describe('extractBearerToken', () => {
  it('returns the token for a well-formed header', () => {
    expect(extractBearerToken(mockReq('Bearer abc.def.ghi'))).toBe('abc.def.ghi');
  });

  it('is case-insensitive on the scheme', () => {
    expect(extractBearerToken(mockReq('bearer abc'))).toBe('abc');
  });

  it('returns null when the header is missing', () => {
    expect(extractBearerToken(mockReq())).toBeNull();
  });

  it('returns null for a non-bearer scheme', () => {
    expect(extractBearerToken(mockReq('Basic abc'))).toBeNull();
  });

  it('returns null when the scheme has no token', () => {
    expect(extractBearerToken(mockReq('Bearer'))).toBeNull();
  });

  it('returns null when there are extra segments', () => {
    expect(extractBearerToken(mockReq('Bearer a b'))).toBeNull();
  });

  it('tolerates a request with no headers object', () => {
    expect(extractBearerToken({})).toBeNull();
  });
});

describe('requireAuth', () => {
  it('401s when no Authorization header is present', async () => {
    const res = mockRes();
    const next = vi.fn();

    await requireAuth(mockReq(), res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Missing or malformed Authorization header' });
    expect(next).not.toHaveBeenCalled();
    expect(getUser).not.toHaveBeenCalled();
  });

  it('401s when Supabase rejects the token', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { message: 'bad jwt' } });
    const res = mockRes();
    const next = vi.fn();

    await requireAuth(mockReq('Bearer expired.token'), res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid or expired token' });
    expect(next).not.toHaveBeenCalled();
  });

  it('401s when Supabase returns no user', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null });
    const res = mockRes();
    const next = vi.fn();

    await requireAuth(mockReq('Bearer whatever'), res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('attaches req.user and calls next on a valid token', async () => {
    getUser.mockResolvedValue({
      data: { user: { id: 'user-123', email: 'dev@example.com' } },
      error: null
    });
    const req = mockReq('Bearer valid.jwt.token');
    const res = mockRes();
    const next = vi.fn();

    await requireAuth(req, res, next);

    expect(getUser).toHaveBeenCalledWith('valid.jwt.token');
    expect(req.user).toEqual({ id: 'user-123', email: 'dev@example.com' });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('500s without leaking details when verification throws', async () => {
    getUser.mockRejectedValue(new Error('network down: token=valid.jwt.token'));
    const res = mockRes();
    const next = vi.fn();

    await requireAuth(mockReq('Bearer valid.jwt.token'), res, next);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Could not verify credentials' });
    expect(JSON.stringify(res.body)).not.toContain('valid.jwt.token');
    expect(next).not.toHaveBeenCalled();
  });
});
