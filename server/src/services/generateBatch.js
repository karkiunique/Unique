import pLimit from 'p-limit';

import { getSupabaseAdmin } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { httpError } from '../lib/httpError.js';
import { loadProfileWithExemplars } from './voice.js';
import { PERSONALIZED_MARKER } from './campaigns.js';
import { campaignGoal } from './campaignGoal.js';
import { createVarietyLedger, variantRecord } from './batchVariety.js';
import { draftInVoice } from './generateCore.js';
import { draftFromTemplate } from './generateTemplate.js';
import { applyMergeVars, findMissingMergeVars } from './templateMerge.js';

/**
 * Batch generation for a campaign (CLAUDE.md §3).
 *
 * OWNER SCOPING: the server holds the service-role key and bypasses row level
 * security, so the `user_id` filter on every query below IS the access control.
 * The campaign is resolved by (id, user_id) before a lead is read, and each lead
 * write is filtered by user_id again. A missing filter here would let one user
 * generate — and later send — into another user's campaign.
 *
 * PRIVACY: log lines carry ids, counts and a machine reason code only. Never a
 * subject, a body, an exemplar, a recipient address, a lead's name or their
 * employer. Draft bodies and decrypted exemplars stay in memory: to the Anthropic
 * API, to the lead row, and nowhere else.
 *
 * FIDELITY IS LOOSER HERE THAN IN COMPOSE, DELIBERATELY. A draft under 80 is
 * regenerated once and then STORED with its score and left `generated` for the
 * review screen. It is never blocked and never failed. The compose flow's hard
 * floor exists because a compose draft goes out with one click; here a human
 * reads every lead first (CLAUDE.md §3).
 */

/**
 * Re-exported for leadRegenerate.js: redrafting one lead from the review screen
 * has to be written to the same goal this batch used, so it shares the
 * machinery rather than growing a second copy that can drift.
 */
export { campaignGoal };

/** CLAUDE.md §3: iterate leads with p-limit concurrency 3. */
export const GENERATION_CONCURRENCY = 3;

/** Stable machine codes. The UI owns the prose; these must not drift. */
export const GENERATION_FAIL_REASON = {
  MISSING_MERGE_VAR: 'missing_merge_var',
  MODEL_FAILED: 'model_failed',
  SAVE_FAILED: 'save_failed'
};

const MAX_GOAL_LENGTH = 2000;

const PENDING_STATUS = 'pending';
const GENERATED_STATUS = 'generated';
const FAILED_STATUS = 'failed';

const GENERATING_CAMPAIGN = 'generating';
const REVIEW_CAMPAIGN = 'review';
const SENDING_CAMPAIGN = 'sending';

const CAMPAIGN_COLUMNS =
  'id, user_id, name, mode, template_body, subject_template, brief, clarifications, status';
const LEAD_COLUMNS = 'id, email, first_name, last_name, company, title, research_json';

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function requireUserId(userId) {
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw httpError(400, 'A userId is required');
  }

  return userId;
}

function requireCampaignId(campaignId) {
  if (typeof campaignId !== 'string' || campaignId.trim() === '') {
    throw httpError(400, 'A campaign id is required');
  }

  return campaignId.trim();
}

/** 404 — not 403 — when the campaign is not this user's: a stranger learns nothing. */
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

/**
 * Refuse a run that cannot produce a sendable email, before a single model call
 * is spent. A template campaign needs a personalised section and a subject line:
 * the letter is the user's own, so there is nothing for us to invent in its place.
 */
function requireGeneratable(campaign) {
  if (campaign.status === GENERATING_CAMPAIGN) {
    throw httpError(409, 'This campaign is already generating');
  }
  if (campaign.status === SENDING_CAMPAIGN) {
    throw httpError(409, 'This campaign is sending — pause it before generating again');
  }
  if (campaign.mode !== 'template') return;

  if (!String(campaign.template_body ?? '').includes(PERSONALIZED_MARKER)) {
    throw httpError(400, `A template campaign needs at least one ${PERSONALIZED_MARKER} section`);
  }
  if (trimmed(campaign.subject_template) === '') {
    throw httpError(400, 'A template campaign needs a subject line before it can generate');
  }
}

async function fetchPendingLeads(userId, campaignId) {
  const { data, error } = await getSupabaseAdmin()
    .from('leads')
    .select(LEAD_COLUMNS)
    .eq('campaign_id', campaignId)
    .eq('user_id', userId)
    .eq('status', PENDING_STATUS)
    .order('created_at', { ascending: true });

  if (error) throw httpError(500, 'Could not load the recipients');

  return Array.isArray(data) ? data : [];
}

/**
 * Status is the server's to move. campaigns.js drops `status` from any client
 * patch on purpose, and this does not widen that surface — it is the server-side
 * move, still filtered by user_id.
 */
async function setCampaignStatus(userId, campaignId, status) {
  const { error } = await getSupabaseAdmin()
    .from('campaigns')
    .update({ status })
    .eq('id', campaignId)
    .eq('user_id', userId);

  if (error) throw httpError(500, 'Could not update the campaign status');
}

async function saveGeneratedLead(userId, leadId, draft, fidelityScore, variant) {
  const { error } = await getSupabaseAdmin()
    .from('leads')
    .update({
      generated_subject: draft.subject,
      generated_body: draft.body,
      fidelity_score: Number.isFinite(fidelityScore) ? fidelityScore : null,
      // Same write as the body: a letter and its variant can never disagree.
      variant_json: variant,
      status: GENERATED_STATUS
    })
    .eq('id', leadId)
    .eq('user_id', userId);

  if (error) throw httpError(500, 'Could not save the generated email');
}

async function markLeadFailed(userId, leadId) {
  const { error } = await getSupabaseAdmin()
    .from('leads')
    .update({ status: FAILED_STATUS })
    .eq('id', leadId)
    .eq('user_id', userId);

  if (error) throw httpError(500, 'Could not flag the recipient');
}

function recipientOf(lead) {
  return {
    email: lead.email,
    name: [lead.first_name, lead.last_name].filter(Boolean).join(' ').trim(),
    company: trimmed(lead.company),
    title: trimmed(lead.title)
  };
}

/** Every text this lead's letter is merged into — the template and the subject. */
function mergeTargets(campaign) {
  return campaign.mode === 'template'
    ? [campaign.template_body, campaign.subject_template]
    : [campaign.subject_template];
}

/** Exported for leadRegenerate.js — see campaignGoal() above. */
export function missingMergeVarsFor(campaign, lead) {
  const missing = new Set();

  for (const target of mergeTargets(campaign)) {
    for (const field of findMissingMergeVars(target, lead)) missing.add(field);
  }

  return [...missing];
}

/**
 * One lead, drafted but not yet persisted. Throws on a model or template failure.
 *
 * Exported for leadRegenerate.js — see campaignGoal() above. Persistence is
 * deliberately NOT part of it: the batch flags a failed lead, while a redraft
 * from the review screen leaves the existing letter alone.
 */
export async function draftForLead(run, lead, assignment = null) {
  const shared = {
    profileJson: run.voice.profileJson,
    exemplars: run.voice.exemplars,
    recipient: recipientOf(lead),
    research: lead.research_json
  };
  const subject = applyMergeVars(run.campaign.subject_template, lead).trim();

  if (run.campaign.mode === 'template') {
    return draftFromTemplate({
      ...shared,
      lead,
      templateBody: run.campaign.template_body,
      subject
    });
  }

  const result = await draftInVoice({
    ...shared,
    goal: run.goal,
    varietyBlock: assignment?.promptBlock ?? ''
  });

  // A subject line the user wrote themselves wins over the model's.
  return subject === '' ? result : { ...result, draft: { ...result.draft, subject } };
}

async function recordFailure(run, leadId, reason) {
  try {
    await markLeadFailed(run.userId, leadId);
  } catch {
    // A lead we cannot even flag is a database problem, not a lead problem: it
    // stays `pending` and the next run picks it up. Swallowed rather than
    // logged, because the driver's message can quote the row it was writing.
  }

  logger.warn('lead_generation_failed', {
    userId: run.userId,
    campaignId: run.campaign.id,
    leadId,
    reason
  });
}

/**
 * One lead, start to finish. NEVER THROWS: a model call that falls over on lead
 * seven must not cost the user leads eight through fifty.
 */
async function generateOneLead(run, lead) {
  const missing = missingMergeVarsFor(run.campaign, lead);
  if (missing.length > 0) {
    // CLAUDE.md §3: never send with a blank or wrong substitution. The variable
    // NAMES are safe to log — they are 'company', not the company.
    const reason = `${GENERATION_FAIL_REASON.MISSING_MERGE_VAR}:${missing.join(',')}`;
    await recordFailure(run, lead.id, reason);

    return { leadId: lead.id, ok: false, reason };
  }

  // Reserved before the model call rather than recorded after it — batchVariety.js
  // explains why that is what makes the ledger correct at concurrency 3.
  const assignment = run.variety ? run.variety.reserve() : null;

  let result;
  try {
    result = await draftForLead(run, lead, assignment);
  } catch {
    // The error is dropped rather than inspected: our own messages are safe, but
    // an SDK error can carry request content, and this path must never leak it.
    await recordFailure(run, lead.id, GENERATION_FAIL_REASON.MODEL_FAILED);

    return { leadId: lead.id, ok: false, reason: GENERATION_FAIL_REASON.MODEL_FAILED };
  }

  const variant = variantRecord({
    assignment,
    body: result.draft.body,
    profileJson: run.voice.profileJson,
    profileVersion: run.voice.version
  });

  try {
    // Written as this lead completes, not at the end of the run, so the review
    // screen can poll progress lead by lead.
    await saveGeneratedLead(run.userId, lead.id, result.draft, result.fidelityScore, variant);
  } catch {
    // The draft was fine; the write was not. Leave the lead `pending` so a
    // re-run redoes it rather than stranding it as failed.
    logger.warn('lead_generation_failed', {
      userId: run.userId,
      campaignId: run.campaign.id,
      leadId: lead.id,
      reason: GENERATION_FAIL_REASON.SAVE_FAILED
    });

    return { leadId: lead.id, ok: false, reason: GENERATION_FAIL_REASON.SAVE_FAILED };
  }

  logger.info('lead_generated', {
    userId: run.userId,
    campaignId: run.campaign.id,
    leadId: lead.id,
    score: result.fidelityScore
  });

  return { leadId: lead.id, ok: true, score: result.fidelityScore };
}

/**
 * Everything that must succeed BEFORE the response goes out: ownership, the
 * campaign's shape, the pending leads, and the voice profile. A missing profile
 * has to be a 400 the caller can see, not a silent failure after a 202.
 *
 * The returned object carries the decrypted exemplars. It is opaque — hand it
 * straight to runCampaignGeneration() and never serialize it.
 */
export async function beginCampaignGeneration(userId, campaignId, goal = '') {
  requireUserId(userId);
  const id = requireCampaignId(campaignId);

  if (trimmed(goal).length > MAX_GOAL_LENGTH) {
    throw httpError(400, `A goal must be ${MAX_GOAL_LENGTH} characters or fewer`);
  }

  const campaign = await findOwnedCampaign(userId, id);
  requireGeneratable(campaign);

  const leads = await fetchPendingLeads(userId, id);
  if (leads.length === 0) {
    throw httpError(400, 'There are no recipients waiting for a draft');
  }

  const voice = await loadProfileWithExemplars(userId);

  // Template mode has no opener to vary: the letter around the personalised gaps
  // is the user's own writing, identical for every lead by their own choice.
  const variety = campaign.mode === 'template' ? null : createVarietyLedger(voice.profileJson);

  await setCampaignStatus(userId, id, GENERATING_CAMPAIGN);
  logger.info('campaign_generation_started', { userId, campaignId: id, count: leads.length });

  return {
    userId,
    campaign,
    leads,
    voice,
    variety,
    goal: campaignGoal(campaign, goal),
    pending: leads.length
  };
}

/**
 * Draft every pending lead, three at a time, writing each row as it completes.
 * Moves the campaign to 'review' when the run is done, whatever the outcomes —
 * a partly failed batch is still a batch a human has to look at.
 */
export async function runCampaignGeneration(run) {
  const limit = pLimit(GENERATION_CONCURRENCY);
  const results = await Promise.all(
    run.leads.map((lead) => limit(() => generateOneLead(run, lead)))
  );

  await setCampaignStatus(run.userId, run.campaign.id, REVIEW_CAMPAIGN);

  const generated = results.filter((result) => result.ok);
  const failures = results.filter((result) => !result.ok);

  logger.info('campaign_generated', {
    userId: run.userId,
    campaignId: run.campaign.id,
    count: generated.length
  });

  return {
    campaignId: run.campaign.id,
    generated: generated.length,
    failed: failures.length,
    failures: failures.map(({ leadId, reason }) => ({ leadId, reason }))
  };
}
