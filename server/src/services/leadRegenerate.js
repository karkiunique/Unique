import { getSupabaseAdmin } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { httpError } from '../lib/httpError.js';
import { loadProfileWithExemplars } from './voice.js';
import { campaignGoal, draftForLead, missingMergeVarsFor } from './generateBatch.js';
import { LEAD_REVIEW_COLUMNS } from './leadReview.js';

/**
 * Redraft ONE lead from the review screen, without touching the rest of the run.
 *
 * The drafting itself is the batch's — profile, exemplars, guardrails, fidelity
 * retries and all — imported from generateBatch.js rather than reimplemented, so
 * a redrafted letter is written by exactly the rules the batch used. What differs
 * is only what happens around it:
 *
 *  - A FAILED REDRAFT CHANGES NOTHING. The batch flags a lead it could not write
 *    as `failed`; here the lead already has a letter a human may be reading, and
 *    losing it to a model timeout would strand them with no way back.
 *  - A SUCCESSFUL REDRAFT WITHDRAWS APPROVAL. New words are not the words that
 *    were approved, so the lead returns to `generated` and must be approved
 *    again. Any earlier hand edit is cleared with it — an edit of a letter that
 *    no longer exists must never end up being the thing that gets sent.
 *
 * OWNER SCOPING: the service-role key bypasses RLS, so the `user_id` filter on
 * the lead, the campaign and the write below IS the access control. A lead that
 * is not this user's is a 404.
 *
 * PRIVACY: the draft, the decrypted exemplars and the lead's own details stay in
 * memory — to the Anthropic API, to the lead row, and nowhere else. Log lines
 * carry ids and the fidelity score only.
 */

const CAMPAIGN_COLUMNS = 'id, user_id, name, mode, template_body, subject_template, status';
const LEAD_DRAFT_COLUMNS =
  'id, campaign_id, user_id, email, first_name, last_name, company, title, research_json, status';

const GENERATED = 'generated';

/** The same cap the batch run applies to a per-run goal. */
const MAX_GOAL_LENGTH = 2000;

/**
 * A letter that has gone out, or is queued to, is not redraftable — there is
 * nothing to redraft. `pending` and `failed` are here because a redraft is the
 * only way back for a lead the batch could not write.
 */
const REDRAFTABLE_FROM = new Set(['pending', GENERATED, 'approved', 'failed']);

function requireUserId(userId) {
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw httpError(400, 'A userId is required');
  }

  return userId;
}

function requireLeadId(leadId) {
  if (typeof leadId !== 'string' || leadId.trim() === '') {
    throw httpError(400, 'A recipient id is required');
  }

  return leadId.trim();
}

/** 404 — not 403 — when the lead is not this user's. */
async function findOwnedLead(userId, leadId) {
  const { data, error } = await getSupabaseAdmin()
    .from('leads')
    .select(LEAD_DRAFT_COLUMNS)
    .eq('id', leadId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw httpError(500, 'Could not load the recipient');
  if (!data) throw httpError(404, 'Recipient not found');

  return data;
}

async function findOwnedCampaign(userId, campaignId) {
  const { data, error } = await getSupabaseAdmin()
    .from('campaigns')
    .select(CAMPAIGN_COLUMNS)
    .eq('id', campaignId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw httpError(500, 'Could not load the campaign');
  if (!data) throw httpError(404, 'Campaign not found');

  return data;
}

async function saveRedraft(userId, leadId, draft, fidelityScore) {
  const { data, error } = await getSupabaseAdmin()
    .from('leads')
    .update({
      generated_subject: draft.subject,
      generated_body: draft.body,
      // The previous hand edit belonged to the previous letter.
      edited_body: null,
      fidelity_score: Number.isFinite(fidelityScore) ? fidelityScore : null,
      status: GENERATED
    })
    .eq('id', leadId)
    .eq('user_id', userId)
    .select(LEAD_REVIEW_COLUMNS)
    .single();

  if (error) throw httpError(500, 'Could not save the redrafted letter');

  return data;
}

/** Redraft one lead. Returns the updated lead row for the review screen. */
export async function regenerateLead(userId, leadId, goal = '') {
  requireUserId(userId);
  const id = requireLeadId(leadId);

  if (typeof goal === 'string' && goal.trim().length > MAX_GOAL_LENGTH) {
    throw httpError(400, `A goal must be ${MAX_GOAL_LENGTH} characters or fewer`);
  }

  const lead = await findOwnedLead(userId, id);

  if (!REDRAFTABLE_FROM.has(lead.status)) {
    throw httpError(400, `A ${lead.status} recipient cannot be redrafted`);
  }

  const campaign = await findOwnedCampaign(userId, lead.campaign_id);

  const missing = missingMergeVarsFor(campaign, lead);
  if (missing.length > 0) {
    // CLAUDE.md §3: never send with a blank or wrong substitution. The variable
    // NAMES are safe to return — they are 'company', not the company.
    throw httpError(400, `This recipient is missing ${missing.join(', ')}`);
  }

  const voice = await loadProfileWithExemplars(userId);
  const run = { userId, campaign, voice, goal: campaignGoal(campaign, goal) };

  // Deliberately un-caught: a model failure must leave the stored letter exactly
  // as it was, so nothing is written and the route answers with a status alone.
  const result = await draftForLead(run, lead);

  const saved = await saveRedraft(userId, id, result.draft, result.fidelityScore);

  logger.info('lead_redrafted', {
    userId,
    campaignId: campaign.id,
    leadId: id,
    score: result.fidelityScore
  });

  return saved;
}
