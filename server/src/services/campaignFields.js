import { httpError } from '../lib/httpError.js';
import { MAX_CLARIFYING_QUESTIONS } from './clarifyPrompts.js';

/**
 * What a campaign's user-authored fields are allowed to be.
 *
 * Split out of campaigns.js so that file stays about persistence and owner
 * scoping. Every function here turns a bad value into a clean 400 rather than
 * letting the driver raise a 500 off a CHECK constraint or a length limit.
 *
 * NOTHING HERE LOGS. Names, subjects, template bodies, briefs and clarification
 * answers are all user-authored content under CLAUDE.md § Privacy, and a
 * validator that echoed the value it rejected would put them in an error
 * message. The messages below name the FIELD and the limit, never the content.
 */

export const CAMPAIGN_MODES = ['voice', 'template'];
export const PERSONALIZED_MARKER = '{{personalized}}';

const MAX_NAME_LENGTH = 120;
const MAX_SUBJECT_LENGTH = 200;
const MAX_TEMPLATE_LENGTH = 20000;
// The brief is meant to be written at length — it is the generation goal, and a
// thin one is what produced six letters about running a first test.
const MAX_BRIEF_LENGTH = 8000;
const MAX_QUESTION_LENGTH = 400;
const MAX_ANSWER_LENGTH = 4000;

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function validateName(value) {
  const name = trimmed(value);

  if (name === '') throw httpError(400, 'A campaign name is required');
  if (name.length > MAX_NAME_LENGTH) {
    throw httpError(400, `A campaign name must be ${MAX_NAME_LENGTH} characters or fewer`);
  }

  return name;
}

/** The DB has a CHECK constraint; validating here turns a 500 into a clean 400. */
export function validateMode(value) {
  const mode = trimmed(value);

  if (!CAMPAIGN_MODES.includes(mode)) {
    throw httpError(400, "Mode must be either 'voice' or 'template'");
  }

  return mode;
}

export function validateSubjectTemplate(value) {
  const subject = trimmed(value);

  if (subject === '') return null;
  if (subject.length > MAX_SUBJECT_LENGTH) {
    throw httpError(400, `A subject template must be ${MAX_SUBJECT_LENGTH} characters or fewer`);
  }

  return subject;
}

/**
 * A template with no {{personalized}} section is a mail merge: every recipient
 * gets the same letter bar their first name, which is the thing this product
 * exists not to send. Enforced here as well as in the builder, because the UI is
 * not the authority.
 *
 * The body is stored as written — whitespace is layout in an email template.
 */
export function validateTemplateBody(value) {
  const body = typeof value === 'string' ? value : '';

  if (body.trim() === '') throw httpError(400, 'A template body is required in template mode');
  if (body.length > MAX_TEMPLATE_LENGTH) {
    throw httpError(400, `A template body must be ${MAX_TEMPLATE_LENGTH} characters or fewer`);
  }
  if (!body.includes(PERSONALIZED_MARKER)) {
    throw httpError(400, `A template must contain at least one ${PERSONALIZED_MARKER} section`);
  }

  return body;
}

/**
 * What this campaign is actually about, in the user's own words (migration 004).
 * It is the generation goal, so it is optional but never trivial: stored as
 * written bar the outer whitespace, and absent means null rather than "".
 */
export function validateBrief(value) {
  const brief = trimmed(value);

  if (brief === '') return null;
  if (brief.length > MAX_BRIEF_LENGTH) {
    throw httpError(400, `A brief must be ${MAX_BRIEF_LENGTH} characters or fewer`);
  }

  return brief;
}

function validateClarification(entry) {
  const question = trimmed(entry?.question);
  const answer = trimmed(entry?.answer);

  if (question === '') throw httpError(400, 'Every clarification needs its question');
  if (question.length > MAX_QUESTION_LENGTH) {
    throw httpError(400, `A question must be ${MAX_QUESTION_LENGTH} characters or fewer`);
  }
  if (answer.length > MAX_ANSWER_LENGTH) {
    throw httpError(400, `An answer must be ${MAX_ANSWER_LENGTH} characters or fewer`);
  }

  // A SKIPPED QUESTION IS A FIRST-CLASS OUTCOME (CLAUDE.md, 2026-08-09): it
  // keeps its question and stores a null answer, so the record of what was
  // asked survives and generation can tell "unanswered" from "answered with
  // nothing".
  return { question, answer: answer === '' ? null : answer };
}

/** The clarify pass's `[{question, answer}]`, as it comes back from the builder. */
export function validateClarifications(value) {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) {
    throw httpError(400, 'Clarifications must be an array of {question, answer}');
  }
  if (value.length > MAX_CLARIFYING_QUESTIONS) {
    throw httpError(400, `There can be at most ${MAX_CLARIFYING_QUESTIONS} clarifying questions`);
  }

  return value.map(validateClarification);
}
