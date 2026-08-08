import { PERSONALIZED_MARKER } from './campaigns.js';

/**
 * Template-mode merge variables (CLAUDE.md §3).
 *
 * MERGE VARS ARE SUBSTITUTED HERE, IN CODE, NEVER BY THE MODEL. That is not a
 * style preference — it is the whole reason template mode can be trusted. A
 * model that is allowed to fill in "{{company}}" is a model that can get the
 * company wrong, and a wrong company name goes out under the user's own name and
 * cannot be recalled.
 *
 * A lead with no value for a variable its template uses is FAILED, never sent
 * with a blank: "Hi ," under someone's name is worse than not sending at all.
 *
 * Nothing in this module logs. A lead's name and employer are third-party
 * personal data and are covered by CLAUDE.md § Privacy exactly like an email
 * body — they are handled in memory and handed to the caller, nowhere else.
 */

/** The only variables ever substituted, and the lead column each one reads. */
export const MERGE_FIELDS = ['first_name', 'company', 'title'];

// Whitespace is tolerated inside the braces because a person typing the template
// by hand writes {{ first_name }} as readily as {{first_name}}.
const MERGE_PATTERN = /\{\{\s*(first_name|company|title)\s*\}\}/g;

function valueFor(lead, field) {
  const value = lead?.[field];

  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);

  return '';
}

/** The merge variables a template actually uses, in first-appearance order. */
export function findMergeVars(text) {
  const found = [];

  for (const match of String(text ?? '').matchAll(MERGE_PATTERN)) {
    if (!found.includes(match[1])) found.push(match[1]);
  }

  return found;
}

/** Variables this text needs and this lead cannot fill. Empty means safe to merge. */
export function findMissingMergeVars(text, lead) {
  return findMergeVars(text).filter((field) => valueFor(lead, field) === '');
}

/**
 * Substitute in code. Call only after findMissingMergeVars() has come back
 * empty — a variable with no value would otherwise collapse to nothing.
 */
export function applyMergeVars(text, lead) {
  return String(text ?? '').replace(MERGE_PATTERN, (_match, field) => valueFor(lead, field));
}

/**
 * The user's template around its {{personalized}} markers. The result always has
 * one more segment than there are markers, so the letter rebuilds by interleaving.
 */
export function splitOnPersonalized(template) {
  return String(template ?? '').split(PERSONALIZED_MARKER);
}

/** Interleave the model's sections back into the user's own frame. */
export function fillPersonalized(segments, sections) {
  const parts = [segments[0] ?? ''];

  for (let index = 1; index < segments.length; index += 1) {
    parts.push(sections[index - 1] ?? '', segments[index]);
  }

  return parts.join('');
}
