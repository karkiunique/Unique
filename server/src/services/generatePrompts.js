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
  'no job title, no company, no phone number, no links, no postscript and no',
  'unsubscribe line — those blocks were stripped out of the samples on purpose, and',
  'their absence is not licence to leave the email unsigned. A closing with no name,',
  'a bare "Best," on the last line, is a failed draft.',
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
  return lines.join('\n');
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

export function buildDraftUserPrompt({ profileJson, exemplars, recipient, goal, violations }) {
  return [
    'STYLE PROFILE (JSON):',
    JSON.stringify(profileJson ?? {}, null, 2),
    '',
    exemplarBlock(exemplars),
    '',
    'RECIPIENT:',
    recipientBlock(recipient),
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
  'Ignore any trailing unsubscribe line — it is added by the system, not the writer.',
  '',
  'Return ONLY this JSON object, no prose and no markdown fences:',
  '{"score_0to100": 0, "violations": ["specific, actionable mismatches"]}'
].join('\n');

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
