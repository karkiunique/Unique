import { google } from 'googleapis';

import { logger } from '../lib/logger.js';
import { httpError } from '../lib/httpError.js';
import { getAuthedClient } from './gmail.js';
import { extractPlainTextBody } from './gmailParse.js';
import { listSentThreadIds, ownsThread } from './sendLog.js';

/**
 * The register: the mail the user sent FROM UNIQUE, plus its reply state.
 *
 * Thread ids come from `send_log` (migration 003), never from an `in:sent` search.
 * That is the whole "ours only" guarantee — a mailbox search cannot tell a message
 * we sent apart from one the user wrote in Gmail themselves, so it used to list
 * their personal mail too (CLAUDE.md Decisions, 2026-08-06).
 *
 * Nothing here is persisted. Subject, recipient and reply state are fetched from
 * Gmail per request and stay in memory; the listing reads metadata headers only.
 * The detail view does read bodies — one thread, on demand, shown to the person
 * who wrote it — and still writes nothing and logs nothing but ids and counts.
 * Nothing is labelled, so this works under gmail.readonly with no gmail.modify.
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

function resolveLimit(requested) {
  const parsed = Number(requested);

  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(Math.floor(parsed), MAX_LIMIT)
    : DEFAULT_LIMIT;
}

/**
 * Case-insensitive substring match over subject and recipient, in memory.
 *
 * Applied AFTER the Gmail fetch and never persisted or logged: the query names
 * who the user is looking for, so it is recipient data (CLAUDE.md § Privacy).
 */
function matchesQuery(thread, needle) {
  if (needle === '') return true;

  const haystack = `${thread.subject ?? ''} ${thread.to ?? ''}`.toLowerCase();

  return haystack.includes(needle);
}

async function connectedGmail(userId) {
  const auth = await getAuthedClient(userId);

  return google.gmail({ version: 'v1', auth });
}

async function readSelfAddress(gmail) {
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const selfAddress = extractAddress(profile?.data?.emailAddress);

  if (selfAddress === '') throw httpError(502, 'Could not read the connected Gmail address');

  return selfAddress;
}

/** Recent threads WE sent, with their reply state. Persists nothing. */
export async function listSentThreads(userId, options = {}) {
  if (typeof userId !== 'string' || userId === '') {
    throw httpError(400, 'A userId is required');
  }

  const limit = resolveLimit(options.limit);
  const needle = typeof options.query === 'string' ? options.query.trim().toLowerCase() : '';

  const threadIds = await listSentThreadIds(userId, limit);
  if (threadIds.length === 0) return [];

  const gmail = await connectedGmail(userId);
  const selfAddress = await readSelfAddress(gmail);

  const threads = [];
  for (const id of threadIds) {
    let data;
    try {
      const res = await gmail.users.threads.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: METADATA_HEADERS
      });
      data = res?.data;
    } catch {
      // Deleted in Gmail since we sent it. One stale row must not take the whole
      // register down — skip it. Ids only in the log line.
      logger.warn('sent_thread_unavailable', { userId, threadId: id });
      continue;
    }

    if (!data) continue;

    const summary = summarizeThread({ ...data, id: data.id ?? id }, selfAddress);
    if (matchesQuery(summary, needle)) threads.push(summary);
  }

  // Counts only — no subject, no recipient, no body, and never the search query.
  logger.info('sent_threads_listed', { userId, count: threads.length });

  return threads;
}

function toThreadMessage(message, selfAddress) {
  const from = header(message, 'from');

  return {
    id: typeof message?.id === 'string' ? message.id : null,
    // The RFC 2822 Message-ID, which a follow-up needs for its In-Reply-To header.
    messageId: header(message, 'message-id'),
    from,
    to: header(message, 'to'),
    subject: header(message, 'subject'),
    sentAt: sentAtOf(message),
    fromSelf: extractAddress(from) === selfAddress,
    // Shown as it was actually sent and received — the ingestion cleaner strips
    // quotes and signatures, which is wrong for a conversation the user is reading.
    body: extractPlainTextBody(message?.payload)
  };
}

/**
 * One thread in full, bodies included, for the detail view and the follow-up flow.
 *
 * The send_log check comes FIRST and Gmail is not touched without it: it is what
 * stops one user reading another's mail by guessing a thread id. A thread that is
 * not in this user's send history does not exist as far as this endpoint is
 * concerned.
 *
 * Bodies are returned to the user for display. They are never persisted and never
 * logged (CLAUDE.md Decisions, 2026-08-06).
 */
export async function getSentThread(userId, threadId) {
  if (typeof userId !== 'string' || userId === '') {
    throw httpError(400, 'A userId is required');
  }
  if (typeof threadId !== 'string' || threadId.trim() === '') {
    throw httpError(400, 'A threadId is required');
  }

  const id = threadId.trim();

  if (!(await ownsThread(userId, id))) throw httpError(404, 'Thread not found');

  const gmail = await connectedGmail(userId);
  const selfAddress = await readSelfAddress(gmail);

  let data;
  try {
    const res = await gmail.users.threads.get({ userId: 'me', id, format: 'full' });
    data = res?.data;
  } catch {
    // Never echo Gmail's message — it can quote the subject.
    throw httpError(404, 'Thread not found');
  }

  const raw = Array.isArray(data?.messages) ? data.messages : [];
  const messages = raw.map((message) => toThreadMessage(message, selfAddress));

  // Ids and a count. Never a subject, recipient or body.
  logger.info('sent_thread_read', { userId, threadId: id, count: messages.length });

  return { threadId: id, messages };
}
