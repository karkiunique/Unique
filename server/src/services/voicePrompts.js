/**
 * Prompts for the voice profile builder. Kept separate from voice.js so the
 * service stays small and the prompt text is reviewable on its own.
 *
 * The profile must capture MECHANICS, not vibes (CLAUDE.md §2) — voice fidelity
 * is the product. The `never_does` list is the anti-AI-slop filter.
 */

export const PROFILE_SCHEMA = `{
  "tone": "", "formality_1to10": 0,
  "greeting_styles": ["exact greetings they actually use, verbatim"],
  "signoff_styles": ["verbatim"],
  "typical_length_words": {"min": 0, "median": 0, "max": 0},
  "sentence_rhythm": "e.g. short punchy 5-12 word sentences, occasional fragment",
  "paragraph_style": "e.g. 1-2 sentence paragraphs, no walls of text",
  "contractions": "always/sometimes/never",
  "capitalization_quirks": "e.g. lowercase i, no caps after dash",
  "punctuation_habits": "e.g. dashes over commas, no exclamation marks, ellipses",
  "sentence_starters": ["verbatim frequent openers"],
  "transition_words": ["verbatim"],
  "how_they_ask": "how this person actually makes requests/CTAs, with a verbatim example",
  "signature_phrases": ["verbatim phrases used 2+ times"],
  "vocabulary_level": "", "emoji_usage": "", "humor": "",
  "never_does": ["patterns absent from their writing that AI would typically add - e.g. never says 'I hope this finds you well', never uses semicolons"]
}`;

/**
 * CLAUDE.md §2 "Errors are not traits" (Decisions, 2026-08-12). A real profile
 * recorded `vocabulary_level: "...some spelling errors (buisness, eachother)"` and
 * `capitalization_quirks: "capitalizes 'AI' as 'Ai' inconsistently"`; generation
 * then dutifully reproduced both. The profile is the first place the error gets
 * turned into an instruction, so it is the first place to stop it.
 *
 * The line stops at spelling and proper nouns. Loose syntax stays in the profile —
 * `sentence_rhythm` and `punctuation_habits` must still record the comma splices.
 */
export const ERRORS_ARE_NOT_TRAITS = [
  'Errors are not traits. Describe how this person WRITES, never the mistakes they make.',
  'Do not record misspellings, wrong homophones (then/than, its/it\'s) or inconsistent',
  'proper-noun capitalization anywhere in the profile, and never name a specific',
  'misspelled word in any field. capitalization_quirks is for DELIBERATE style only —',
  'lowercase "i", no caps after a dash, ALL-CAPS for emphasis — never for a typo such as',
  '"Ai" for "AI" or a product name spelled three ways. vocabulary_level describes word',
  'choice and register, never spelling accuracy.',
  '',
  'Their syntax is NOT an error and belongs in the profile in full: comma splices, run-ons',
  'joined by a comma, commas where a period would be standard, fragments, missing full',
  'stops, minimal punctuation. Record those faithfully in sentence_rhythm and',
  'punctuation_habits — they are the voice.'
].join('\n');

export const PROFILE_SYSTEM_PROMPT = [
  'You are a forensic writing-style analyst. You are given real emails one person sent.',
  'Describe how this person writes at the level of mechanics, not vibes: exact greetings,',
  'exact sign-offs, sentence length and rhythm, punctuation habits, capitalization quirks,',
  'verbatim phrases they reuse. Quote them verbatim wherever the schema asks for it.',
  '',
  'The "never_does" list is the most important field. Fill it with patterns that are absent',
  'from their writing but that a generic AI would add anyway (filler openers, corporate verbs,',
  'exclamation marks, semicolons, "I hope this email finds you well", and so on).',
  '',
  'Generalise other people\'s names. Wherever a verbatim value would contain a recipient or',
  'third-party personal name, replace that name with [Name] — greetings ("Hi [Name],"),',
  'sign-offs ("Thank you [Name],"), sentence_starters, transition_words, signature_phrases,',
  'how_they_ask, every verbatim list. Never emit a real recipient name. The writer\'s OWN name',
  'is part of their voice: keep that as written.',
  '',
  'A sign-off is the closing itself ("Best,", "Thanks [Name],") — never the signature block',
  'under it. Do not put a name, job title, company or website into signoff_styles.',
  '',
  ERRORS_ARE_NOT_TRAITS,
  '',
  'Count words for typical_length_words from the emails themselves, but over substantive',
  'emails only. Exclude one-word and one-line acknowledgements ("thanks", "sounds good", "ok",',
  '"will do") — they are not outreach and they drag min down to 1. median matters most; min',
  'and max must describe the real emails this person writes, not their shortest reply.',
  '',
  'Return ONLY a single JSON object matching this schema exactly, with no prose, no markdown',
  'fences and no extra keys:',
  PROFILE_SCHEMA
].join('\n');

function numberedEmails(emails) {
  return emails.map((body, index) => `--- EMAIL ${index + 1} ---\n${body}`).join('\n\n');
}

export function buildProfileUserPrompt(emails) {
  return [
    `Here are ${emails.length} emails this person sent, most recent first.`,
    'Analyse them and return the JSON profile.',
    '',
    numberedEmails(emails)
  ].join('\n');
}

export const EXEMPLAR_SYSTEM_PROMPT = [
  'You are selecting few-shot style anchors from emails one person sent.',
  '',
  'Pick the 5 to 8 emails that best represent their natural outreach voice.',
  'Exclude one-liners, forwards, automated or transactional messages, and anything',
  'containing obvious personal information about third parties beyond names.',
  'Prefer emails that show their normal greeting, rhythm, ask and sign-off.',
  '',
  'Return ONLY a JSON array of the EMAIL numbers you picked, e.g. [1,3,4,7,9].',
  'No prose, no markdown fences, no other keys.'
].join('\n');

export function buildExemplarUserPrompt(emails) {
  return [
    `Here are ${emails.length} emails this person sent, most recent first.`,
    'Return the JSON array of the 5-8 email numbers that best represent their voice.',
    '',
    numberedEmails(emails)
  ].join('\n');
}
