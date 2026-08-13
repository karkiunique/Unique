import { describe, it, expect } from 'vitest';

import {
  DRAFT_SYSTEM_PROMPT,
  PERSONALIZE_SYSTEM_PROMPT,
  FIDELITY_SYSTEM_PROMPT,
  buildDraftUserPrompt,
  buildPersonalizeUserPrompt,
  buildFidelityUserPrompt
} from '../src/services/generatePrompts.js';
import {
  PROFILE_SYSTEM_PROMPT,
  EXEMPLAR_SYSTEM_PROMPT,
  buildProfileUserPrompt,
  buildExemplarUserPrompt
} from '../src/services/voicePrompts.js';

/**
 * "Replicate the voice, not the typos" (CLAUDE.md, Decisions 2026-08-12).
 *
 * Pure prompt-text tests: no model is called, because the guarantee IS the text.
 * Six letters shipped reading "less then ever" and "Ai" for "AI" because three
 * prompts told the model to copy the writer's mistakes. These assert the carve-out
 * is in all three, and — just as importantly — that it stops at spelling.
 */

// The realistic case: profiles already in the database catalogue the writer's
// mistakes as traits. A prompt fix does not clean them, so generation has to hold
// the line while reading one of these.
const DIRTY_PROFILE = {
  tone: 'direct, plain',
  formality_1to10: 4,
  greeting_styles: ['hey [Name]'],
  signoff_styles: ['thanks,'],
  typical_length_words: { min: 40, median: 70, max: 120 },
  sentence_rhythm: 'short punchy 5-12 word sentences, occasional run-on joined by a comma',
  punctuation_habits: 'commas used where a period would be standard, occasional comma splice',
  capitalization_quirks:
    "capitalizes 'AI' as 'Ai' inconsistently; product names inconsistently cased (WitWeb, witweb, Witweb)",
  vocabulary_level:
    'plain business English, some spelling errors (buisness, eachother, seprate, micic)',
  never_does: ['never uses semicolons'],
  learned_corrections: []
};

const EXEMPLARS = [
  'hey Sam\n\nsaw the raise go through, worth 15 minutes next week?\n\nthanks,\nAna',
  'hi Jo\n\nquick one. the Ai side of this is where it gets intresting\n\nthanks,\nAna'
];

const RECIPIENT = { email: 'sam@corp.com', name: 'Sam', company: 'Corp' };

function draftPrompt(profileJson = DIRTY_PROFILE, exemplars = EXEMPLARS) {
  return buildDraftUserPrompt({
    profileJson,
    exemplars,
    recipient: RECIPIENT,
    research: {},
    goal: 'ask for 15 minutes to show the demo',
    violations: []
  });
}

function personalizePrompt() {
  return buildPersonalizeUserPrompt({
    profileJson: DIRTY_PROFILE,
    exemplars: EXEMPLARS,
    recipient: RECIPIENT,
    research: {},
    letter: 'hey Sam\n\n[[PERSONALIZED 1]]\n\nthanks,\nAna',
    sectionCount: 1,
    violations: []
  });
}

function fidelityPrompt() {
  return buildFidelityUserPrompt({
    profileJson: DIRTY_PROFILE,
    exemplars: EXEMPLARS,
    draft: { subject: 'about the raise', body: 'hey Sam\n\nworth 15 minutes?\n\nthanks,\nAna' }
  });
}

/** Every prompt this product can put in front of the model. */
function allPrompts() {
  return {
    DRAFT_SYSTEM_PROMPT,
    PERSONALIZE_SYSTEM_PROMPT,
    FIDELITY_SYSTEM_PROMPT,
    PROFILE_SYSTEM_PROMPT,
    EXEMPLAR_SYSTEM_PROMPT,
    draftUserPrompt: draftPrompt(),
    personalizeUserPrompt: personalizePrompt(),
    fidelityUserPrompt: fidelityPrompt(),
    profileUserPrompt: buildProfileUserPrompt(EXEMPLARS),
    exemplarUserPrompt: buildExemplarUserPrompt(EXEMPLARS)
  };
}

describe('generation prompts refuse to reproduce misspellings', () => {
  it('tells the model to spell correctly and to case proper nouns consistently', () => {
    for (const prompt of [DRAFT_SYSTEM_PROMPT, draftPrompt()]) {
      expect(prompt).toMatch(/Never reproduce a misspelling/i);
      expect(prompt).toMatch(/use the right homophone/i);
      expect(prompt).toMatch(/capitalize proper nouns the standard way and keep them consistent/i);
      expect(prompt).toMatch(/"AI", never\s+"Ai"/);
      expect(prompt).toMatch(/one single spelling of each product or company name/i);
    }
  });

  it('carries the same carve-out into template-mode personalization', () => {
    for (const prompt of [PERSONALIZE_SYSTEM_PROMPT, personalizePrompt()]) {
      expect(prompt).toMatch(/Never reproduce a misspelling/i);
      expect(prompt).toMatch(/capitalize proper nouns the standard way and keep them consistent/i);
    }
  });

  // The prompt fix alone does not clean stored profiles, so the instruction has to
  // beat the profile it is printed next to.
  it('holds the line when the stored profile catalogues the errors as traits', () => {
    const prompt = draftPrompt();

    // The dirty profile really is in the prompt — otherwise this proves nothing.
    expect(prompt).toContain("capitalizes 'AI' as 'Ai' inconsistently");
    expect(prompt).toContain('some spelling errors (buisness, eachother, seprate, micic)');

    expect(prompt).toMatch(/Never reproduce a misspelling/i);
    expect(prompt).toMatch(/never\s+copy one because the style profile above lists it/i);
    expect(prompt).toMatch(
      /if the profile names specific misspellings, typos or inconsistent capitalization/i
    );
    expect(prompt).toMatch(/IGNORE those entries/);
    expect(prompt).toMatch(/recorded\s+mistakes, not voice/i);
  });

  it('warns that the exemplars are raw mail whose typos must not be copied', () => {
    for (const prompt of [draftPrompt(), personalizePrompt(), fidelityPrompt()]) {
      expect(prompt).toContain('real emails this person wrote');
      expect(prompt).toMatch(/These are real unedited emails/i);
      expect(prompt).toMatch(/may contain the writer's own typos/i);
      expect(prompt).toMatch(/inconsistent proper-noun casing/i);
      expect(prompt).toMatch(/Those are mistakes, not style\. Do NOT copy them\./);
    }
  });

  it('still says nothing about typos when there are no exemplars to warn about', () => {
    const prompt = draftPrompt(DIRTY_PROFILE, []);

    expect(prompt).toContain('No sample emails are available');
    // The profile-level carve-out is independent of the exemplar block.
    expect(prompt).toMatch(/Never reproduce a misspelling/i);
  });
});

describe('the fidelity checker never penalises correct spelling', () => {
  // The non-obvious one: left alone the scorer reads correct spelling as a
  // deviation from the voice, and the sub-80 retry feeds the typo back in.
  it('states that correct spelling and consistent proper nouns are not violations', () => {
    for (const prompt of [FIDELITY_SYSTEM_PROMPT, fidelityPrompt()]) {
      expect(prompt).toMatch(/CORRECT SPELLING IS NEVER A VIOLATION/);
      expect(prompt).toMatch(/the profile may even list the writer's typos as traits/i);
      expect(prompt).toMatch(/capitalizes proper nouns consistently/i);
      expect(prompt).toMatch(/Never report that as a mismatch and never lower the score for it/i);
    }
  });

  it('still asks the scorer to protect the loose syntax', () => {
    for (const prompt of [FIDELITY_SYSTEM_PROMPT, fidelityPrompt()]) {
      expect(prompt).toMatch(/Their loose syntax is the opposite case — it IS the voice/);
      expect(prompt).toMatch(/mark a draft DOWN when it flattens\s+them into standard prose/i);
    }
  });
});

describe('the voice profile builder does not catalogue errors as traits', () => {
  it('forbids recording misspellings, homophones and typo casing in the profile', () => {
    expect(PROFILE_SYSTEM_PROMPT).toMatch(/Errors are not traits/);
    expect(PROFILE_SYSTEM_PROMPT).toMatch(/Do not record misspellings, wrong homophones/i);
    expect(PROFILE_SYSTEM_PROMPT).toMatch(/never name a specific\s+misspelled word in any field/i);
  });

  it('scopes capitalization_quirks to deliberate style and vocabulary_level to word choice', () => {
    expect(PROFILE_SYSTEM_PROMPT).toMatch(
      /capitalization_quirks is for DELIBERATE style only/
    );
    expect(PROFILE_SYSTEM_PROMPT).toMatch(/never for a typo such as\s+"Ai" for "AI"/i);
    expect(PROFILE_SYSTEM_PROMPT).toMatch(
      /vocabulary_level describes word\s+choice and register, never spelling accuracy/i
    );
  });

  it('still requires the loose syntax to be recorded faithfully', () => {
    expect(PROFILE_SYSTEM_PROMPT).toMatch(/Their syntax is NOT an error/);
    expect(PROFILE_SYSTEM_PROMPT).toMatch(
      /Record those faithfully in sentence_rhythm and\s+punctuation_habits/i
    );
  });
});

/**
 * The guard against over-correction, and it matters as much as the carve-out
 * itself: fixing comma splices and run-ons turns the product into polished
 * corporate prose, which is the exact thing users are paying not to send.
 *
 * Written to fail the day somebody adds "fix their grammar" to a prompt.
 */
describe('no prompt instructs the model to correct rhythm, syntax or punctuation', () => {
  const CORRECTIVE_VERBS =
    'fix|fixes|fixing|correct|corrects|correcting|clean up|tidy|polish|improve|repair|rewrite';
  const VOICE_NOUNS =
    'grammar|syntax|rhythm|comma splices?|run-ons?|fragments?|minimal punctuation|punctuation habits';

  // Sentence-scoped on purpose: [^.\n] cannot cross a full stop or a line break,
  // so a preserve clause in one sentence can never be paired with a verb in the next.
  const CORRECTIVE_INSTRUCTION = new RegExp(
    `\\b(?:${CORRECTIVE_VERBS})\\b[^.\\n]{0,120}\\b(?:${VOICE_NOUNS})\\b`,
    'i'
  );

  const BANNED_PHRASES = [
    /grammatically correct/i,
    /proper grammar/i,
    /standard punctuation/i,
    /complete sentences/i,
    /avoid (?:comma splices|run-ons|fragments)/i,
    /no (?:comma splices|run-ons|sentence fragments)/i,
    /well[- ]punctuated/i
  ];

  it('contains no instruction to fix grammar, syntax, rhythm or punctuation', () => {
    for (const [name, prompt] of Object.entries(allPrompts())) {
      expect(prompt, `${name} instructs a correction`).not.toMatch(CORRECTIVE_INSTRUCTION);
    }
  });

  it('contains none of the phrases that would polish the voice away', () => {
    for (const [name, prompt] of Object.entries(allPrompts())) {
      for (const phrase of BANNED_PHRASES) {
        expect(prompt, `${name} matched ${phrase}`).not.toMatch(phrase);
      }
    }
  });

  it('names the loose-syntax habits as things to preserve, not to repair', () => {
    for (const prompt of [DRAFT_SYSTEM_PROMPT, draftPrompt(), personalizePrompt()]) {
      expect(prompt).toMatch(/Never apply this to grammar, syntax, punctuation or rhythm/i);
      expect(prompt).toMatch(/Their comma splices,\s+run-ons joined by a comma/i);
      expect(prompt).toMatch(/commas where a period would be standard/i);
      expect(prompt).toMatch(/missing full stops, minimal punctuation/i);
      expect(prompt).toMatch(/Leave every one of them exactly as they write them/i);
    }
  });

  it('keeps the draft instruction to copy their punctuation quirks verbatim', () => {
    expect(DRAFT_SYSTEM_PROMPT).toMatch(/copy their habits exactly, quirks included/);
    expect(DRAFT_SYSTEM_PROMPT).toMatch(
      /their comma splices, run-ons, fragments, missing full stops, minimal punctuation/i
    );
    expect(DRAFT_SYSTEM_PROMPT).toMatch(/deliberate lowercase and ALL-CAPS emphasis all stay/i);
  });
});
