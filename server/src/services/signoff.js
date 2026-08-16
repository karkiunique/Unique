/**
 * The sign-off guardrail (CLAUDE.md §3: "Every generated email must sign off as
 * the user, by name").
 *
 * Kept out of generate.js so both the prompt builder and the post-generation
 * check read the profile the same way, and so the matching rules are testable
 * without a model call.
 *
 * Everything here is defensive. `signoff_styles` comes from a model-authored
 * profile row, so it may be absent, empty, or the wrong type — and when there is
 * nothing to match against, the answer is "no violation", never a blocked
 * generation.
 *
 * THE NAME IS THE FLOOR (Decisions, 2026-08-13). Style matching alone left a
 * brand-new user with no `signoff_styles` — and usually no exemplars either —
 * with no enforcement at all, silently. `profiles.full_name` is checked for
 * EVERY user; the style check stays on top of it wherever styles exist. A null
 * name (a pre-006 account, not yet prompted) falls back to exactly the old
 * style-based behaviour: it must never throw and never block a send.
 */

const TAIL_LINES = 4;
// A trailing unsubscribe footer, stripped before the tail is read: it is written
// by the system, so it can never be the writer's sign-off. Compose no longer
// appends one (Decisions, 2026-08-06) and this is then a no-op — but Phase 4
// batch sending reinstates the footer, and the check must read the same either way.
const UNSUBSCRIBE_TAIL = /\n+don[’']?t want emails from me\?[\s\S]*$/i;
// A closing that ends on a comma or a dash is waiting for a name. One that ends
// on a word ("cheers", or the name itself) already stands on its own.
const AWAITS_NAME = /[,—–-]\s*$/;

const SIGNOFF_VIOLATION =
  'the body must end with the closing this person actually uses, followed by their own name on the last line — closing plus name, and nothing after it';

// Carries no name: violations are fed back into a retry prompt and returned to
// the caller, and the prompt already states the name in its SIGN-OFF section.
const NAME_VIOLATION =
  'the body must be signed with the sender\'s own name on the last line — the exact name given in the sign-off instructions, spelled the same way';

// A name is signed if it appears as a whole word, so "Ana" does not match inside
// "Anastasia". Built from the normalized tail, which is already lower case.
const NOT_WORD = '[^\\p{L}\\p{N}]';

// A single initial matches far too much prose to stand as evidence of a signature.
const MIN_FIRST_NAME_LENGTH = 2;

function normalize(text) {
  return String(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

function hasWordCharacter(text) {
  return /[\p{L}\p{N}]/u.test(text);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The user's own closings, cleaned of anything unusable. Never throws. */
export function signoffStyles(profileJson) {
  const raw = profileJson?.signoff_styles;
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((style) => typeof style === 'string')
    .map((style) => style.trim())
    .filter((style) => style !== '');
}

/** The sign-off name, cleaned. '' when there is none. Never throws. */
export function signoffName(senderName) {
  return typeof senderName === 'string' ? senderName.replace(/\s+/g, ' ').trim() : '';
}

/**
 * The forms of their name that count as a signature: the whole name, or the
 * first name on its own.
 *
 * WHY BOTH: people sign cold email with their first name — "Unique Karki" signs
 * "Unique" — so demanding the full name would flag the most ordinary sign-off
 * there is. Why not any part of it: accepting the surname alone, or any token,
 * loosens this until almost any tail passes, and the point of the check is that
 * it catches an unsigned letter.
 */
export function signoffNameForms(senderName) {
  const full = signoffName(senderName);
  if (full === '') return [];

  const first = full.split(' ')[0];
  const forms = [full];
  if (first !== full && first.length >= MIN_FIRST_NAME_LENGTH) forms.push(first);

  return forms;
}

function isSignedWithName(tail, nameForms) {
  return nameForms.some((form) => {
    const needle = escapeRegExp(normalize(form));

    return new RegExp(`(?:^|${NOT_WORD})${needle}(?:${NOT_WORD}|$)`, 'u').test(tail);
  });
}

function bodyTail(body) {
  const lines = body
    .replace(UNSUBSCRIBE_TAIL, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

  return normalize(lines.slice(-TAIL_LINES).join(' '));
}

function isSignedOff(tail, styles) {
  for (const style of styles) {
    const needle = normalize(style);
    if (needle === '') continue;

    const at = tail.indexOf(needle);
    if (at === -1) continue;

    // A multi-line style already carries the name inside it.
    if (style.includes('\n')) return true;
    if (!AWAITS_NAME.test(style)) return true;

    // A bare "Best," is not a signature. Something has to follow it.
    if (hasWordCharacter(tail.slice(at + needle.length))) return true;
  }

  return false;
}

/**
 * Violations for a draft that does not sign off as the user. Same shape as
 * findBannedPhrases(): a list the retry prompt can consume, empty when clean.
 *
 * Two checks, and they are independent. The NAME is the floor and applies to
 * every user who has one, styles or no styles. The STYLE check is additional,
 * and runs wherever the profile actually names their closings.
 */
export function findMissingSignoff(draft, profileJson, senderName) {
  const styles = signoffStyles(profileJson);
  const nameForms = signoffNameForms(senderName);

  // Neither a name nor a closing to match against — do not block a generation on
  // a check we cannot make.
  if (styles.length === 0 && nameForms.length === 0) return [];

  const body = typeof draft?.body === 'string' ? draft.body : '';
  if (body.trim() === '') return [];

  const tail = bodyTail(body);
  const violations = [];

  if (nameForms.length > 0 && !isSignedWithName(tail, nameForms)) {
    violations.push(NAME_VIOLATION);
  }
  if (styles.length > 0 && !isSignedOff(tail, styles)) {
    violations.push(SIGNOFF_VIOLATION);
  }

  return violations;
}
