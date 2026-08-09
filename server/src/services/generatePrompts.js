import { signoffStyles } from './signoff.js';

/**
 * Prompts for single-email generation (CLAUDE.md §3). Kept separate from
 * generate.js so the service stays small and the prompt text is reviewable on
 * its own — same split as voice.js / voicePrompts.js.
 *
 * Voice fidelity is the product: the instruction is to match this person
 * MECHANICALLY — length, rhythm, greeting, sign-off, punctuation — not to write
 * something that merely feels similar.
 */

export const DRAFT_SYSTEM_PROMPT = [
  'You write a single cold outreach email AS a specific person, in their exact voice.',
  '',
  'You are given: a forensic style profile of how they write, and real emails they',
  'actually sent. The real emails are the ground truth. Match them MECHANICALLY:',
  '- length: stay inside their typical_length_words, median first',
  '- rhythm: same sentence lengths, same fragments, same paragraph sizes',
  '- greeting: use one of their actual greeting_styles, verbatim in form',
  '- sign-off: use one of their actual signoff_styles, verbatim in form, and SIGN IT',
  '  with their own name on the last line',
  '- punctuation and capitalization: copy their habits exactly, quirks included',
  '- vocabulary: their words, their register, no upgrade in formality',
  '',
  'Never do anything in the profile\'s "never_does" list. That list is the whole',
  'anti-AI-slop filter — a single violation makes the email obviously machine-written.',
  'Honour every entry in "learned_corrections" too: those are the user\'s own edits.',
  '',
  'Do not invent facts about the recipient. Use only the recipient details given.',
  '',
  'ALWAYS SIGN THE EMAIL. The body ends with their closing line and then their own',
  'name, exactly as they sign it in the real emails. Nothing comes after the name:',
  'no job title, no company, no phone number, no links and no postscript — those',
  'blocks were stripped out of the samples on purpose, and their absence is not',
  'licence to leave the email unsigned. A closing with no name, a bare "Best," on',
  'the last line, is a failed draft.',
  '',
  'Return ONLY a single JSON object, no prose and no markdown fences:',
  '{"subject": "", "body": ""}'
].join('\n');

function exemplarBlock(exemplars) {
  if (!Array.isArray(exemplars) || exemplars.length === 0) {
    return 'No sample emails are available. Follow the profile alone, conservatively.';
  }

  return [
    `Here are ${exemplars.length} real emails this person wrote. Match them mechanically:`,
    ...exemplars.map((body, index) => `--- REAL EMAIL ${index + 1} ---\n${body}`)
  ].join('\n\n');
}

function recipientBlock(recipient) {
  const lines = [`Email: ${recipient?.email ?? ''}`];
  if (recipient?.name) lines.push(`Name: ${recipient.name}`);
  if (recipient?.company) lines.push(`Company: ${recipient.company}`);
  if (recipient?.title) lines.push(`Title: ${recipient.title}`);
  return lines.join('\n');
}

/** Apollo/Tavily enrichment, when there is any. Empty for a plain CSV upload. */
function researchBlock(research) {
  if (!research || typeof research !== 'object') return '';

  const serialized = JSON.stringify(research);
  if (serialized === '{}' || serialized === '[]') return '';

  return `\nRESEARCH ON THEM (JSON):\n${serialized}`;
}

/**
 * The closing is spelled out as its own requirement, not left to be inferred
 * from the profile JSON: signature BLOCKS are stripped from the corpus, so the
 * model has to be told that the closing line and the name still belong.
 */
function signoffBlock(profileJson) {
  const styles = signoffStyles(profileJson);

  if (styles.length === 0) {
    return [
      'SIGN-OFF (required): close the way this person closes in the real emails above,',
      'then their own name on the final line. Never leave the email unsigned.'
    ].join('\n');
  }

  return [
    'SIGN-OFF (required): end the body with one of these closings, verbatim in form,',
    'then their own name on the final line — the name they sign with in the real emails:',
    ...styles.map((style) => `- ${style}`)
  ].join('\n');
}

function violationBlock(violations) {
  if (!Array.isArray(violations) || violations.length === 0) return '';

  return [
    '',
    'Your previous attempt was rejected for these reasons. Fix every one of them:',
    ...violations.map((violation) => `- ${violation}`)
  ].join('\n');
}

export function buildDraftUserPrompt({
  profileJson,
  exemplars,
  recipient,
  research,
  goal,
  violations
}) {
  return [
    'STYLE PROFILE (JSON):',
    JSON.stringify(profileJson ?? {}, null, 2),
    '',
    exemplarBlock(exemplars),
    '',
    'RECIPIENT:',
    recipientBlock(recipient),
    researchBlock(research),
    '',
    'WHAT THIS EMAIL NEEDS TO DO:',
    String(goal ?? ''),
    '',
    signoffBlock(profileJson),
    violationBlock(violations),
    '',
    'Write the email. Return only the JSON object.'
  ].join('\n');
}

export const FIDELITY_SYSTEM_PROMPT = [
  'You score how closely a draft email matches one person\'s real writing.',
  '',
  'Check, in order of weight:',
  '1. never_does violations — any single one is disqualifying, score below 50',
  '2. length: within the profile median plus or minus 40 percent',
  '3. greeting and sign-off: must come from their actual lists',
  '4. sentence rhythm and paragraph sizes versus the real emails',
  '5. punctuation, capitalization quirks, contractions, vocabulary register',
  '',
  'Judge mechanics, not quality. A well-written email in the wrong voice scores low.',
  '',
  'Return ONLY this JSON object, no prose and no markdown fences:',
  '{"score_0to100": 0, "violations": ["specific, actionable mismatches"]}'
].join('\n');

/**
 * Template mode (CLAUDE.md §3). The model fills the {{personalized}} gaps and
 * NOTHING else — the letter around them is the user's own writing, and the merge
 * variables are already substituted in code before this prompt is built. The
 * model is never shown a raw {{first_name}} and never asked to fill one.
 */
export const PERSONALIZE_SYSTEM_PROMPT = [
  'You write the personalised sections of an email that a specific person is sending.',
  '',
  'The letter around your text is THEIRS — they wrote it. You fill the gaps marked',
  '[[PERSONALIZED n]] and nothing else. Do not rewrite, reorder or re-punctuate their',
  'words, do not comment on them, and do not repeat anything the letter already says.',
  '',
  'You are given a forensic style profile of how they write and real emails they',
  'actually sent. The real emails are the ground truth. Match them MECHANICALLY:',
  'sentence lengths, fragments, paragraph sizes, punctuation, capitalization quirks,',
  'contractions, vocabulary register. Your sentences must be indistinguishable from',
  'the ones already in the letter.',
  '',
  'Never do anything in the profile\'s "never_does" list — that list is the whole',
  'anti-AI-slop filter. Honour every entry in "learned_corrections" too.',
  '',
  'Write no greeting and no sign-off: the letter already has both.',
  'Do not invent facts about the recipient. Use only the details given.',
  '',
  'Return ONLY a single JSON object, no prose and no markdown fences:',
  '{"sections": ["text for section 1", "text for section 2"]}',
  'One entry per [[PERSONALIZED n]] marker, in the order they appear.'
].join('\n');

export function buildPersonalizeUserPrompt({
  profileJson,
  exemplars,
  recipient,
  research,
  letter,
  sectionCount,
  violations
}) {
  return [
    'STYLE PROFILE (JSON):',
    JSON.stringify(profileJson ?? {}, null, 2),
    '',
    exemplarBlock(exemplars),
    '',
    'RECIPIENT:',
    recipientBlock(recipient),
    researchBlock(research),
    '',
    `THEIR LETTER, with ${sectionCount} gap(s) for you to fill:`,
    String(letter ?? ''),
    violationBlock(violations),
    '',
    `Write ${sectionCount} section(s). Return only the JSON object.`
  ].join('\n');
}

export function buildFidelityUserPrompt({ profileJson, exemplars, draft }) {
  return [
    'STYLE PROFILE (JSON):',
    JSON.stringify(profileJson ?? {}, null, 2),
    '',
    exemplarBlock(exemplars),
    '',
    'DRAFT TO SCORE:',
    `Subject: ${draft?.subject ?? ''}`,
    '',
    String(draft?.body ?? ''),
    '',
    'Score it. Return only the JSON object.'
  ].join('\n');
}
