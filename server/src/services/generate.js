import { getAnthropic, getModel } from '../lib/anthropic.js';
import { logger } from '../lib/logger.js';
import { httpError } from '../lib/httpError.js';
import { signToken } from '../lib/unsubscribe.js';
import { loadProfileWithExemplars, parseProfileJson } from './voice.js';
import { findMissingSignoff } from './signoff.js';
import {
  DRAFT_SYSTEM_PROMPT,
  buildDraftUserPrompt,
  FIDELITY_SYSTEM_PROMPT,
  buildFidelityUserPrompt
} from './generatePrompts.js';

/**
 * Single-email generation in the user's voice (CLAUDE.md §3).
 *
 * Two guardrails, one retry each:
 *  - deterministic checks in code, no model round trip: banned phrases, and a
 *    body that does not sign off as the user. They share the one retry;
 *  - a fidelity score from a second lightweight model call.
 * Neither ever blocks: a low score is SURFACED to the user, not thrown, because
 * the human reviews and confirms every send anyway.
 *
 * The decrypted exemplars are the few-shot anchors. They exist in memory for the
 * life of the call, go to the Anthropic API and nowhere else — never to the DB,
 * never to logs, never into an error message.
 */

export const MIN_FIDELITY_SCORE = 80;

export const BANNED_PHRASES = [
  'i hope this email finds you well',
  "i know you're busy",
  "i'll keep this brief",
  'delve',
  'leverage'
];

// Banned only when the user's OWN writing never uses them (CLAUDE.md §3).
const CONDITIONAL_PHRASES = new Set(['delve', 'leverage']);
const BANNED_SUBJECT = 'quick question';

const DRAFT_MAX_TOKENS = 1200;
const FIDELITY_MAX_TOKENS = 500;
const DEFAULT_APP_URL = 'http://localhost:5173';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function extractText(response) {
  const blocks = response?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

async function callModel(system, userPrompt, maxTokens) {
  const response = await getAnthropic().messages.create({
    model: getModel(),
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: userPrompt }]
  });

  return extractText(response);
}

function normalizeDraft(parsed) {
  const subject = typeof parsed?.subject === 'string' ? parsed.subject.trim() : '';
  const body = typeof parsed?.body === 'string' ? parsed.body.trim() : '';

  if (subject === '' || body === '') {
    throw httpError(502, 'The model did not return a usable subject and body');
  }

  return { subject, body };
}

async function draftOnce(context, violations) {
  const text = await callModel(
    DRAFT_SYSTEM_PROMPT,
    buildDraftUserPrompt({ ...context, violations }),
    DRAFT_MAX_TOKENS
  );

  let parsed;
  try {
    parsed = parseProfileJson(text);
  } catch {
    // The raw text is derived from the user's own writing: never echo it.
    throw httpError(502, 'The model did not return valid JSON');
  }

  return normalizeDraft(parsed);
}

/** Everything the user themselves writes, lowercased — the conditional allowlist. */
function ownWords(profileJson, exemplars) {
  return `${JSON.stringify(profileJson ?? {})}\n${exemplars.join('\n')}`.toLowerCase();
}

/** Deterministic guardrail. Returns a violation list the retry prompt can consume. */
export function findBannedPhrases(draft, ownText = '') {
  const haystack = `${draft?.subject ?? ''}\n${draft?.body ?? ''}`.toLowerCase();
  const hits = [];

  for (const phrase of BANNED_PHRASES) {
    if (CONDITIONAL_PHRASES.has(phrase) && ownText.includes(phrase)) continue;
    if (haystack.includes(phrase)) hits.push(`never use the phrase "${phrase}"`);
  }

  if (String(draft?.subject ?? '').trim().toLowerCase() === BANNED_SUBJECT) {
    hits.push(`the subject must not be "${BANNED_SUBJECT}"`);
  }

  return hits;
}

async function scoreFidelity(context, draft) {
  const text = await callModel(
    FIDELITY_SYSTEM_PROMPT,
    buildFidelityUserPrompt({ ...context, draft }),
    FIDELITY_MAX_TOKENS
  );

  let parsed;
  try {
    parsed = parseProfileJson(text);
  } catch {
    // An unscoreable draft is not a failed draft. Surface "unknown", never throw.
    return { score: null, violations: [] };
  }

  const raw = Number(parsed?.score_0to100);
  const score = Number.isFinite(raw) ? Math.max(0, Math.min(100, Math.round(raw))) : null;
  const violations = Array.isArray(parsed?.violations)
    ? parsed.violations.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
    : [];

  return { score, violations };
}

function appUrl() {
  return (process.env.APP_URL || DEFAULT_APP_URL).replace(/\/+$/, '');
}

/** CLAUDE.md §3: every generated body ends with exactly this line. */
export function appendUnsubscribeLine(body, userId, to) {
  const token = signToken({ u: userId, e: to });

  return `${body.replace(/\s+$/, '')}\n\nDon't want emails from me? [Unsubscribe](${appUrl()}/u/${token})`;
}

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

  const context = {
    profileJson,
    exemplars,
    recipient: {
      email: to,
      name: typeof input.recipientName === 'string' ? input.recipientName.trim() : '',
      company: typeof input.company === 'string' ? input.company.trim() : ''
    },
    goal
  };

  const ownText = ownWords(profileJson, exemplars);
  // Both code-side guardrails, in one list: they share the single retry rather
  // than each buying the user another round trip.
  const checkGuardrails = (candidate) => [
    ...findBannedPhrases(candidate, ownText),
    ...findMissingSignoff(candidate, profileJson)
  ];

  let draft = await draftOnce(context, []);
  let guardrail = checkGuardrails(draft);
  if (guardrail.length > 0) {
    draft = await draftOnce(context, guardrail);
    guardrail = checkGuardrails(draft);
  }

  let fidelity = await scoreFidelity(context, draft);
  if (fidelity.score !== null && fidelity.score < MIN_FIDELITY_SCORE) {
    draft = await draftOnce(context, [...guardrail, ...fidelity.violations]);
    guardrail = checkGuardrails(draft);
    fidelity = await scoreFidelity(context, draft);
  }

  const violations = [...guardrail, ...fidelity.violations];

  // Counts and the score only — no subject, no body, no exemplar text.
  logger.info('email_generated', { userId, score: fidelity.score, count: violations.length });

  return {
    subject: draft.subject,
    body: appendUnsubscribeLine(draft.body, userId, to),
    fidelityScore: fidelity.score,
    violations
  };
}
