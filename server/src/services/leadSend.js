import { getSupabaseAdmin } from '../lib/supabase.js';
import { httpError } from '../lib/httpError.js';
import { logger } from '../lib/logger.js';
import { selectSendableLeads } from './leadReview.js';
import { sendEmail } from './send.js';
import { FIDELITY_FLOOR } from './leadGates.js';

/**
 * Send ONE approved lead through the user's own Gmail (Decisions, 2026-08-19).
 *
 * The last step of the daily loop: the job drafts, a human reviews and approves,
 * and this is the only route from an approved lead to somebody's inbox. It sends
 * exactly one letter — the promise is that a person reads each one and sends it
 * themselves, and a route that sends many is a different promise.
 *
 * THREE GATES, ALL SERVER-SIDE.
 *
 *  1. APPROVAL. The lead is read through `selectSendableLeads` and this file never
 *     queries `leads` for the outgoing letter. That is BLOCKER 1's requirement: a
 *     re-query can return an identical row while bypassing the approval filter
 *     entirely, so the gate has to be the only door, not the usual one.
 *
 *  2. FIDELITY. The floor is enforced by reading `leads.fidelity_score`, which the
 *     server wrote at generation and no client can touch. The compose flow needs
 *     an HMAC for this because its draft lives only in the browser; a lead has a
 *     row, so a column does the job. The escape hatch is `edited_body`: once the
 *     human has rewritten it the words are theirs and the score is stale.
 *
 *  3. CONFIRMATION of the EXACT content. The caller sends the subject and body the
 *     human saw; this renders what it would actually send and refuses if they
 *     differ. A boolean `confirmed: true` cannot tell the difference between
 *     approving this letter and approving a different one.
 */

/** The columns the gate does NOT provide, and which only this file reads. */
const GATE_COLUMNS = 'id, campaign_id, fidelity_score, edited_body, status';

/**
 * Whether the fidelity floor lets this letter out.
 *
 * Returns a reason rather than a boolean so the route can say something true to
 * the user — "regenerate it" and "edit it yourself" are different instructions.
 */
export function fidelityVerdict(row) {
  // The human rewrote it. Their words, so the model's score no longer describes
  // what is being sent (§ 3). Never trap someone behind a number the model cannot
  // reach.
  if (typeof row?.edited_body === 'string' && row.edited_body.trim() !== '') {
    return { allowed: true, reason: 'edited' };
  }

  // Unscored is not passing. A letter that never went through the check has not
  // demonstrated anything.
  //
  // The null check is explicit and comes FIRST because `Number(null)` is 0, not
  // NaN — a missing score would otherwise read as a real score of zero and be
  // reported as "below the floor". Same refusal either way, but the user would be
  // told to redraft a letter that was never drafted-and-checked at all.
  const raw = row?.fidelity_score;
  if (raw === null || raw === undefined || raw === '') {
    return { allowed: false, reason: 'unscored' };
  }

  const score = Number(raw);
  if (!Number.isFinite(score)) return { allowed: false, reason: 'unscored' };

  if (score < FIDELITY_FLOOR) return { allowed: false, reason: 'below_floor' };

  return { allowed: true, reason: 'scored' };
}

/** Exact-match confirmation. Whitespace at the ends is not a difference. */
function confirmsExactly(letter, submitted) {
  return (
    letter.subject.trim() === String(submitted.subject ?? '').trim() &&
    letter.body.trim() === String(submitted.body ?? '').trim()
  );
}

async function gateRowFor(userId, leadId) {
  const { data, error } = await getSupabaseAdmin()
    .from('leads')
    .select(GATE_COLUMNS)
    .eq('id', leadId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw httpError(500, 'Could not read the letter');

  return data ?? null;
}

/**
 * @param {string} userId    from the verified JWT, never the body
 * @param {string} leadId    from the path — attacker-controlled, re-filtered below
 * @param {{confirmed:boolean, subject:string, body:string}} submitted
 */
export async function sendApprovedLead(userId, leadId, submitted = {}) {
  if (!userId) throw httpError(400, 'A user id is required');
  if (!leadId) throw httpError(400, 'A lead id is required');

  if (submitted.confirmed !== true) {
    throw httpError(400, 'Explicit confirmation is required before sending');
  }

  // 404 rather than 403 throughout: never confirm that someone else's lead exists.
  const gateRow = await gateRowFor(userId, leadId);
  if (!gateRow) throw httpError(404, 'Letter not found');

  const verdict = fidelityVerdict(gateRow);
  if (!verdict.allowed) {
    logger.info('lead_send_blocked', { userId, leadId, reason: verdict.reason });

    throw httpError(
      422,
      verdict.reason === 'below_floor'
        ? 'This draft does not sound enough like you yet. Redraft it, or edit it yourself and send that.'
        : 'This draft has not been checked yet. Redraft it before sending.'
    );
  }

  // THE APPROVAL GATE. Read through selectSendableLeads and nowhere else: a lead
  // that is not `approved` is simply absent from this list, so "not approved" and
  // "not yours" fail identically and neither can be told apart from outside.
  const sendable = await selectSendableLeads(userId, gateRow.campaign_id);
  const letter = sendable.find((candidate) => candidate.id === leadId);

  if (!letter) throw httpError(409, 'That letter is not approved for sending');

  if (!confirmsExactly(letter, submitted)) {
    // The human confirmed something other than what would go out. Refusing is the
    // whole point of the § Security non-negotiable.
    logger.warn('lead_send_confirmation_mismatch', { userId, leadId });
    throw httpError(409, 'This letter changed since you reviewed it. Read it again before sending.');
  }

  const result = await sendEmail(userId, {
    to: letter.email,
    subject: letter.subject,
    body: letter.body
  });

  await markSent(userId, leadId, result);

  logger.info('lead_sent', { userId, leadId, messageId: result?.messageId ?? null });

  return { id: leadId, status: 'sent', threadId: result?.threadId ?? null };
}

/**
 * Move the lead to `sent`.
 *
 * This is also what stops a double send: a `sent` lead is no longer `approved`,
 * so `selectSendableLeads` excludes it and a repeat call refuses at the gate.
 */
async function markSent(userId, leadId, result) {
  const { error } = await getSupabaseAdmin()
    .from('leads')
    .update({
      status: 'sent',
      sent_at: new Date().toISOString(),
      gmail_message_id: result?.messageId ?? null,
      gmail_thread_id: result?.threadId ?? null
    })
    .eq('id', leadId)
    .eq('user_id', userId);

  // The mail is already gone. Failing the request now would tell the user it did
  // not send, which is worse than a row that lags — so this is logged, not thrown.
  if (error) logger.error('lead_send_mark_failed', { userId, leadId, status: 500 });
}
