import { logger } from '../lib/logger.js';

/**
 * Where candidates come from — STUBBED (CLAUDE.md, Decisions 2026-08-16).
 *
 * THIS RETURNS NOTHING ON PURPOSE. The lead source is Stage B and is blocked on a
 * licence, not on engineering: Apollo's API terms §2/§3 forbid integrating their
 * API with a product serving other users absent written authorisation, and §5(i)
 * lets them terminate for competing use at their sole discretion. Until that
 * conversation lands, or BYOK is built, there is no legal source to call.
 *
 * Returning `[]` rather than throwing is the same posture `services/leads.js`
 * already takes for Apollo/Tavily: a missing key degrades to less data, never to a
 * crash. A run with no candidates completes as `empty`, which is a valid outcome —
 * so the whole pipeline above this file is exercisable today, on seeded candidates
 * injected by the caller.
 *
 * SCRAPING IS NOT AN ALTERNATIVE HERE and must not be added. It is rejected
 * outright in the Decisions log, not deferred, and spreading it across more actors
 * does not change what it is.
 *
 * WHAT STAGE B ADDS, behind this same signature:
 *   1. vendor search against the structured ICP columns
 *   2. email resolution
 *   3. verification -> candidate.verification.status  (gate 1)
 *   4. Tavily research  -> candidate.research.hooks   (gate 7)
 */

/**
 * The candidate shape the gates expect. Documented here because Stage B must
 * produce exactly this, and `leadGates.js` is where each field is judged.
 *
 * @typedef {object} Candidate
 * @property {string} email
 * @property {string} [first_name]
 * @property {string} [last_name]
 * @property {string} [title]         gate 5
 * @property {string} [seniority]     gate 5
 * @property {string} [company]
 * @property {string} [industry]      gate 6
 * @property {string} [company_size]  gate 6
 * @property {string} [geo]           gate 6
 * @property {{status: string}} [verification]      gate 1
 * @property {{hooks: string[]}} [research]         gate 7
 */

/** True once a real, licensed source is wired. */
export function isLeadSourceConfigured() {
  return false;
}

/**
 * Find up to `budget` candidates matching the target.
 *
 * @param {object} target the user's standing ICP
 * @param {number} budget how many to screen — see `screeningBudget`
 * @returns {Promise<Candidate[]>}
 */
export async function findCandidates(target, budget) {
  if (!isLeadSourceConfigured()) {
    // Counts only: an ICP describes the user's own business.
    logger.info('lead_source_unconfigured', { count: budget ?? 0 });
    return [];
  }

  return [];
}
