import { getSupabaseAdmin } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { loadProfileWithExemplars } from './voice.js';
import { getSenderName } from './senderName.js';
import { draftForLead } from './generateBatch.js';
import { campaignGoal } from './campaignGoal.js';

/**
 * Turn a screened candidate into a drafted lead row (CLAUDE.md, 2026-08-16).
 *
 * This is the `draftLead` the daily job injects. It reuses `draftForLead` rather
 * than growing a second generation path — the fidelity check, the banned-phrase
 * guard, the sign-off enforcement and the sparse-profile handling all live there,
 * and a parallel implementation would drift away from every one of them.
 *
 * The lead is written as 'generated', which is what the review queue reads, and
 * NEVER as 'approved'. Nothing this job produces is sendable until a human
 * approves it one letter at a time (2026-08-08).
 */

/**
 * Load the per-user context once, then draft each candidate against it.
 *
 * Returned as a factory because voice profile, exemplars and sign-off name cannot
 * change mid-run and re-reading them per candidate would be three extra queries
 * per letter for no benefit.
 */
export async function createDailyDrafter(userId, campaign) {
  const voice = await loadProfileWithExemplars(userId);
  const senderName = await getSenderName(userId);

  // The brief IS the goal here — the fit notes the user wrote about their own
  // business. campaignGoal falls back to the campaign NAME when there is no
  // brief, which is the failure the 2026-08-09 decision exists to prevent, so a
  // Daily campaign with no fit notes produces a letter about nothing in
  // particular. Better a thin goal than a letter about the word "Daily".
  const goal = campaignGoal(campaign, '');

  const run = { userId, campaign, voice, senderName, goal, variety: null };

  return async function draftCandidate(candidate) {
    const lead = await insertLead(userId, campaign.id, candidate);
    if (!lead) return null;

    const draft = await draftForLead(run, lead);

    await writeDraft(lead.id, draft);

    // The score, an id, and nothing else. The letter itself is email content.
    logger.info('daily_draft_written', { userId, leadId: lead.id, score: draft?.fidelityScore ?? 0 });

    return { leadId: lead.id, fidelityScore: draft?.fidelityScore ?? null };
  };
}

/** The candidate's own fields only — the research object, never a whole vendor blob. */
async function insertLead(userId, campaignId, candidate) {
  const { data, error } = await getSupabaseAdmin()
    .from('leads')
    .insert({
      user_id: userId,
      campaign_id: campaignId,
      email: String(candidate.email).trim().toLowerCase(),
      first_name: candidate.first_name ?? null,
      last_name: candidate.last_name ?? null,
      company: candidate.company ?? null,
      title: candidate.title ?? null,
      research_json: candidate.research ?? null,
      status: 'pending'
    })
    .select('id, email, first_name, last_name, company, title, research_json')
    .single();

  if (error) {
    // A duplicate here means the gates and the database disagree about who has
    // already been contacted. Not fatal to the run: skip this one and carry on.
    logger.warn('daily_lead_insert_failed', { userId, status: 500 });
    return null;
  }

  return data;
}

/**
 * Write the drafted letter.
 *
 * Below the floor the row is still written but left 'pending', so it never
 * appears in the queue — the job counts it as undelivered and the user is not
 * shown a letter that does not sound like them. Keeping the row costs nothing and
 * stops the same person being re-screened tomorrow.
 */
async function writeDraft(leadId, draft) {
  const passed = Number.isFinite(draft?.fidelityScore) && draft.fidelityScore >= 80;

  const { error } = await getSupabaseAdmin()
    .from('leads')
    .update({
      generated_subject: draft?.subject ?? null,
      generated_body: draft?.body ?? null,
      fidelity_score: draft?.fidelityScore ?? null,
      status: passed ? 'generated' : 'pending'
    })
    .eq('id', leadId);

  if (error) throw new Error('could not write the daily draft');
}
