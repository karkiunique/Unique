import { logger } from '../lib/logger.js';
import { httpError } from '../lib/httpError.js';
import { loadProfileWithExemplars } from './voice.js';
import { draftInVoice } from './generateCore.js';

/**
 * Single-email generation in the user's voice (CLAUDE.md §3).
 *
 * The drafting machinery itself lives in generateCore.js, shared with the
 * campaign batch: two guardrails with one retry each (deterministic checks in
 * code — banned phrases and a body that does not sign off as the user — plus a
 * fidelity score from a second lightweight model call). Neither ever throws
 * here: a low score is SURFACED to the user, because the human reviews and
 * confirms every send anyway.
 *
 * The decrypted exemplars are the few-shot anchors. They exist in memory for the
 * life of the call, go to the Anthropic API and nowhere else — never to the DB,
 * never to logs, never into an error message.
 */

export { BANNED_PHRASES, MIN_FIDELITY_SCORE, findBannedPhrases } from './generateCore.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Draft one email for one recipient. Returns the fidelity score alongside the
 * draft so the review UI can warn before a human confirms the send.
 */
export async function generateEmail(userId, input = {}) {
  if (typeof userId !== 'string' || userId === '') {
    throw httpError(400, 'A userId is required');
  }

  const to = typeof input.to === 'string' ? input.to.trim() : '';
  const goal = typeof input.goal === 'string' ? input.goal.trim() : '';

  if (!EMAIL_PATTERN.test(to)) {
    throw httpError(400, 'A valid recipient email address is required');
  }
  if (goal === '') {
    throw httpError(400, 'A goal for the email is required');
  }

  const { profileJson, exemplars } = await loadProfileWithExemplars(userId);

  const { draft, fidelityScore, violations } = await draftInVoice({
    profileJson,
    exemplars,
    recipient: {
      email: to,
      name: typeof input.recipientName === 'string' ? input.recipientName.trim() : '',
      company: typeof input.company === 'string' ? input.company.trim() : ''
    },
    goal
  });

  // Counts and the score only — no subject, no body, no exemplar text.
  logger.info('email_generated', { userId, score: fidelityScore, count: violations.length });

  return {
    subject: draft.subject,
    body: draft.body,
    fidelityScore,
    violations
  };
}
