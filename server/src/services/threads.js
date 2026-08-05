import { google } from 'googleapis';

import { logger } from '../lib/logger.js';
import { httpError } from '../lib/httpError.js';
import { getAuthedClient } from './gmail.js';

/**
 * Reply detection over the user's own sent threads (CLAUDE.md §5).
 *
 * Deliberately stateless: nothing here is written to the DB, so there is no
 * schema for it and no message content to leak. The reply state is derived from
 * Gmail on every read.
 *
 * It is NOT an inbox. The query is `in:sent`, messages are fetched with
 * format:'metadata' so no body ever crosses the wire, and nothing is labelled —
 * which is why this works under gmail.readonly with no gmail.modify grant.
 */

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const METADATA_HEADERS = ['Subject', 'To', 'From', 'Date'];

/** "Sam Rivera <sam@corp.com>" -> "sam@corp.com". Lowercased for comparison. */
export function extractAddress(value) {
  if (typeof value !== 'string') return '';

  const angled = value.match(/<([^>]+)>/);

  return (angled ? angled[1] : value).trim().toLowerCase();
}

function header(message, name) {
  const headers = message?.payload?.headers;
  if (!Array.isArray(headers)) return '';

  const found = headers.find(
    (entry) => typeof entry?.name === 'string' && entry.name.toLowerCase() === name
  );

  return typeof found?.value === 'string' ? found.value : '';
}

function sentAtOf(message) {
  const internal = Number(message?.internalDate);
  if (Number.isFinite(internal) && internal > 0) return new Date(internal).toISOString();

  const parsed = Date.parse(header(message, 'date'));

  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/**
 * A thread counts as replied when it holds more than one message AND at least
 * one of them came from somebody other than the authenticated user. Both halves
 * matter: a self-forward or a follow-up the user sent is not a reply.
 */
export function summarizeThread(thread, selfAddress) {
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  const first = messages[0] ?? null;
  const self = extractAddress(selfAddress);

  const fromOthers = messages.filter(
    (message) => extractAddress(header(message, 'from')) !== self
  );

  return {
    threadId: typeof thread?.id === 'string' ? thread.id : null,
    subject: header(first, 'subject'),
    to: extractAddress(header(first, 'to')),
    sentAt: sentAtOf(first),
    replied: messages.length > 1 && fromOthers.length > 0,
    replyCount: fromOthers.length
  };
}

/** Recent sent threads with their reply state. Persists nothing. */
export async function listSentThreads(userId, options = {}) {
  if (typeof userId !== 'string' || userId === '') {
    throw httpError(400, 'A userId is required');
  }

  const requested = Number(options.limit);
  const limit =
    Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), MAX_LIMIT)
      : DEFAULT_LIMIT;

  const auth = await getAuthedClient(userId);
  const gmail = google.gmail({ version: 'v1', auth });

  const profile = await gmail.users.getProfile({ userId: 'me' });
  const selfAddress = extractAddress(profile?.data?.emailAddress);
  if (selfAddress === '') throw httpError(502, 'Could not read the connected Gmail address');

  const list = await gmail.users.threads.list({ userId: 'me', q: 'in:sent', maxResults: limit });
  const ids = (Array.isArray(list?.data?.threads) ? list.data.threads : [])
    .map((entry) => entry?.id)
    .filter((id) => typeof id === 'string');

  const threads = [];
  for (const id of ids) {
    const res = await gmail.users.threads.get({
      userId: 'me',
      id,
      format: 'metadata',
      metadataHeaders: METADATA_HEADERS
    });

    const data = res?.data;
    if (!data) continue;

    threads.push(summarizeThread({ ...data, id: data.id ?? id }, selfAddress));
  }

  // Counts only — no subject, no recipient, no body.
  logger.info('sent_threads_listed', { userId, count: threads.length });

  return threads;
}
