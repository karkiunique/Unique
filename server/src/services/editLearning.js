import { getSupabaseAdmin } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';

/**
 * The edit-learning loop (CLAUDE.md §3): when a user rewrites a generated
 * letter, work out whether the change was STYLISTIC rather than a change of
 * content, and if so append a note to `profile_json.learned_corrections[]`.
 *
 * CONSERVATIVE BY CONSTRUCTION, because a false positive is permanent. A wrong
 * note teaches the voice profile something the user never meant and then feeds
 * it into every future generation, and the voice profile is the product. So the
 * classifier only ever fires when the words are provably unchanged:
 *
 *  - the word stream (case-folded, punctuation stripped) must be identical, and
 *  - the difference must match one of the named patterns below.
 *
 * Anything else — a sentence rewritten, a paragraph cut, a claim softened — is
 * content, and content teaches nothing about voice. Unrecognised punctuation
 * differences also teach nothing: we would rather learn slowly than wrongly.
 *
 * PRIVACY: the notes are fixed strings written here, never a fragment of the
 * user's letter. Nothing from either body is stored in the profile, returned to
 * a caller or logged — log lines carry ids and counts only.
 */

/** CLAUDE.md §3: cap at 20, FIFO. */
export const MAX_LEARNED_CORRECTIONS = 20;

/** The complete vocabulary. A note that is not on this list cannot be learned. */
export const CORRECTION = {
  SHORT_GREETING: 'user shortens greetings to just the name',
  NO_EXCLAMATIONS: 'user removes exclamation marks',
  NO_SEMICOLONS: 'user removes semicolons',
  NO_ELLIPSES: 'user removes ellipses',
  LOWERCASE: 'user writes in lower case where the draft capitalised'
};

// The openers a greeting can be stripped down FROM. "Good morning Sam," reduces
// to two leading words, hence the multi-word entries.
const GREETING_WORDS = new Set(['hi', 'hey', 'hello', 'dear', 'good', 'morning', 'afternoon']);

const WORD_PATTERN = /[a-z0-9'’]+/g;

function asText(value) {
  return typeof value === 'string' ? value : '';
}

/** Case-folded words with punctuation dropped — the "did the content change" key. */
function words(text) {
  return asText(text).toLowerCase().match(WORD_PATTERN) ?? [];
}

function sameWords(left, right) {
  const a = words(left);
  const b = words(right);

  return a.length === b.length && a.every((word, index) => word === b[index]);
}

/** "Hi Sam," and the like — a short opener, not a first sentence. */
function looksLikeGreeting(line) {
  const parts = words(line);

  return parts.length > 0 && parts.length <= 4 && GREETING_WORDS.has(parts[0]);
}

/** The first line and the remainder, kept byte-for-byte. */
function splitFirstLine(text) {
  const newline = asText(text).indexOf('\n');

  return newline === -1
    ? { greeting: text, rest: '' }
    : { greeting: text.slice(0, newline), rest: text.slice(newline) };
}

/**
 * The generated draft's greeting, if it has one at all. A letter with no opening
 * line is compared whole, which is what makes a one-paragraph draft work.
 */
function splitDraftGreeting(text) {
  const split = splitFirstLine(text);
  if (split.rest === '' || !looksLikeGreeting(split.greeting)) return { greeting: '', rest: text };

  return split;
}

/**
 * The edit, split at the SAME structural place as the draft. Deciding it
 * independently would misread the one case this exists for — "Hi Sam," -> "Sam,",
 * where the edited opener no longer looks like a greeting at all.
 */
function splitEditGreeting(text, hasGreeting) {
  return hasGreeting ? splitFirstLine(text) : { greeting: '', rest: text };
}

/**
 * "Hi Sam," -> "Sam,". True only when the edited greeting is what is left after
 * removing one or more leading greeting words and nothing else — a greeting
 * rewritten to different words is a content change, not a shortening.
 */
function isGreetingShortenedToName(before, after) {
  const original = words(before);
  const shortened = words(after);

  if (shortened.length === 0 || shortened.length >= original.length) return false;

  const removed = original.slice(0, original.length - shortened.length);
  if (!removed.every((word) => GREETING_WORDS.has(word))) return false;

  const kept = original.slice(original.length - shortened.length);

  return kept.every((word, index) => word === shortened[index]);
}

function countOf(text, pattern) {
  return (asText(text).match(pattern) ?? []).length;
}

function uppercaseCount(text) {
  return countOf(text, /[A-Z]/g);
}

/** Marks the user took out wholesale. A partial removal teaches nothing yet. */
function punctuationNotes(before, after) {
  const notes = [];
  const removed = (pattern) => countOf(before, pattern) > 0 && countOf(after, pattern) === 0;

  if (removed(/!/g)) notes.push(CORRECTION.NO_EXCLAMATIONS);
  if (removed(/;/g)) notes.push(CORRECTION.NO_SEMICOLONS);
  if (removed(/\.{3}|…/g)) notes.push(CORRECTION.NO_ELLIPSES);

  return notes;
}

/** Only when the two texts differ by case ALONE — otherwise it is not a case edit. */
function caseNotes(before, after) {
  if (before === after) return [];
  if (asText(before).toLowerCase() !== asText(after).toLowerCase()) return [];

  return uppercaseCount(after) < uppercaseCount(before) ? [CORRECTION.LOWERCASE] : [];
}

/**
 * Generated vs edited -> the notes worth learning. Returns [] for a content
 * edit, for an unrecognised change, and for anything it cannot be sure about.
 */
export function classifyEdit(generatedBody, editedBody) {
  const before = asText(generatedBody);
  const after = asText(editedBody);

  if (before.trim() === '' || after.trim() === '' || before === after) return [];

  const original = splitDraftGreeting(before);
  const edited = splitEditGreeting(after, original.greeting !== '');
  const notes = [];

  if (original.greeting !== edited.greeting) {
    // A greeting changed in any other way is a content edit as far as we know.
    if (!isGreetingShortenedToName(original.greeting, edited.greeting)) return [];
    notes.push(CORRECTION.SHORT_GREETING);
  }

  // The letter itself: identical words, or we learn nothing at all from this edit.
  if (!sameWords(original.rest, edited.rest)) return [];

  notes.push(...punctuationNotes(original.rest, edited.rest));
  notes.push(...caseNotes(original.rest, edited.rest));

  return [...new Set(notes)];
}

/** The newest voice profile row for this user. Owner-scoped; null if there is none. */
async function findLatestProfile(userId) {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from('voice_profiles')
      .select('id, user_id, profile_json')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    return error ? null : (data ?? null);
  } catch {
    // Swallowed rather than logged: a driver message can quote the row it read.
    return null;
  }
}

/** True when the write landed. Owner-scoped on the write itself, not just the read. */
async function saveProfileJson(userId, profileId, profileJson) {
  try {
    const { error } = await getSupabaseAdmin()
      .from('voice_profiles')
      .update({ profile_json: profileJson })
      .eq('id', profileId)
      .eq('user_id', userId);

    return !error;
  } catch {
    return false;
  }
}

function currentCorrections(profileJson) {
  const stored = profileJson?.learned_corrections;

  return Array.isArray(stored) ? stored.filter((note) => typeof note === 'string') : [];
}

/**
 * Learn from one edit. Never throws and never blocks the edit that triggered it:
 * a profile we could not read or write costs the user a hint, not their letter.
 *
 * FIFO at 20 (CLAUDE.md §3): new notes go on the end and the oldest fall off the
 * front. A note already on the list is not re-appended — twenty slots spent on
 * one repeated observation would teach the model nothing it does not know.
 */
export async function recordEditCorrections(userId, generatedBody, editedBody) {
  if (typeof userId !== 'string' || userId.trim() === '') return { learned: 0 };

  const notes = classifyEdit(generatedBody, editedBody);
  if (notes.length === 0) return { learned: 0 };

  const profile = await findLatestProfile(userId);
  if (!profile) return { learned: 0 };

  const existing = currentCorrections(profile.profile_json);
  const fresh = notes.filter((note) => !existing.includes(note));
  if (fresh.length === 0) return { learned: 0 };

  const learned = [...existing, ...fresh].slice(-MAX_LEARNED_CORRECTIONS);
  const nextProfile = { ...(profile.profile_json ?? {}), learned_corrections: learned };

  if (!(await saveProfileJson(userId, profile.id, nextProfile))) {
    // Counts only: the driver's message can quote the row it was writing.
    logger.warn('voice_correction_failed', { userId, count: fresh.length });

    return { learned: 0 };
  }

  logger.info('voice_corrections_learned', { userId, count: fresh.length });

  return { learned: fresh.length };
}
