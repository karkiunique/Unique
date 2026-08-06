/**
 * Defensive readers for a voice profile's `profile_json`.
 *
 * Every field in there was written by the model, so any of them may be absent,
 * null, or the wrong type. These readers return something usable or nothing at
 * all: a malformed profile has to render short, never crash.
 */

/** The profile_json object, or an empty one if the row is malformed. */
export function profileJsonOf(profile) {
  const json = profile?.profile_json;
  return json && typeof json === 'object' && !Array.isArray(json) ? json : {};
}

/** A trimmed non-empty string, a finite number as a string, or null. */
export function textValue(value) {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** Only the entries that read as text. A non-array is simply an empty list. */
export function listValue(value) {
  if (!Array.isArray(value)) return [];
  return value.map(textValue).filter((entry) => entry !== null);
}

/** A finite number, or null. Strings are NOT coerced — a count has to be a count. */
export function numberValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** "38–130, ~74 words" from typical_length_words, with any part possibly missing. */
export function lengthRange(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const min = numberValue(value.min);
  const max = numberValue(value.max);
  const median = numberValue(value.median);
  const parts = [];

  if (min !== null && max !== null) parts.push(`${min}–${max}`);
  else if (min !== null) parts.push(`from ${min}`);
  else if (max !== null) parts.push(`up to ${max}`);

  if (median !== null) parts.push(`~${median}`);

  return parts.length > 0 ? `${parts.join(', ')} words` : null;
}
