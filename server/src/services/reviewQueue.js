import { getSupabaseAdmin } from '../lib/supabase.js';
import { httpError } from '../lib/httpError.js';
import { logger } from '../lib/logger.js';
import { DAILY_CAMPAIGN_NAME } from './dailyCampaign.js';

/**
 * The review queue — what the daily job has drafted and the user has not yet dealt
 * with (CLAUDE.md, Decisions 2026-08-16).
 *
 * NOT just today's. An unreviewed draft must not vanish at midnight; a user who
 * skips a day should find four letters waiting, not two.
 *
 * NO BODIES IN THE LIST. Same `LEAD_COLUMNS` shape the campaign detail uses, for
 * the reason recorded on 2026-08-08: widening a list endpoint to carry every
 * generated body is strictly more exposure for the same screen. The deck fetches
 * one letter at a time through `GET /leads/:id`.
 */

const QUEUE_COLUMNS =
  'id, campaign_id, email, first_name, last_name, company, title, status, fidelity_score, created_at';

/**
 * 'generated' AND 'approved'. Not 'generated' alone.
 *
 * Sending is approve-then-send, two calls, and if the send fails between them the
 * letter is left `approved` and unsent. Filtering to `generated` would strand it
 * on the only screen that could retry. 'rejected' was declined and anything 'sent'
 * is long past review, so both stay out.
 */
const AWAITING_REVIEW = ['generated', 'approved'];

/** The user's Daily campaign id, or null if the job has never run for them. */
async function dailyCampaignId(userId) {
  const { data, error } = await getSupabaseAdmin()
    .from('campaigns')
    .select('id')
    .eq('user_id', userId)
    .eq('name', DAILY_CAMPAIGN_NAME)
    .maybeSingle();

  if (error) throw httpError(500, 'Could not read your queue');

  return data?.id ?? null;
}

/**
 * Letters waiting for this user, oldest first.
 *
 * Oldest first on purpose: the queue is a work list, and the letter that has been
 * waiting longest is the one whose research is going stalest.
 */
export async function getReviewQueue(userId) {
  if (!userId) throw httpError(400, 'A user id is required');

  const campaignId = await dailyCampaignId(userId);
  if (!campaignId) return { campaignId: null, leads: [] };

  const { data, error } = await getSupabaseAdmin()
    .from('leads')
    .select(QUEUE_COLUMNS)
    .eq('campaign_id', campaignId)
    // Redundant only if the campaign lookup above is correct, and a lead read is
    // not the place to start trusting a join.
    .eq('user_id', userId)
    .in('status', AWAITING_REVIEW)
    .order('created_at', { ascending: true });

  if (error) throw httpError(500, 'Could not read your queue');

  return { campaignId, leads: data ?? [] };
}

/**
 * Record why a lead was declined, and take it out of the queue.
 *
 * Sets `'rejected'`, NOT `'failed'`. `'failed'` means generation broke and is in
 * `leadRegenerate`'s REDRAFTABLE_FROM — using it here would make a letter a human
 * explicitly declined eligible for redrafting, which is the system overriding a
 * person. Migration 009 exists for exactly this distinction.
 *
 * The rejection row is written FIRST. If the status update then fails, the signal
 * is still captured and the lead simply stays in the queue — the reverse order
 * would lose the feedback while looking like it worked.
 */
export async function rejectLead(userId, leadId, reason, note = null) {
  if (!userId) throw httpError(400, 'A user id is required');
  if (!leadId) throw httpError(400, 'A lead id is required');

  const db = getSupabaseAdmin();

  // Ownership is checked before anything is written: the id in the path is
  // attacker-controlled and must never reach a write unfiltered.
  const { data: lead, error: readError } = await db
    .from('leads')
    .select('id, status')
    .eq('id', leadId)
    .eq('user_id', userId)
    .maybeSingle();

  if (readError) throw httpError(500, 'Could not record the rejection');
  // 404, not 403: never confirm that someone else's lead id exists.
  if (!lead) throw httpError(404, 'Lead not found');

  const { error: insertError } = await db
    .from('lead_rejections')
    .insert({ user_id: userId, lead_id: leadId, reason, note });

  if (insertError) throw httpError(500, 'Could not record the rejection');

  const { error: updateError } = await db
    .from('leads')
    .update({ status: 'rejected' })
    .eq('id', leadId)
    .eq('user_id', userId);

  if (updateError) throw httpError(500, 'Could not record the rejection');

  // The reason is a closed set and safe to log; the note is the user's own words
  // and is not.
  logger.info('lead_rejected', { userId, leadId, reason });

  return { id: leadId, status: 'rejected' };
}
