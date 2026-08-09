/**
 * What a letter is, in the terms every screen that shows one needs.
 *
 * The list, the single-letter reviewer and the review deck all have to agree on
 * the same three answers: what would actually be sent, whether the model's score
 * is low enough to warrant a close read, and whether the letter is still the
 * reviewer's to change. Three answers, one place — a second copy of any of them
 * is how two screens end up disagreeing about the same recipient.
 */

/** Below this the draft is flagged for a close read (CLAUDE.md § 3). */
export const LOW_FIDELITY = 80;

// Statuses where the letter is still the reviewer's to change.
const OPEN_STATUSES = ['generated', 'approved'];

export function textOf(value) {
  return typeof value === 'string' ? value : '';
}

export function fullName(lead) {
  return [lead?.first_name, lead?.last_name]
    .filter((part) => typeof part === 'string' && part.trim() !== '')
    .join(' ');
}

/** What would actually be sent: the user's edit wins over the model's draft. */
export function letterOf(lead) {
  const edited = textOf(lead?.edited_body);

  return {
    subject: textOf(lead?.generated_subject),
    body: edited.trim() === '' ? textOf(lead?.generated_body) : edited
  };
}

export function statusOf(lead) {
  return textOf(lead?.status) || 'pending';
}

export function isOpenForReview(lead) {
  return OPEN_STATUSES.includes(statusOf(lead));
}

/** The score the model gave, or null — never a number invented for a lead with none. */
export function scoreOf(lead) {
  const score = lead?.fidelity_score;

  return typeof score === 'number' ? score : null;
}

export function isLowFidelity(lead) {
  const score = scoreOf(lead);

  return score !== null && score < LOW_FIDELITY;
}
