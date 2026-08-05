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
// Gmail answers 401/403 once the grant is gone; other 4xx are ordinary rejections.
const REVOKED_STATUSES = new Set([401, 403]);

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

/** Best effort: the send failure is what the caller actually needs to hear about. */
async function markGmailDisconnected(userId) {
  try {
    await getSupabaseAdmin().from('profiles').update({ gmail_connected: false }).eq('id', userId);
  } catch {
    logger.error('gmail_disconnect_flag_failed', { userId, status: 500 });
  }
}

/** Always throws. Google's own message is never echoed — it can quote the message. */
async function raiseGmailError(userId, err) {
  const status = gmailStatus(err);

  if (REVOKED_STATUSES.has(status)) {
    await markGmailDisconnected(userId);
    logger.error('gmail_auth_revoked', { userId, status });
    throw httpError(400, 'Gmail access was revoked, please reconnect Gmail');
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
