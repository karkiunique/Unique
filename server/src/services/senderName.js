import { getSupabaseAdmin } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { httpError } from '../lib/httpError.js';

/**
 * The sign-off name — `profiles.full_name` (migration 006, Decisions 2026-08-13).
 *
 * This is the name every generated email signs off with, collected as a required
 * field at signup. It exists because the sign-off guardrail could only match a
 * closing against `signoff_styles`, so a brand-new user with no styles got no
 * enforcement at all and letters went out unsigned under their own name.
 *
 * OWNER SCOPING: `profiles` is keyed by the auth user id, so `id = userId` IS the
 * owner filter here — there is no separate `user_id` column on this table. The
 * server holds the service-role key and bypasses RLS, so that filter is the
 * access control.
 *
 * PRIVACY: a person's name is PII, treated exactly like an email address. It is
 * never logged, never put in an error message, and never returned to anyone but
 * its owner.
 */

/** Long enough for a real name with a middle name; short enough to bound the prompt. */
export const MAX_SENDER_NAME_LENGTH = 80;

/**
 * Whitespace is collapsed rather than merely trimmed: the name is interpolated
 * into the generation prompt, and a "name" carrying newlines could plant
 * instructions of its own there.
 */
function cleanName(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/**
 * This user's sign-off name, or null when they have not given one.
 *
 * NEVER THROWS, by design. A legacy pre-006 account has no name, and the whole
 * decision rests on that being harmless: the caller falls back to the style-based
 * check and the send goes ahead. A lookup that failed is indistinguishable from a
 * name that is absent, and blocking a user's generation because of a hiccup on
 * this query would be strictly worse than checking one rule less.
 */
export async function getSenderName(userId) {
  if (typeof userId !== 'string' || userId.trim() === '') return null;

  try {
    const { data, error } = await getSupabaseAdmin()
      .from('profiles')
      .select('full_name')
      .eq('id', userId)
      .maybeSingle();

    if (error) return null;

    return cleanName(data?.full_name) || null;
  } catch {
    // Swallowed, not logged: a driver error can quote the row it was reading.
    return null;
  }
}

/**
 * Set this user's sign-off name. Used by PATCH /api/me — at signup the name
 * arrives with the profile row via the 002/006 trigger, so this is the backfill
 * path for accounts created before migration 006.
 */
export async function setSenderName(userId, fullName) {
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw httpError(400, 'A userId is required');
  }

  const name = cleanName(fullName);

  // The message names the field, never the value the user sent.
  if (name === '') throw httpError(400, 'A name is required');
  if (name.length > MAX_SENDER_NAME_LENGTH) {
    throw httpError(400, `A name must be ${MAX_SENDER_NAME_LENGTH} characters or fewer`);
  }

  const { data, error } = await getSupabaseAdmin()
    .from('profiles')
    .update({ full_name: name })
    .eq('id', userId)
    .select('full_name')
    .maybeSingle();

  if (error) throw httpError(500, 'Could not save your name');
  if (!data) throw httpError(404, 'Profile not found');

  // The id only. The name itself is PII and never reaches a log line.
  logger.info('sender_name_set', { userId });

  return cleanName(data.full_name) || null;
}
