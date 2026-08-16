import { getAnthropic, getModel } from '../lib/anthropic.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
import { httpError } from '../lib/httpError.js';
import { fetchSentEmails } from './gmail.js';
import {
  PROFILE_SYSTEM_PROMPT,
  buildProfileUserPrompt,
  EXEMPLAR_SYSTEM_PROMPT,
  buildExemplarUserPrompt
} from './voicePrompts.js';

/**
 * Voice profile builder — the core product.
 *
 * Email bodies passed in here are the cleaned, in-memory texts from gmail.js.
 * They go to the Anthropic API and nowhere else: never to the DB (except the
 * approved exemplars, encrypted), never to logs, never into error messages.
 */

export const MAX_PROFILE_INPUT_CHARS = 80000;
export const MIN_EXEMPLARS = 5;
export const MAX_EXEMPLARS = 8;

const MIN_EXEMPLAR_WORDS = 25;
const PROFILE_MAX_TOKENS = 4000;
const EXEMPLAR_MAX_TOKENS = 300;

const EMAIL_PATTERN = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi;
const PHONE_PATTERN = /\+?\d[\d\s().-]{6,}\d/g;
const PROFILE_ROW_COLUMNS = 'id, user_id, profile_json, source_email_count, version, last_synced_at, created_at';

function normalizeEmailList(emails) {
  if (!Array.isArray(emails)) return [];
  return emails.filter((body) => typeof body === 'string' && body.trim() !== '');
}

function wordCount(text) {
  return text.trim().split(/\s+/).length;
}

/**
 * Keep the most recent emails that fit the budget. Input is newest-first (that is
 * what fetchSentEmails returns), so we fill from the front and stop at the first
 * email that would overflow.
 */
export function capEmailsToCharBudget(emails, budget = MAX_PROFILE_INPUT_CHARS) {
  const kept = [];
  let total = 0;

  for (const body of normalizeEmailList(emails)) {
    if (total + body.length > budget) break;
    kept.push(body);
    total += body.length;
  }

  return kept;
}

function extractText(response) {
  const blocks = response?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

async function callModel(system, userPrompt, maxTokens) {
  const response = await getAnthropic().messages.create({
    model: getModel(),
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: userPrompt }]
  });

  return extractText(response);
}

/** Strip ```json fences / surrounding prose, then parse. Never echoes the input. */
export function parseProfileJson(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('Voice profile response was empty');
  }

  let candidate = text.trim();

  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidate = fenced[1].trim();

  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first !== -1 && last > first) candidate = candidate.slice(first, last + 1);

  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    // The raw text is model output derived from email content: never include it.
    throw new Error('Voice profile response was not valid JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Voice profile response was not a JSON object');
  }

  return parsed;
}

/** Parse the model's exemplar picks: 1-based email numbers -> 0-based indices. */
export function parseExemplarIndices(text, count) {
  if (typeof text !== 'string' || text.trim() === '') return [];

  let candidate = text.trim();
  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidate = fenced[1].trim();

  const first = candidate.indexOf('[');
  const last = candidate.lastIndexOf(']');
  if (first === -1 || last <= first) return [];
  candidate = candidate.slice(first, last + 1);

  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const seen = new Set();
  for (const entry of parsed) {
    const value = typeof entry === 'number' ? entry : Number(entry?.index ?? entry?.email ?? NaN);
    if (!Number.isInteger(value) || value < 1 || value > count) continue;
    seen.add(value - 1);
  }

  return [...seen];
}

/** Redact third-party PII from exemplars before they are stored. */
export function redactPii(text) {
  if (typeof text !== 'string') return '';

  return text
    .replace(EMAIL_PATTERN, '[email redacted]')
    .replace(PHONE_PATTERN, (match) =>
      match.replace(/\D/g, '').length >= 7 ? '[phone redacted]' : match
    );
}

/** One Anthropic call over the rolling window of cleaned sent emails. */
export async function buildVoiceProfile(cleanedEmails) {
  const emails = normalizeEmailList(cleanedEmails);
  if (emails.length === 0) {
    throw httpError(400, 'No sent emails available to build a voice profile');
  }

  const rollingWindow = capEmailsToCharBudget(emails);
  const text = await callModel(
    PROFILE_SYSTEM_PROMPT,
    buildProfileUserPrompt(rollingWindow),
    PROFILE_MAX_TOKENS
  );
  const profile = parseProfileJson(text);

  // Phase 3's edit-learning loop appends here; keep the key present from day one.
  if (!Array.isArray(profile.learned_corrections)) profile.learned_corrections = [];

  return profile;
}

function fillFromFallback(indices, emails) {
  const picked = [...indices];
  for (let i = 0; i < emails.length && picked.length < MIN_EXEMPLARS; i += 1) {
    if (!picked.includes(i)) picked.push(i);
  }
  return picked;
}

/** Model picks 5-8 representative emails; we redact them before returning. */
export async function selectExemplars(cleanedEmails) {
  const candidates = normalizeEmailList(cleanedEmails).filter(
    (body) => wordCount(body) >= MIN_EXEMPLAR_WORDS
  );
  if (candidates.length === 0) return [];

  const rollingWindow = capEmailsToCharBudget(candidates);
  if (rollingWindow.length === 0) return [];

  const text = await callModel(
    EXEMPLAR_SYSTEM_PROMPT,
    buildExemplarUserPrompt(rollingWindow),
    EXEMPLAR_MAX_TOKENS
  );

  let indices = parseExemplarIndices(text, rollingWindow.length);
  if (indices.length < MIN_EXEMPLARS) indices = fillFromFallback(indices, rollingWindow);

  return indices.slice(0, MAX_EXEMPLARS).map((index) => redactPii(rollingWindow[index]));
}

/** Insert the profile row. Exemplars are AES-256-GCM encrypted before the write. */
export async function saveVoiceProfile(userId, profileJson, exemplars, sourceCount) {
  if (typeof userId !== 'string' || userId === '') {
    throw httpError(400, 'A userId is required');
  }
  if (!profileJson || typeof profileJson !== 'object') {
    throw httpError(400, 'A voice profile object is required');
  }

  const list = Array.isArray(exemplars) ? exemplars.filter((item) => typeof item === 'string') : [];
  const exemplarsEnc = list.length > 0 ? encrypt(JSON.stringify(list)) : null;

  const { data, error } = await getSupabaseAdmin()
    .from('voice_profiles')
    .insert({
      user_id: userId,
      profile_json: profileJson,
      exemplars_enc: exemplarsEnc,
      source_email_count: Number.isFinite(sourceCount) ? sourceCount : 0,
      version: 1,
      last_synced_at: new Date().toISOString()
    })
    .select(PROFILE_ROW_COLUMNS)
    .single();

  if (error) throw httpError(500, 'Could not save the voice profile');

  return { ...data, has_exemplars: list.length > 0 };
}

/** The newest profile row for a user, exemplars still encrypted. */
async function fetchLatestProfileRow(userId) {
  if (typeof userId !== 'string' || userId === '') throw httpError(400, 'A userId is required');

  const { data, error } = await getSupabaseAdmin()
    .from('voice_profiles')
    .select(`${PROFILE_ROW_COLUMNS}, exemplars_enc`)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw httpError(500, 'Could not load the voice profile');

  return data ?? null;
}

/** Current profile row for a user. Exemplars are never returned decrypted. */
export async function getVoiceProfile(userId) {
  const data = await fetchLatestProfileRow(userId);
  if (!data) return null;

  const { exemplars_enc: exemplarsEnc, ...profile } = data;

  return { ...profile, has_exemplars: Boolean(exemplarsEnc) };
}

/**
 * Profile JSON plus the DECRYPTED exemplars, for few-shot anchoring (CLAUDE.md §3).
 * Server-side only: the plaintext anchors live in memory for one request, are
 * never returned to a client and are never logged.
 */
export async function loadProfileWithExemplars(userId) {
  const data = await fetchLatestProfileRow(userId);
  if (!data) throw httpError(400, 'No voice profile yet — build one before generating');

  let exemplars = [];
  try {
    const parsed = JSON.parse(decrypt(data.exemplars_enc ?? ''));
    if (Array.isArray(parsed)) exemplars = parsed.filter((item) => typeof item === 'string');
  } catch {
    // No anchors stored, or a blob this key cannot read — the profile alone still works.
    exemplars = [];
  }

  // The version travels with the profile because a generated letter records which
  // profile wrote it (leads.variant_json, migration 005).
  return { profileJson: data.profile_json ?? {}, exemplars, version: data.version ?? null };
}

/** Ingest -> analyse -> save. Used by POST /voice/generate and the OAuth callback. */
export async function generateVoiceProfileForUser(userId) {
  const emails = await fetchSentEmails(userId);
  if (emails.length === 0) {
    throw httpError(400, 'No sent emails found in this Gmail account');
  }

  const profile = await buildVoiceProfile(emails);

  let exemplars = [];
  try {
    exemplars = await selectExemplars(emails);
  } catch (err) {
    // A profile without anchors is still useful; never block onboarding on this.
    logger.warn('exemplar_selection_failed', { userId, name: err?.name });
  }

  const saved = await saveVoiceProfile(userId, profile, exemplars, emails.length);

  logger.info('voice_profile_built', { userId, count: emails.length, version: saved?.version ?? 1 });

  return saved;
}
