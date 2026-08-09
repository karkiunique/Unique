import { httpError } from '../lib/httpError.js';
import {
  MIN_FIDELITY_SCORE,
  callModel,
  parseModelJson,
  ownWords,
  findBannedPhrases,
  scoreFidelity
} from './generateCore.js';
import { PERSONALIZE_SYSTEM_PROMPT, buildPersonalizeUserPrompt } from './generatePrompts.js';
import { applyMergeVars, splitOnPersonalized, fillPersonalized } from './templateMerge.js';

/**
 * Template mode for one lead (CLAUDE.md §3).
 *
 * The user wrote the letter. Only the {{personalized}} gaps go to the model, and
 * the merge variables are already substituted in code by templateMerge.js before
 * anything is sent — the model never sees a raw {{first_name}}.
 *
 * WHY THE GUARDRAIL READS ONLY THE MODEL'S SECTIONS: a retry can change nothing
 * but what the model wrote. Flagging the user's own prose back at the model would
 * spend a round trip per lead and fix nothing. The sign-off check is likewise not
 * applied here — the closing belongs to the user's own template, and the check
 * exists to stop the MODEL sending an unsigned letter under their name, which it
 * cannot do when the user authored the frame.
 *
 * The assembled letter and the decrypted exemplars live in memory only: to the
 * Anthropic API and back to the caller, never to a log line or an error message.
 */

const PERSONALIZE_MAX_TOKENS = 1000;

function gapMarker(index) {
  return `[[PERSONALIZED ${index + 1}]]`;
}

/** The letter as the model sees it: the user's words, with the gaps labelled. */
function markLetterGaps(segments) {
  return fillPersonalized(
    segments,
    segments.slice(1).map((_segment, index) => gapMarker(index))
  );
}

function readSections(text, expected) {
  const raw = parseModelJson(text)?.sections;
  // A single gap sometimes comes back as a bare string rather than a one-item array.
  const list = typeof raw === 'string' ? [raw] : raw;
  const sections = Array.isArray(list) ? list.filter((entry) => typeof entry === 'string') : [];

  if (sections.length !== expected) {
    throw httpError(502, 'The model did not return one section per personalised gap');
  }

  const trimmed = sections.map((entry) => entry.trim());
  if (trimmed.some((entry) => entry === '')) {
    throw httpError(502, 'The model returned an empty personalised section');
  }

  return trimmed;
}

async function personalizeOnce(context, violations) {
  const text = await callModel(
    PERSONALIZE_SYSTEM_PROMPT,
    buildPersonalizeUserPrompt({ ...context, violations }),
    PERSONALIZE_MAX_TOKENS
  );

  return readSections(text, context.sectionCount);
}

/**
 * Fill one lead's template. Returns the same shape as draftInVoice() so the
 * batch can persist either mode through one path.
 */
export async function draftFromTemplate({
  profileJson,
  exemplars,
  recipient,
  research,
  lead,
  templateBody,
  subject
}) {
  const segments = splitOnPersonalized(templateBody).map((segment) =>
    applyMergeVars(segment, lead)
  );
  const sectionCount = segments.length - 1;

  if (sectionCount < 1) {
    throw httpError(400, 'This template has no personalised section to write');
  }

  const context = {
    profileJson,
    exemplars,
    recipient,
    research,
    letter: markLetterGaps(segments),
    sectionCount
  };

  const ownText = ownWords(profileJson, exemplars);
  const checkGuardrails = (sections) =>
    findBannedPhrases({ body: sections.join('\n\n') }, ownText);

  let sections = await personalizeOnce(context, []);
  let guardrail = checkGuardrails(sections);
  if (guardrail.length > 0) {
    sections = await personalizeOnce(context, guardrail);
    guardrail = checkGuardrails(sections);
  }

  let draft = { subject, body: fillPersonalized(segments, sections) };
  let fidelity = await scoreFidelity(context, draft);
  if (fidelity.score !== null && fidelity.score < MIN_FIDELITY_SCORE) {
    sections = await personalizeOnce(context, [...guardrail, ...fidelity.violations]);
    guardrail = checkGuardrails(sections);
    draft = { subject, body: fillPersonalized(segments, sections) };
    fidelity = await scoreFidelity(context, draft);
  }

  return {
    draft,
    fidelityScore: fidelity.score,
    violations: [...guardrail, ...fidelity.violations]
  };
}
