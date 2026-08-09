/**
 * Prompt for the clarify pass (CLAUDE.md, Decisions 2026-08-09). Kept separate
 * from clarify.js so the service stays small and the prompt text is reviewable
 * on its own — same split as voice.js / voicePrompts.js.
 *
 * The questions exist to fill the gaps a cold email cannot be written without.
 * They are asked one at a time in the builder, and every one of them is
 * skippable, so each has to earn its place on the screen by itself.
 */

/**
 * CLAUDE.md caps the clarify pass at 8 questions. campaigns.js validates the
 * answers back against the same number, so it lives here rather than in either
 * consumer — one cap, one place.
 */
export const MAX_CLARIFYING_QUESTIONS = 8;

export const CLARIFY_SYSTEM_PROMPT = [
  'You are helping someone send a cold email that actually gets a reply.',
  '',
  'You are given their own description of what the email is about. Ask only for what',
  'a cold email needs and their description did NOT say:',
  '- who exactly should reply, and what makes this set of recipients the right one',
  '- the ask: the single thing the recipient is being invited to do',
  '- the proof: results, customers, numbers, names, anything concrete they can cite',
  '- what the recipient gets out of it, in their terms',
  '- any specific detail worth naming in the email instead of a generality',
  '',
  'Rules, all of them hard:',
  `- at most ${MAX_CLARIFYING_QUESTIONS} questions, and fewer when the description already covers it`,
  '- never ask for anything the description already states, in any wording',
  '- NEVER ask about their writing style, tone, voice, greeting, sign-off or how',
  '  formal to be. That is taken from the emails they have really sent, and asking',
  '  would have them describe a voice instead of letting it be observed.',
  '- one short, plain question per entry. No preamble, no multi-part questions,',
  '  no numbering, no explanation of why you are asking.',
  '',
  'Return ONLY a single JSON object, no prose and no markdown fences:',
  '{"questions": ["", ""]}'
].join('\n');

export function buildClarifyUserPrompt(brief) {
  return [
    'WHAT THEY SAID THIS EMAIL IS ABOUT:',
    String(brief ?? ''),
    '',
    `Return the JSON object, with at most ${MAX_CLARIFYING_QUESTIONS} questions.`
  ].join('\n');
}
