import { describe, it, expect, vi, afterEach } from 'vitest';
import { sanitizeMeta, logger } from '../src/lib/logger.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sanitizeMeta', () => {
  it('keeps allowlisted fields', () => {
    expect(sanitizeMeta({ userId: 'user-1', status: 200 })).toEqual({
      userId: 'user-1',
      status: 200
    });
  });

  it('drops fields that are not allowlisted (e.g. email bodies)', () => {
    const result = sanitizeMeta({
      body: 'Hey Sam, following up on our chat about pricing.',
      subject: 'quick note',
      userId: 'user-1'
    });

    expect(result).toEqual({ userId: 'user-1' });
  });

  it('redacts token-shaped values even on allowlisted fields', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop';
    expect(sanitizeMeta({ reason: jwt }).reason).toBe('[redacted]');
    expect(sanitizeMeta({ reason: 'Bearer abc123' }).reason).toBe('[redacted]');
  });

  it('truncates long strings', () => {
    const long = 'lorem ipsum dolor '.repeat(40);
    const result = sanitizeMeta({ reason: long });

    expect(result.reason.length).toBeLessThanOrEqual(201);
    expect(result.reason.length).toBeLessThan(long.length);
  });

  it('redacts non-scalar values', () => {
    expect(sanitizeMeta({ reason: { nested: 'object' } }).reason).toBe('[redacted]');
  });

  it('returns an empty object for missing or non-object meta', () => {
    expect(sanitizeMeta()).toEqual({});
    expect(sanitizeMeta('string')).toEqual({});
  });
});

describe('logger', () => {
  it('writes a single structured JSON line without disallowed fields', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    logger.info('server_started', { port: 3000, body: 'secret email body' });

    expect(spy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(spy.mock.calls[0][0]);
    expect(parsed.level).toBe('info');
    expect(parsed.event).toBe('server_started');
    expect(parsed.port).toBe(3000);
    expect(parsed.body).toBeUndefined();
  });

  it('sends errors to console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logger.error('request_failed', { status: 500 });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(spy.mock.calls[0][0]).level).toBe('error');
  });
});
