import { getAnthropic, getModel } from '../lib/anthropic.js';
import { httpError } from '../lib/httpError.js';
import { parseProfileJson } from './voice.js';
import { findMissingSignoff } from './signoff.js';
import {
  DRAFT_SYSTEM_PROMPT,
  buildDraftUserPrompt,
  FIDELITY_SYSTEM_PROMPT,
  buildFidelityUserPrompt
} from './generatePrompts.js';

/**
 * Generation primitives shared by the one-at-a-time compose flow (generate.js)
 * and the campaign batch (generateBatch.js / generateTemplate.js).
 *
 * EXTRACTED RATHER THAN COPIED. Two implementations of the guardrail and
 * fidelity passes would drift, and voice fidelity is the product: a batch that
 * scored drafts by different rules from compose would quietly send a different
 * person's voice.
 *
 * Everything here handles decrypted exemplars and draft bodies. They live in
 * memory for the life of a call, go to the Anthropic API and nowhere else —
 * never to the DB, never to a log line, never into an error message.
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

function extractText(response) {
  const blocks = response?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

export async function callModel(system, userPrompt, maxTokens) {
  const response = await getAnthropic().messages.create({
    model: getModel(),
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: userPrompt }]
  });

  return extractText(response);
}

/** Model output -> object. The raw text is derived from the user's own writing: never echo it. */
export function parseModelJson(text) {
  try {
    return parseProfileJson(text);
  } catch {
    throw httpError(502, 'The model did not return valid JSON');
  }
}

function normalizeDraft(parsed) {
  const subject = typeof parsed?.subject === 'string' ? parsed.subject.trim() : '';
  const body = typeof parsed?.body === 'string' ? parsed.body.trim() : '';

  if (subject === '' || body === '') {
    throw httpError(502, 'The model did not return a usable subject and body');
  }

  return { subject, body };
}

export async function draftOnce(context, violations) {
  const text = await callModel(
    DRAFT_SYSTEM_PROMPT,
    buildDraftUserPrompt({ ...context, violations }),
    DRAFT_MAX_TOKENS
  );

  return normalizeDraft(parseModelJson(text));
}

/** Everything the user themselves writes, lowercased — the conditional allowlist. */
export function ownWords(profileJson, exemplars) {
  const samples = Array.isArray(exemplars) ? exemplars : [];

  return `${JSON.stringify(profileJson ?? {})}\n${samples.join('\n')}`.toLowerCase();
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

/**
 * Both code-side guardrails, in one list: they share the single retry rather
 * than each buying the user another round trip.
 */
export function buildGuardrailCheck(profileJson, exemplars) {
  const ownText = ownWords(profileJson, exemplars);

  return (candidate) => [
    ...findBannedPhrases(candidate, ownText),
    ...findMissingSignoff(candidate, profileJson)
  ];
}

export async function scoreFidelity(context, draft) {
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

/**
 * One email, written whole in the user's voice: draft, one guardrail retry, one
 * fidelity retry. Never blocks on a low score — it is REPORTED, and the caller
 * decides what that means (compose refuses to send it, the batch flags it for
 * review; CLAUDE.md §3 explains why those differ).
 */
export async function draftInVoice(context) {
  const checkGuardrails = buildGuardrailCheck(context.profileJson, context.exemplars);

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

  return {
    draft,
    fidelityScore: fidelity.score,
    violations: [...guardrail, ...fidelity.violations]
  };
}
