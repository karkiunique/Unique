import { getSupabaseAdmin } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { httpError } from '../lib/httpError.js';
import { parseProfileJson } from './voice.js';
import { callModel } from './generateCore.js';
import {
  CLARIFY_SYSTEM_PROMPT,
  buildClarifyUserPrompt,
  MAX_CLARIFYING_QUESTIONS
} from './clarifyPrompts.js';

/**
 * The clarify pass (CLAUDE.md, Decisions 2026-08-09).
 *
 * The brief says what the campaign is about; this asks for what a cold email
 * needs and the brief did not say. The answers come back through
 * PATCH /campaigns/:id and feed generation alongside the brief.
 *
 * OWNER SCOPING: the server holds the service-role key and bypasses row level
 * security, so the `user_id` filter on the read below IS the access control.
 * Another user's campaign is a 404, exactly as everywhere else.
 *
 * PRIVACY: the brief is user-authored content about their own business and is
 * treated exactly like `template_body` — it goes to the Anthropic API and to
 * nowhere else. It is never logged and never put in an error message, and
 * neither is the model's reply, which is derived from it.
 */

const CLARIFY_MAX_TOKENS = 700;

// The brief and the owner, nothing else: this path has no use for the rest.
const CAMPAIGN_COLUMNS = 'id, user_id, brief';

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

/** A model that answers with objects instead of strings is still answering. */
function questionText(entry) {
  if (typeof entry === 'string') return entry.trim();
  if (typeof entry?.question === 'string') return entry.question.trim();

  return '';
}

/**
 * Model output -> a clean array of question strings, capped at the CLAUDE.md
 * limit however many the model felt like returning.
 *
 * Exported for its own tests. The raw text is derived from the user's brief, so
 * a parse failure NEVER echoes it — the error says the shape was wrong and
 * nothing about what was in it.
 */
export function parseClarifyQuestions(text) {
  let parsed;
  try {
    parsed = parseProfileJson(text);
  } catch {
    throw httpError(502, 'The model did not return usable questions');
  }

  if (!Array.isArray(parsed.questions)) {
    throw httpError(502, 'The model did not return usable questions');
  }

  const questions = [];
  for (const entry of parsed.questions) {
    const question = questionText(entry);
    if (question === '' || questions.includes(question)) continue;

    questions.push(question);
    if (questions.length === MAX_CLARIFYING_QUESTIONS) break;
  }

  return questions;
}

/**
 * Ask the model what the brief left out. Returns `{campaignId, questions}` with
 * at most MAX_CLARIFYING_QUESTIONS entries — possibly none, if the brief is
 * already complete enough, which is a fine answer and not an error.
 */
export async function clarifyCampaign(userId, campaignId) {
  requireUserId(userId);
  const id = requireCampaignId(campaignId);

  const campaign = await findOwnedCampaign(userId, id);
  const brief = typeof campaign.brief === 'string' ? campaign.brief.trim() : '';

  if (brief === '') {
    throw httpError(400, 'Write a brief for this campaign before asking what it is missing');
  }

  const text = await callModel(
    CLARIFY_SYSTEM_PROMPT,
    buildClarifyUserPrompt(brief),
    CLARIFY_MAX_TOKENS
  );
  const questions = parseClarifyQuestions(text);

  logger.info('campaign_clarified', { userId, campaignId: id, count: questions.length });

  return { campaignId: id, questions };
}
