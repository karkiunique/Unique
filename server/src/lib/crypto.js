import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for the two things that must never sit plaintext in the DB
 * (CLAUDE.md, Security): Gmail refresh tokens and voice exemplars.
 *
 * Blob layout, base64 encoded: [version:1][iv:12][authTag:16][ciphertext:...]
 * The version byte prefix exists so TOKEN_ENC_KEY can be rotated later without
 * having to guess how an existing record was written.
 */

const ALGORITHM = 'aes-256-gcm';
const CIPHER_VERSION = 1;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Read the key lazily on every call: importing this module (or running
 * `node --check`) must never require env vars to be present.
 */
function loadKey() {
  const raw = process.env.TOKEN_ENC_KEY;
  if (!raw || typeof raw !== 'string') {
    throw new Error('Missing TOKEN_ENC_KEY in the environment');
  }

  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error('TOKEN_ENC_KEY must be 32 bytes, base64-encoded');
  }

  return key;
}

/** Encrypt a UTF-8 string. Returns the versioned base64 blob to store. */
export function encrypt(plaintext) {
  if (typeof plaintext !== 'string') {
    throw new Error('encrypt() expects a string');
  }

  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([Buffer.from([CIPHER_VERSION]), iv, tag, ciphertext]).toString('base64');
}

/**
 * Decrypt a blob produced by encrypt(). Any failure (wrong key, tampered bytes,
 * truncated blob) throws a generic error — it never echoes the input or plaintext.
 */
export function decrypt(blob) {
  if (typeof blob !== 'string' || blob.length === 0) {
    throw new Error('decrypt() expects a non-empty string');
  }

  const key = loadKey();
  const raw = Buffer.from(blob, 'base64');
  if (raw.length < 1 + IV_BYTES + TAG_BYTES) {
    throw new Error('Could not decrypt: malformed ciphertext');
  }
  if (raw[0] !== CIPHER_VERSION) {
    throw new Error('Could not decrypt: unsupported ciphertext version');
  }

  const iv = raw.subarray(1, 1 + IV_BYTES);
  const tag = raw.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(1 + IV_BYTES + TAG_BYTES);

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Generic on purpose: the underlying error must not leak key or plaintext material.
    throw new Error('Could not decrypt: wrong key or tampered ciphertext');
  }
}
