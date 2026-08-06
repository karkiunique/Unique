import { google } from 'googleapis';

import { getSupabaseAdmin } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { httpError } from '../lib/httpError.js';
import { getAuthedClient } from './gmail.js';

/**
 * Sending one confirmed email through the user's own Gmail account.
 *
 * This module deliberately knows nothing about confirmation: the gate lives in
 * routes/send.js, server-side, and nothing reaches sendEmail() without it. What
 * this module guarantees instead is that the bytes it sends are the bytes it was
 * handed — no rewriting, no regeneration, no re-fetch.
 *
 * Logs carry {userId} and Gmail ids only. Recipient, subject and body never
 * reach a log line or an error message.
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Printable US-ASCII. Anything outside it needs RFC 2047 encoding in a header.
const ASCII_PRINTABLE = /^[\x20-\x7E]*$/;
/**
 * How a Gmail 4xx should be treated. 403 is overloaded — it covers a token that
 * predates a scope we now need AND ordinary rate limiting — so it is classified
 * before anything acts on it. Disconnecting on a rate limit would cost the user
 * a full re-consent for a condition that clears on its own.
 */
export const GMAIL_FAILURE = {
  REVOKED: 'revoked',
  INSUFFICIENT_SCOPE: 'insufficient_scope',
  RATE_LIMITED: 'rate_limited',
  OTHER: 'other'
};

/**
 * The recovery the client should offer, as a stable code. The UI keys off this,
 * never off the wording of the message: prose gets rewritten, and a client that
 * pattern-matches English silently loses the recovery path when it does.
 */
export const RECONNECT_ACTION = 'reconnect_gmail';

const SCOPE_REASONS = new Set(['insufficientpermissions', 'access_token_scope_insufficient']);
const RATE_REASONS = new Set(['ratelimitexceeded', 'userratelimitexceeded', 'dailylimitexceeded']);
// Narrow on purpose: an unmatched message falls through to the conservative branch.
const SCOPE_MESSAGE = /insufficient authentication scopes|insufficient permission/i;
const RATE_MESSAGE = /rate limit exceeded|daily limit exceeded/i;

/** CR/LF in a header value is header injection. Collapse it before it is written. */
function sanitizeHeader(value) {
  return String(value).replace(/[\r\n]+/g, ' ').trim();
}

/** RFC 2047 encoded-word, applied only when the value is not plain ASCII. */
export function encodeHeaderValue(value) {
  const clean = sanitizeHeader(value);
  if (ASCII_PRINTABLE.test(clean)) return clean;

  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

/**
 * RFC 2822 message as a string. Pure and exported so the exact wire format is
 * directly testable without touching Gmail.
 */
export function buildMimeMessage(message = {}) {
  const from = sanitizeHeader(message.from ?? '');
  const to = sanitizeHeader(message.to ?? '');
  const subject = message.subject ?? '';
  const body = message.body ?? '';

  if (from === '' || to === '' || String(subject).trim() === '' || String(body).trim() === '') {
    throw httpError(400, 'from, to, subject and body are all required to build a message');
  }

  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeaderValue(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit'
  ];

  const normalizedBody = String(body).replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');

  return `${headers.join('\r\n')}\r\n\r\n${normalizedBody}`;
}

function gmailStatus(err) {
  return Number(err?.status ?? err?.code ?? err?.response?.status) || 0;
}

/** Every level of a googleapis error can be missing. Collect what is there, throw nothing. */
function collectErrorReasons(err) {
  const googleError = err?.response?.data?.error;
  const reasons = [];

  for (const group of [err?.errors, googleError?.errors, googleError?.details]) {
    if (!Array.isArray(group)) continue;
    for (const entry of group) {
      if (typeof entry?.reason === 'string') reasons.push(entry.reason.toLowerCase());
    }
  }
  if (typeof googleError?.status === 'string') reasons.push(googleError.status.toLowerCase());

  return reasons;
}

/**
 * Which kind of failure this is, as an internal value. Google's own message is
 * read here but never leaves this function — it can echo request content
 * (CLAUDE.md § Privacy), so callers get an enum, not text.
 */
export function classifyGmailFailure(err) {
  const status = gmailStatus(err);

  if (status === 401) return GMAIL_FAILURE.REVOKED;
  if (status !== 403) return GMAIL_FAILURE.OTHER;

  const reasons = collectErrorReasons(err);
  if (reasons.some((reason) => SCOPE_REASONS.has(reason))) return GMAIL_FAILURE.INSUFFICIENT_SCOPE;
  if (reasons.some((reason) => RATE_REASONS.has(reason))) return GMAIL_FAILURE.RATE_LIMITED;

  const message = typeof err?.message === 'string' ? err.message : '';
  if (SCOPE_MESSAGE.test(message)) return GMAIL_FAILURE.INSUFFICIENT_SCOPE;
  if (RATE_MESSAGE.test(message)) return GMAIL_FAILURE.RATE_LIMITED;

  // Unrecognised 403: a wrong disconnect costs a full re-consent, a wrong
  // non-disconnect costs one retry. Leave the connection alone.
  return GMAIL_FAILURE.OTHER;
}

/** Best effort: the send failure is what the caller actually needs to hear about. */
async function markGmailDisconnected(userId) {
  try {
    await getSupabaseAdmin().from('profiles').update({ gmail_connected: false }).eq('id', userId);
  } catch {
    logger.error('gmail_disconnect_flag_failed', { userId, status: 500 });
  }
}

/** A failure the user can act on: the UI turns this into a Reconnect Gmail button. */
function reconnectError(message) {
  const err = httpError(400, message);
  err.action = RECONNECT_ACTION;
  return err;
}

/** Always throws. Google's own message is never echoed — it can quote the message. */
async function raiseGmailError(userId, err) {
  const status = gmailStatus(err);
  const failure = classifyGmailFailure(err);

  if (failure === GMAIL_FAILURE.REVOKED) {
    await markGmailDisconnected(userId);
    logger.error('gmail_auth_revoked', { userId, status });
    throw reconnectError('Gmail access was revoked, please reconnect Gmail');
  }

  if (failure === GMAIL_FAILURE.INSUFFICIENT_SCOPE) {
    // The grant is intact, it just predates a scope we now need. Re-consent is
    // the recovery path, and the error carries it as an action so the UI can
    // offer the button instead of describing it. Nothing was revoked, so the
    // wording must not say so.
    await markGmailDisconnected(userId);
    logger.error('gmail_scope_insufficient', { userId, status });
    throw reconnectError('Gmail needs re-approval for a new permission, please reconnect Gmail');
  }

  if (failure === GMAIL_FAILURE.RATE_LIMITED) {
    // Transient and retryable — the connection stays exactly as it was.
    logger.error('gmail_rate_limited', { userId, status });
    throw httpError(429, 'Gmail is rate limiting sends right now, please try again shortly');
  }

  logger.error('gmail_send_failed', { userId, status: status || 502 });
  throw httpError(502, 'Gmail rejected the message');
}

/**
 * Send exactly this subject and body to exactly this recipient, from the
 * connected account. Returns the Gmail ids so reply detection can find the thread.
 */
export async function sendEmail(userId, input = {}) {
  if (typeof userId !== 'string' || userId === '') {
    throw httpError(400, 'A userId is required');
  }

  const to = typeof input.to === 'string' ? input.to.trim() : '';
  const subject = typeof input.subject === 'string' ? input.subject.trim() : '';
  const body = typeof input.body === 'string' ? input.body : '';

  if (!EMAIL_PATTERN.test(to)) {
    throw httpError(400, 'A valid recipient email address is required');
  }
  if (subject === '') throw httpError(400, 'A subject is required');
  if (body.trim() === '') throw httpError(400, 'A body is required');

  const auth = await getAuthedClient(userId);
  const gmail = google.gmail({ version: 'v1', auth });

  let from = '';
  try {
    const profile = await gmail.users.getProfile({ userId: 'me' });
    from = typeof profile?.data?.emailAddress === 'string' ? profile.data.emailAddress : '';
  } catch (err) {
    await raiseGmailError(userId, err);
  }
  if (from === '') throw httpError(502, 'Could not read the connected Gmail address');

  const raw = Buffer.from(buildMimeMessage({ from, to, subject, body }), 'utf8').toString(
    'base64url'
  );

  let response;
  try {
    response = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  } catch (err) {
    await raiseGmailError(userId, err);
  }

  const messageId = typeof response?.data?.id === 'string' ? response.data.id : null;
  const threadId = typeof response?.data?.threadId === 'string' ? response.data.threadId : null;

  logger.info('email_sent', { userId, messageId, threadId });

  return { messageId, threadId };
}
