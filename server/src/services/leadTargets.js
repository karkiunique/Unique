import { getSupabaseAdmin } from '../lib/supabase.js';
import { httpError } from '../lib/httpError.js';
import { logger } from '../lib/logger.js';

/**
 * The standing ICP — one per user (CLAUDE.md, Decisions 2026-08-16).
 *
 * The structured columns drive the lead-source query; `fit_notes` goes to the
 * model for the hook judgement. `fit_notes` is user-authored content about their
 * own business, so it gets the same handling as `campaigns.brief`: never logged,
 * never in an error message.
 */

const TARGET_COLUMNS =
  'id, user_id, titles, seniority, industries, company_size, geos, ' +
  'exclude_domains, exclude_industries, fit_notes, daily_target, active, updated_at';

const MAX_LIST_ENTRIES = 40;
const MAX_ENTRY_LENGTH = 120;
const MAX_FIT_NOTES = 2000;

const MIN_DAILY_TARGET = 1;
const MAX_DAILY_TARGET = 5;

function targetsTable() {
  return getSupabaseAdmin().from('lead_targets');
}

/**
 * Clean a criteria list. Non-arrays become null rather than [], so "the user said
 * nothing" is distinguishable from "the user said none" — the gates treat an
 * absent criterion as no constraint, and that distinction is load-bearing.
 */
function cleanList(value) {
  if (!Array.isArray(value)) return null;

  const cleaned = value
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim().slice(0, MAX_ENTRY_LENGTH))
    .filter((entry) => entry !== '')
    .slice(0, MAX_LIST_ENTRIES);

  return cleaned.length > 0 ? cleaned : null;
}

function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, max);
  return trimmed === '' ? null : trimmed;
}

/** The CEILING. Out-of-range is clamped, not rejected: it is a slider, not a gate. */
function cleanDailyTarget(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 2;

  return Math.min(MAX_DAILY_TARGET, Math.max(MIN_DAILY_TARGET, Math.round(parsed)));
}

export function normalizeTarget(input = {}) {
  const payload = input && typeof input === 'object' ? input : {};

  return {
    titles: cleanList(payload.titles),
    seniority: cleanList(payload.seniority),
    industries: cleanList(payload.industries),
    company_size: cleanText(payload.companySize, MAX_ENTRY_LENGTH),
    geos: cleanList(payload.geos),
    exclude_domains: cleanList(payload.excludeDomains),
    exclude_industries: cleanList(payload.excludeIndustries),
    fit_notes: cleanText(payload.fitNotes, MAX_FIT_NOTES),
    daily_target: cleanDailyTarget(payload.dailyTarget),
    active: payload.active !== false
  };
}

/** This user's standing target, or null if they have not set one. */
export async function getTarget(userId) {
  if (!userId) throw httpError(400, 'A user id is required');

  const { data, error } = await targetsTable()
    .select(TARGET_COLUMNS)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw httpError(500, 'Could not read your target');

  return data ?? null;
}

/**
 * Create or replace the standing target.
 *
 * Upsert on `user_id` because the table holds one per user by constraint — a
 * second POST is an edit, not a second target.
 */
export async function putTarget(userId, input) {
  if (!userId) throw httpError(400, 'A user id is required');

  const record = {
    ...normalizeTarget(input),
    user_id: userId,
    updated_at: new Date().toISOString()
  };

  const { data, error } = await targetsTable()
    .upsert(record, { onConflict: 'user_id' })
    .select(TARGET_COLUMNS)
    .single();

  if (error) throw httpError(500, 'Could not save your target');

  // Counts and ids only. fit_notes is the user's own business description and
  // never reaches a log line.
  logger.info('lead_target_saved', { userId, count: data?.daily_target });

  return data;
}

/**
 * Every active target, for the daily job to iterate.
 *
 * A target with no criteria at all is still returned: the gates treat absent
 * criteria as no constraint, so such a user gets leads screened on deliverability
 * and hook quality alone. That is thin, but it is not broken, and it is the
 * sparse-profile posture § Rules requires.
 */
export async function listActiveTargets() {
  const { data, error } = await targetsTable().select(TARGET_COLUMNS).eq('active', true);

  if (error) throw new Error('could not list active targets');

  return data ?? [];
}
