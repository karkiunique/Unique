import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { encrypt, decrypt } from '../src/lib/crypto.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64');

let previousKey;

beforeEach(() => {
  previousKey = process.env.TOKEN_ENC_KEY;
  process.env.TOKEN_ENC_KEY = KEY;
});

afterEach(() => {
  if (previousKey === undefined) {
    delete process.env.TOKEN_ENC_KEY;
  } else {
    process.env.TOKEN_ENC_KEY = previousKey;
  }
});

function tamper(blob) {
  const raw = Buffer.from(blob, 'base64');
  raw[raw.length - 1] ^= 0xff;
  return raw.toString('base64');
}

describe('encrypt / decrypt', () => {
  it('round-trips a value', () => {
    const secret = '1//0gRefreshTokenFromGoogle-abc123';

    expect(decrypt(encrypt(secret))).toBe(secret);
  });

  it('round-trips unicode and multi-line JSON', () => {
    const payload = JSON.stringify(['hey — quick one\n\nthanks, Ana', 'ok?']);

    expect(decrypt(encrypt(payload))).toBe(payload);
  });

  it('round-trips an empty string', () => {
    expect(decrypt(encrypt(''))).toBe('');
  });

  it('never stores the plaintext in the blob', () => {
    const blob = encrypt('1//0gRefreshTokenFromGoogle-abc123');

    expect(blob).not.toContain('RefreshToken');
    expect(Buffer.from(blob, 'base64').toString('utf8')).not.toContain('RefreshToken');
  });

  it('produces a different ciphertext each time for identical input (random IV)', () => {
    const first = encrypt('same-input');
    const second = encrypt('same-input');

    expect(first).not.toBe(second);
    expect(decrypt(first)).toBe('same-input');
    expect(decrypt(second)).toBe('same-input');
  });

  it('prefixes the blob with the v1 version byte', () => {
    const raw = Buffer.from(encrypt('anything'), 'base64');

    expect(raw[0]).toBe(1);
    // version(1) + iv(12) + tag(16) = 29 bytes of envelope.
    expect(raw.length).toBeGreaterThan(29);
  });

  it('rejects a tampered blob', () => {
    const blob = encrypt('gmail-refresh-token');

    expect(() => decrypt(tamper(blob))).toThrow(/could not decrypt/i);
  });

  it('rejects a blob encrypted under a different key', () => {
    const blob = encrypt('gmail-refresh-token');
    process.env.TOKEN_ENC_KEY = OTHER_KEY;

    expect(() => decrypt(blob)).toThrow(/could not decrypt/i);
  });

  it('does not echo plaintext in the failure message', () => {
    const blob = encrypt('super-secret-refresh-token');
    process.env.TOKEN_ENC_KEY = OTHER_KEY;

    try {
      decrypt(blob);
      throw new Error('decrypt should have thrown');
    } catch (err) {
      expect(err.message).not.toContain('super-secret-refresh-token');
      expect(err.message).not.toContain(blob);
    }
  });

  it('rejects an unknown version byte', () => {
    const raw = Buffer.from(encrypt('value'), 'base64');
    raw[0] = 9;

    expect(() => decrypt(raw.toString('base64'))).toThrow(/version/i);
  });

  it('rejects a truncated blob', () => {
    expect(() => decrypt(Buffer.alloc(10).toString('base64'))).toThrow(/malformed/i);
  });

  it('rejects non-string inputs', () => {
    expect(() => encrypt(null)).toThrow(/string/i);
    expect(() => decrypt('')).toThrow(/string/i);
  });

  it('throws a clear error when TOKEN_ENC_KEY is missing', () => {
    delete process.env.TOKEN_ENC_KEY;

    expect(() => encrypt('value')).toThrow(/TOKEN_ENC_KEY/);
    expect(() => decrypt('anything')).toThrow(/TOKEN_ENC_KEY/);
  });

  it('throws a clear error when TOKEN_ENC_KEY is the wrong length', () => {
    process.env.TOKEN_ENC_KEY = Buffer.alloc(16, 3).toString('base64');

    expect(() => encrypt('value')).toThrow(/32 bytes/);
  });
});
