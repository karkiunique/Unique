import { getSupabaseAdmin } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { httpError } from '../lib/httpError.js';

/**
 * The register's source of truth: the Gmail ids of the mail WE sent.
 *
 * This module exists so "only mail sent from Unique" is expressible at all. The
 * listing reads thread ids from here instead of searching the mailbox, and the
 * detail/follow-up paths use it as the authorization check — a thread the user
 * did not send from Unique is not theirs to read through us.
 *
 * IDS ONLY (migration 003). No subject, no recipient, no body ever reaches this
 * table; those are fetched from Gmail per request and stay in memory.
 *
 * Split out of send.js and threads.js so both can use it without an import cycle.
 */

// Follow-ups add a row per message, so the newest N rows are fewer than N threads.
// Over-fetch, then dedupe in memory and cut back to the caller's limit.
const ROWS_PER_THREAD_ALLOWANCE = 4;

function sendLogTable() {
  return getSupabaseAdmin().from('send_log');
}

/**
 * Record one send. FAILS OPEN, deliberately: by the time this runs the message
 * has ALREADY left the user's mailbox. Turning a bookkeeping failure into a send
 * failure would tell the user their mail did not go out when it did, and invite
 * them to send it twice. A missing row costs one thread on the register.
 */
export async function recordSend(userId, ids = {}) {
  const messageId = typeof ids.messageId === 'string' ? ids.messageId : null;
  const threadId = typeof ids.threadId === 'string' ? ids.threadId : null;

  if (!messageId) return false;

  try {
    // on conflict do nothing (unique index on user_id, gmail_message_id): a retry
    // after a send that actually succeeded must not create a second row.
    const { error } = await sendLogTable().upsert(
      { user_id: userId, lead_id: null, gmail_message_id: messageId, gmail_thread_id: threadId },
      { onConflict: 'user_id,gmail_message_id', ignoreDuplicates: true }
    );

    if (error) throw error;

    return true;
  } catch {
    // Ids only — never the recipient, subject or body.
    logger.warn('send_log_write_failed', { userId, messageId, threadId });
    return false;
  }
}

/** Distinct thread ids this user sent from Unique, newest send first. */
export async function listSentThreadIds(userId, limit) {
  const { data, error } = await sendLogTable()
    .select('gmail_thread_id, sent_at')
    .eq('user_id', userId)
    .not('gmail_thread_id', 'is', null)
    .order('sent_at', { ascending: false })
    .limit(limit * ROWS_PER_THREAD_ALLOWANCE);

  if (error) throw httpError(500, 'Could not load your sent history');

  const seen = new Set();
  for (const row of Array.isArray(data) ? data : []) {
    const threadId = row?.gmail_thread_id;
    if (typeof threadId === 'string' && threadId !== '') seen.add(threadId);
    if (seen.size >= limit) break;
  }

  return [...seen];
}

/**
 * Does this thread belong to this user's send history?
 *
 * The control that stops one user reading another's mail by guessing a thread id.
 * Fails CLOSED: a lookup error throws rather than returning false-y in a way a
 * caller might read as "allowed".
 */
export async function ownsThread(userId, threadId) {
  if (typeof threadId !== 'string' || threadId === '') return false;

  const { data, error } = await sendLogTable()
    .select('id')
    .eq('user_id', userId)
    .eq('gmail_thread_id', threadId)
    .limit(1);

  if (error) throw httpError(500, 'Could not load your sent history');

  return Array.isArray(data) ? data.length > 0 : Boolean(data);
}
