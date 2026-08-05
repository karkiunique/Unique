import { createHmac, timingSafeEqual } from 'node:crypto';

import { httpError } from './httpError.js';

/**
 * HMAC-SHA256 signed unsubscribe tokens (CLAUDE.md, Security).
 *
 * The token carries its own payload, so verification needs no DB lookup: the
 * public unsubscribe route can be hit by anyone and still cannot be enumerated
 * or forged. Layout, both halves base64url so the token is URL-safe:
 *
 *   base64url(JSON payload) . base64url(HMAC-SHA256 of that first half)
 *
 * Neither half can contain '.', so the split is unambiguous.
 */

const SEPARATOR = '.';
const INVALID = 'Invalid unsubscribe token';

/** Read lazily: importing this module must never require env vars to be set. */
function loadSecret() {
  const secret = process.env.UNSUB_SECRET;
  if (typeof secret !== 'string' || secret.trim() === '') {
    throw new Error('Missing UNSUB_SECRET in the environment');
  }
  return secret;
}

function sign(encodedPayload) {
  return createHmac('sha256', loadSecret()).update(encodedPayload).digest('base64url');
}

/** Sign an object payload. The payload is public — never put a secret in it. */
export function signToken(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('signToken() expects an object payload');
  }

  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

  return `${encoded}${SEPARATOR}${sign(encoded)}`;
}

/**
 * Constant-time signature comparison. Lengths are compared first because
 * timingSafeEqual throws on a mismatch, and a base64url SHA-256 digest is always
 * the same length anyway, so nothing useful leaks from that branch.
 */
function signaturesMatch(expected, provided) {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Returns the payload, or throws. Every failure mode — malformed, tampered,
 * signed with another secret — raises the same generic error on purpose: the
 * reason is a free oracle for anyone probing tokens.
 */
export function verifyToken(token) {
  if (typeof token !== 'string' || token === '') throw httpError(400, INVALID);

  const index = token.indexOf(SEPARATOR);
  if (index <= 0 || index >= token.length - 1) throw httpError(400, INVALID);

  const encoded = token.slice(0, index);
  const provided = token.slice(index + 1);

  if (!signaturesMatch(sign(encoded), provided)) throw httpError(400, INVALID);

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw httpError(400, INVALID);
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw httpError(400, INVALID);
  }

  return payload;
}
