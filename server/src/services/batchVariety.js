/**
 * Batch variety and variant tagging (CLAUDE.md, Decisions 2026-08-12 — "Batch
 * variety, and the outcome-adaptation loop it feeds").
 *
 * THE MEASURED PROBLEM. Nothing in a generation prompt knew what the other
 * letters in the same run said. A real six-lead batch opened four letters with
 * the same sentence and repeated five phrases across all six. Every letter was
 * individually faithful to the voice; together they read as machine-written.
 *
 * VARIETY WITHIN THE VOICE, NEVER AWAY FROM IT. Every alternative offered here is
 * drawn from the user's own `sentence_starters` and `how_they_ask`. Nothing in
 * this module invents a construction, and the prompt says so twice: six distinct
 * openers that are not theirs is a worse failure than six identical ones that
 * are. Voice fidelity is the product.
 *
 * CORRECT UNDER CONCURRENCY 3, BY BEING BORING. A slot is RESERVED when a lead's
 * work starts, not recorded when its letter comes back. reserve() does its whole
 * read-modify-write in a single synchronous turn, which cannot interleave on a
 * single-threaded runtime, and nothing is written back on completion — so a lead
 * that finishes out of order has nothing to corrupt. Each lead then carries its
 * own assignment in a closure, so one lead's variant can never be attributed to
 * another. Assignment is plain round-robin over the user's own lists, which makes
 * the whole run deterministic and reproducible from the lead order alone.
 *
 * PRIVACY. This module reads the user's own profile entries and counts words in a
 * draft body. It logs nothing, and the variant record it returns carries no
 * recipient data and no generated content — profile references, a band and a
 * version number.
 */

/** Enough to give a batch room to move without bloating every prompt. */
const MAX_LISTED = 12;

/** Quoted spans inside `how_they_ask` — straight and curly quotes alike. */
const QUOTED_EXAMPLE = /["“”]([^"“”]{3,120})["“”]/g;

const SHORT_BELOW = 0.8;
const LONG_ABOVE = 1.2;

export const VARIETY_HEADING = 'BATCH VARIETY';
export const USED_OPENERS_HEADING = 'Openers already used in this run';
export const OPENER_CHOICE_HEADING =
  'Open the first sentence after the greeting with this construction of theirs:';
export const USED_ASKS_HEADING = 'Ask forms already used in this run';
export const ASK_CHOICE_HEADING = 'Make the ask in this form of theirs:';

const OWN_OPENERS_HEADING =
  "Every opening available to you. These are this person's own — never write one that is not here:";
const OWN_ASKS_HEADING =
  "Every ask form available to you. These are this person's own — never write one that is not here:";

const VARIETY_INTRO = [
  `${VARIETY_HEADING} — this letter is one of several written in the same run, and they go out`,
  'together. They must not read as one letter with the recipient names swapped.',
  '',
  "Vary WITHIN this person's voice, never away from it. Every construction listed below is taken",
  'from their own writing. Do not invent an opening or an ask that is not on these lists, and do',
  'not reach for a more "original" phrasing — a letter that does not sound like them is a worse',
  'failure than two letters that sound alike.'
].join('\n');

const USED_OPENERS_FRESH = `${USED_OPENERS_HEADING} — do not open with one of these, and do not reword one:`;
const USED_OPENERS_SPENT =
  `${USED_OPENERS_HEADING}. Every opening this person uses has now appeared in this run, so reuse` +
  '\nthe one named below rather than inventing a new one, and make what follows it different:';
const USED_ASKS_FRESH = `${USED_ASKS_HEADING} — make your ask in a different one of their forms:`;
const USED_ASKS_SPENT =
  `${USED_ASKS_HEADING}. Every ask form this person uses has now appeared in this run, so reuse the` +
  '\none named below rather than inventing a new one, and word it differently:';

/** Distinct, non-empty strings from a model-authored profile list. Never throws. */
function cleanList(raw) {
  const seen = new Set();
  const list = [];

  for (const entry of Array.isArray(raw) ? raw : []) {
    if (typeof entry !== 'string') continue;

    const value = entry.trim();
    const key = value.toLowerCase();
    if (value === '' || seen.has(key)) continue;

    seen.add(key);
    list.push(value);
    if (list.length === MAX_LISTED) break;
  }

  return list;
}

/** The user's own verbatim openers, as recorded by the voice profile. */
export function ownOpeners(profileJson) {
  return cleanList(profileJson?.sentence_starters);
}

/**
 * `how_they_ask` is one descriptive string in the schema, "with a verbatim
 * example" — so the quoted spans inside it ARE the user's own ask forms, and the
 * description itself is the single form when there are none. Deliberately not
 * split any other way: chopping a description on punctuation would manufacture
 * forms the user never used, which is exactly what this module must not do.
 */
export function ownAskForms(profileJson) {
  const raw = profileJson?.how_they_ask;
  if (Array.isArray(raw)) return cleanList(raw);
  if (typeof raw !== 'string' || raw.trim() === '') return [];

  const quoted = [...raw.matchAll(QUOTED_EXAMPLE)].map((match) => match[1]);

  return quoted.length > 0 ? cleanList(quoted) : cleanList([raw]);
}

function section(heading, items) {
  return items.length === 0 ? [] : [heading, ...items.map((item) => `- ${item}`)];
}

function buildVarietyBlock({ openers, askForms, opener, cta, usedOpeners, usedAsks, position }) {
  // Nothing of theirs to draw on: say nothing rather than invent a list. The
  // prompt then reads exactly as it did before variety existed.
  if (openers.length === 0 && askForms.length === 0) return '';

  const lines = [VARIETY_INTRO];
  const add = (block) => {
    if (block.length > 0) lines.push('', ...block);
  };

  add(section(position >= openers.length ? USED_OPENERS_SPENT : USED_OPENERS_FRESH, usedOpeners));
  add(section(OPENER_CHOICE_HEADING, opener ? [opener] : []));
  add(section(OWN_OPENERS_HEADING, openers));
  add(section(position >= askForms.length ? USED_ASKS_SPENT : USED_ASKS_FRESH, usedAsks));
  add(section(ASK_CHOICE_HEADING, cta ? [cta] : []));
  add(section(OWN_ASKS_HEADING, askForms));

  return lines.join('\n');
}

function pickAt(list, position) {
  return list.length === 0 ? null : list[position % list.length];
}

/**
 * What earlier leads in this run were given. Once the list is spent every entry
 * has been used, and the block switches to its reuse wording rather than asking
 * for something that does not exist.
 */
function usedBefore(list, position) {
  return list.slice(0, Math.min(position, list.length));
}

/**
 * The variety state for one run. Hand the same ledger to every lead in the batch
 * and call reserve() once per lead, before its first model call.
 */
export function createVarietyLedger(profileJson) {
  const openers = ownOpeners(profileJson);
  const askForms = ownAskForms(profileJson);
  let reserved = 0;

  return {
    reserve() {
      // Read, assign, advance — one synchronous turn, so three in-flight leads
      // cannot interleave inside it and no lock is needed.
      const position = reserved;
      reserved += 1;

      const opener = pickAt(openers, position);
      const cta = pickAt(askForms, position);

      return {
        openerStarter: opener,
        ctaForm: cta,
        promptBlock: buildVarietyBlock({
          openers,
          askForms,
          opener,
          cta,
          usedOpeners: usedBefore(openers, position),
          usedAsks: usedBefore(askForms, position),
          position
        })
      };
    }
  };
}

function medianWords(profileJson) {
  const median = Number(profileJson?.typical_length_words?.median);

  return Number.isFinite(median) && median > 0 ? median : null;
}

/**
 * OBSERVED, not steered. Length is already tied to the user's own median by the
 * fidelity check (median ±40%), so a length instruction in the prompt would pull
 * against it. This records where the letter actually landed. Null when the
 * profile has no median to measure against — an unknown band, not a guessed one.
 */
export function lengthBand(body, profileJson) {
  const median = medianWords(profileJson);
  const text = typeof body === 'string' ? body.trim() : '';
  if (median === null || text === '') return null;

  const words = text.split(/\s+/).length;
  if (words < median * SHORT_BELOW) return 'short';
  if (words > median * LONG_ABOVE) return 'long';

  return 'mid';
}

/**
 * The `leads.variant_json` row value (migration 005). Written on the same update
 * as the body so a letter and its variant can never disagree.
 *
 * `assignment` is null where there was no batch to vary against — template mode,
 * whose letter is the user's own, and a single redraft from the review screen.
 * The opener and ask are then honestly recorded as unknown rather than borrowed
 * from a letter that no longer exists.
 */
export function variantRecord({ assignment, body, profileJson, profileVersion }) {
  // Guard the null before coercing: Number(null) is 0 and 0 is finite, which would
  // record a profile of unknown version as a real generation-0 cohort.
  const version = profileVersion == null ? null : Number(profileVersion);

  return {
    opener_starter: assignment?.openerStarter ?? null,
    cta_form: assignment?.ctaForm ?? null,
    length_band: lengthBand(body, profileJson),
    // Variant performance is not comparable across a re-synced profile.
    profile_version: Number.isFinite(version) ? version : null
  };
}
