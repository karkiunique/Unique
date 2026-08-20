import { ROLE_LOCAL_PARTS } from './recipientCheck.js';

/**
 * The eight gates that define a SOLID lead (CLAUDE.md, Decisions 2026-08-16).
 *
 * All must pass. One failure and the lead never reaches the review queue.
 *
 * THE RULE THIS MODULE EXISTS TO PROTECT: "~2 a day" is a CEILING, NOT A QUOTA.
 * Nothing here may be relaxed to hit a number. The moment a gate is softened
 * because a run came up short, the queue fills with leads the user rejects — which
 * is the exact failure the whole design is meant to prevent. A run that delivers
 * nothing is a valid outcome and is recorded as `empty`, not `failed`.
 *
 * Gates 1-7 screen a candidate BEFORE a draft is generated, because generating is
 * the expensive step. Gate 8 is applied after, by the job, and blocks rather than
 * flags — see `passesFidelityGate`.
 */

export const GATE = {
  DELIVERABLE: 'deliverable',
  ROLE_INBOX: 'role_inbox',
  DUPLICATE: 'duplicate',
  UNSUBSCRIBED: 'unsubscribed',
  ROLE_MATCH: 'role_match',
  COMPANY_MATCH: 'company_match',
  HOOK: 'hook',
  FIDELITY: 'fidelity'
};

/** § 3: the batch screen flags below 80; this queue refuses. */
export const FIDELITY_FLOOR = 80;

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function localPartOf(email) {
  const at = email.lastIndexOf('@');
  return at === -1 ? '' : email.slice(0, at).split('+')[0];
}

function domainOf(email) {
  const at = email.lastIndexOf('@');
  return at === -1 ? '' : email.slice(at + 1);
}

/** Lowercased, blank-free list. Absent criteria are NOT constraints. */
function asList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '');
}

/**
 * An EMPTY criterion is "no constraint", not "matches nothing".
 *
 * A user who names no industries has not said "no industry qualifies" — they have
 * said nothing about industry, and the other gates still apply. Treating absence
 * as a rejection would make a sparse target deliver zero leads forever, which is
 * the sparse-profile failure CLAUDE.md forbids: degrade to less filtering, never
 * to a dead end.
 */
function matchesAny(value, criteria) {
  if (criteria.length === 0) return true;
  if (typeof value !== 'string' || value.trim() === '') return false;

  const haystack = value.toLowerCase();

  return criteria.some((needle) => haystack.includes(needle));
}

/**
 * Gate 1 — deliverable.
 *
 * Requires a POSITIVE verdict. `unknown`, `catch_all` and `risky` all fail: a
 * bounce lands on the user's OWN Gmail reputation (Decisions 2026-08-05), and at
 * two sends a day that is unaffordable. Absent a verdict entirely, the lead is not
 * verified and therefore not solid — silence is not a pass.
 */
function passesDeliverable(candidate) {
  return candidate?.verification?.status === 'deliverable';
}

/** Gate 2 — never a shared inbox. `info@`, `sales@`, `support@`. */
function passesNotRoleInbox(email) {
  return !ROLE_LOCAL_PARTS.has(localPartOf(email));
}

/** Gate 5 — the person. Title text is matched loosely; seniority must be explicit. */
function passesRoleMatch(candidate, target) {
  return (
    matchesAny(candidate?.title, asList(target?.titles)) &&
    matchesAny(candidate?.seniority, asList(target?.seniority))
  );
}

/**
 * Gate 6 — the company, INCLUDING the negative criteria.
 *
 * Exclusions are checked first and are absolute: a competitor or an existing
 * customer is wrong however well it matches everything else.
 */
function passesCompanyMatch(candidate, target, email) {
  const excludedDomains = asList(target?.exclude_domains);
  const domain = domainOf(email);
  if (excludedDomains.some((blocked) => domain === blocked || domain.endsWith(`.${blocked}`))) {
    return false;
  }

  const excludedIndustries = asList(target?.exclude_industries);
  if (excludedIndustries.length > 0 && matchesAny(candidate?.industry, excludedIndustries)) {
    return false;
  }

  return (
    matchesAny(candidate?.industry, asList(target?.industries)) &&
    matchesAny(candidate?.geo, asList(target?.geos)) &&
    matchesAny(candidate?.company_size, asList(target?.company_size ? [target.company_size] : []))
  );
}

/**
 * Gate 7 — a personalization hook. THE gate that matters.
 *
 * A verified email and a perfect title with nothing specific to say produces a
 * generic letter, which is exactly what this product exists not to send. So a
 * candidate with no concrete, recent, verifiable fact is NOT solid, however good
 * the firmographics look.
 *
 * A hook must be SPECIFIC — a sentence of real content, not a company name or a
 * one-word tag. The length floor is crude on purpose: it rejects `"growth"` and
 * `"AI"`, which are the shapes a research call returns when it found nothing.
 */
const MIN_HOOK_LENGTH = 24;

function passesHook(candidate) {
  const hooks = Array.isArray(candidate?.research?.hooks) ? candidate.research.hooks : [];

  return hooks.some((hook) => typeof hook === 'string' && hook.trim().length >= MIN_HOOK_LENGTH);
}

/**
 * Screen one candidate against gates 1-7.
 *
 * Returns the FIRST failed gate rather than a boolean, so a run can record why it
 * came up short — which is what tells you whether the ICP is too narrow or the
 * research step is underperforming.
 *
 * @param {object} candidate  from the lead source, already researched
 * @param {object} target     the user's standing ICP
 * @param {object} context    { existingEmails:Set, unsubscribedEmails:Set }
 */
export function screenCandidate(candidate, target, context = {}) {
  const email = normalizeEmail(candidate?.email);

  if (email === '') return { passed: false, failedGate: GATE.DELIVERABLE };
  if (!passesDeliverable(candidate)) return { passed: false, failedGate: GATE.DELIVERABLE };
  if (!passesNotRoleInbox(email)) return { passed: false, failedGate: GATE.ROLE_INBOX };

  const existing = context.existingEmails instanceof Set ? context.existingEmails : new Set();
  if (existing.has(email)) return { passed: false, failedGate: GATE.DUPLICATE };

  const unsubscribed =
    context.unsubscribedEmails instanceof Set ? context.unsubscribedEmails : new Set();
  if (unsubscribed.has(email)) return { passed: false, failedGate: GATE.UNSUBSCRIBED };

  if (!passesRoleMatch(candidate, target)) return { passed: false, failedGate: GATE.ROLE_MATCH };
  if (!passesCompanyMatch(candidate, target, email)) {
    return { passed: false, failedGate: GATE.COMPANY_MATCH };
  }
  if (!passesHook(candidate)) return { passed: false, failedGate: GATE.HOOK };

  return { passed: true, failedGate: null };
}

/**
 * Gate 8 — the draft must sound like the user.
 *
 * BLOCKS, unlike the batch review screen which flags. With two slots a day, a
 * draft that does not sound like them wastes half the day's value. A missing score
 * fails: an unscored draft is not a passing draft.
 */
export function passesFidelityGate(score) {
  return Number.isFinite(score) && score >= FIDELITY_FLOOR;
}

/**
 * How many candidates to screen for a given target.
 *
 * Screening is cheap relative to drafting, and the gates are strict, so the job
 * looks at roughly ten times what it hopes to deliver. Capped so a pathological
 * ICP cannot run up an unbounded vendor bill in one night.
 */
export function screeningBudget(dailyTarget) {
  const wanted = Number.isFinite(dailyTarget) && dailyTarget > 0 ? dailyTarget : 2;

  return Math.min(30, wanted * 10);
}
