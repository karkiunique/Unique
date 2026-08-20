import { getSupabaseAdmin } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';

/**
 * The daily run record — the idempotency guard for a cron with no broker
 * (CLAUDE.md, Decisions 2026-08-16).
 *
 * BullMQ would dedupe a repeated job for us. A cron does not, and a cron is what
 * this is: at two leads per user per day, a queue would be machinery bought for
 * nothing. So the guard is a unique `(user_id, run_date)` in the database, and
 * `claimRun` is the only way to start work.
 *
 * THE ORDER MATTERS. The row is INSERTED BEFORE ANY WORK BEGINS, and the insert
 * itself is the claim — not a SELECT-then-INSERT, which races with itself and
 * would let two concurrent invocations both decide they were first. A duplicate
 * key here is the expected, correct outcome of a second run, never an error to
 * report.
 */

// Postgres unique violation. A second claim on the same day hits this, and it is
// a NORMAL result: it means someone else already has the day.
const UNIQUE_VIOLATION = '23505';

function runsTable() {
  return getSupabaseAdmin().from('daily_runs');
}

/** UTC. Timezones are a Phase-later problem and CLAUDE.md already says UTC for now. */
export function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Claim the day for one user.
 *
 * Returns the run when this caller won the claim, or `null` when the day is
 * already taken — the caller must then do nothing at all. Null is not a failure
 * and must never be logged or reported as one.
 */
export async function claimRun(userId, runDate = today()) {
  const { data, error } = await runsTable()
    .insert({ user_id: userId, run_date: runDate, status: 'running' })
    .select('id, user_id, run_date, status, notified_at')
    .single();

  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      // Already claimed. The correct behaviour is silence and no work.
      logger.info('daily_run_already_claimed', { userId });
      return null;
    }

    logger.error('daily_run_claim_failed', { userId, status: 500 });
    throw new Error('could not claim the daily run');
  }

  return data;
}

/**
 * Finish a run that produced drafts.
 *
 * `notified_at` is deliberately NOT set here. Delivering drafts and telling the
 * user about them are separate facts: a run that drafted successfully but could
 * not reach Postmark must be retryable for the notification alone, without
 * re-drafting anything.
 */
export async function completeRun(runId, { candidatesScreened, leadsDelivered }) {
  const status = leadsDelivered > 0 ? 'delivered' : 'empty';

  const { error } = await runsTable()
    .update({
      status,
      candidates_screened: candidatesScreened,
      leads_delivered: leadsDelivered
    })
    .eq('id', runId);

  if (error) throw new Error('could not complete the daily run');

  // 'empty' is a SUCCESS. A run that found nothing good enough did its job — the
  // ceiling-not-quota rule means delivering nothing beats delivering a weak lead.
  logger.info('daily_run_complete', { count: leadsDelivered, reason: status });

  return status;
}

/** Record that the user was told. Separate write, on purpose — see completeRun. */
export async function markNotified(runId) {
  const { error } = await runsTable()
    .update({ notified_at: new Date().toISOString() })
    .eq('id', runId);

  if (error) throw new Error('could not mark the daily run notified');
}

/**
 * Mark a run failed so tomorrow's invocation is not blocked by a half-finished
 * row, and so a human can see the day went wrong.
 *
 * Never throws: this runs inside a catch, and a failure to record a failure must
 * not replace the original error.
 */
export async function failRun(runId, userId) {
  try {
    await runsTable().update({ status: 'failed' }).eq('id', runId);
  } catch {
    // Swallowed deliberately — see above.
  }

  logger.error('daily_run_failed', { userId, status: 500 });
}
