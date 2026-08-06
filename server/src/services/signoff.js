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
 */

const TAIL_LINES = 4;
// The line appendUnsubscribeLine() adds. Stripped before the tail is read: it is
// written by the system, so it can never be the writer's sign-off.
const UNSUBSCRIBE_TAIL = /\n+don[’']?t want emails from me\?[\s\S]*$/i;
// A closing that ends on a comma or a dash is waiting for a name. One that ends
// on a word ("cheers", or the name itself) already stands on its own.
const AWAITS_NAME = /[,—–-]\s*$/;

const SIGNOFF_VIOLATION =
  'the body must end with the closing this person actually uses, followed by their own name on the last line — closing plus name, and nothing after it';

function normalize(text) {
  return String(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

function hasWordCharacter(text) {
  return /[\p{L}\p{N}]/u.test(text);
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
 */
export function findMissingSignoff(draft, profileJson) {
  const styles = signoffStyles(profileJson);
  // Nothing to match against — do not block a generation on a check we cannot make.
  if (styles.length === 0) return [];

  const body = typeof draft?.body === 'string' ? draft.body : '';
  if (body.trim() === '') return [];

  return isSignedOff(bodyTail(body), styles) ? [] : [SIGNOFF_VIOLATION];
}
