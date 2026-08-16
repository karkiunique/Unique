import { describe, it, expect } from 'vitest';

import {
  SPELLING_CARVE_OUT,
  FIDELITY_SPELLING_RULE,
  buildDraftUserPrompt,
  buildPersonalizeUserPrompt,
  buildFidelityUserPrompt
} from '../src/services/generatePrompts.js';
import {
  VARIETY_HEADING,
  USED_OPENERS_HEADING,
  OPENER_CHOICE_HEADING,
  USED_ASKS_HEADING,
  ASK_CHOICE_HEADING,
  ownOpeners,
  ownAskForms,
  createVarietyLedger,
  lengthBand,
  variantRecord
} from '../src/services/batchVariety.js';
import { findMissingSignoff, signoffStyles } from '../src/services/signoff.js';

/**
 * THE NEW-USER GUARANTEE (CLAUDE.md, Rules: "This is a platform, not one person's
 * tool").
 *
 * Most users at signup have written few emails, so their voice profile is thin:
 * `sentence_starters`, `signoff_styles`, `how_they_ask` and `typical_length_words`
 * may each be missing, empty, null or the wrong type, and exemplars can be deleted
 * from Settings at any time. All of that already works — but it works by defensive
 * habit, and one assertion in the whole suite pinned it. This file is the pin.
 *
 * Two rules, in order of importance. Nothing may THROW, and nothing may INVENT a
 * construction the user does not actually use in order to fill a gap. The second is
 * the one that would silently ruin the product: an empty list of "their own
 * openings" reads to a model as licence to make some up, so a profile with nothing
 * to offer must offer NOTHING — not an empty list of choices.
 *
 * Pure: no model, no database, no clock. The batch path is pinned separately in
 * sparseProfileBatch.test.js.
 */

const ONE_STARTER = 'saw that';
const ONE_ASK = 'worth 15 minutes next week?';

/** A user with two weeks of sent mail: a few fields learned, most not. */
const NO_STARTERS = {
  tone: 'direct',
  greeting_styles: ['hi [Name]'],
  signoff_styles: ['thanks,'],
  how_they_ask: `they ask flat out: "${ONE_ASK}"`,
  typical_length_words: { min: 30, median: 60, max: 90 }
};

const ONE_STARTER_PROFILE = { ...NO_STARTERS, sentence_starters: [ONE_STARTER] };

const ALL_NULL = {
  tone: null,
  formality_1to10: null,
  greeting_styles: null,
  signoff_styles: null,
  sentence_starters: null,
  how_they_ask: null,
  typical_length_words: null,
  never_does: null,
  learned_corrections: null
};

/** A model-authored profile row can come back any shape at all. */
const WRONG_TYPES = {
  sentence_starters: 'not an array',
  how_they_ask: 42,
  signoff_styles: 'thanks,',
  greeting_styles: { first: 'hi' },
  typical_length_words: 'about sixty words',
  never_does: 'never uses semicolons',
  learned_corrections: 'none yet'
};

/** Every shape a real new user can present. */
const SPARSE_PROFILES = [
  ['an empty profile (a brand-new user)', {}],
  ['a profile with no sentence_starters', NO_STARTERS],
  ['a profile with exactly one sentence starter', ONE_STARTER_PROFILE],
  ['a profile whose every field is null', ALL_NULL],
  ['a profile whose fields are the wrong type', WRONG_TYPES]
];

/** The shapes that name no construction at all — these must offer no list. */
const NOTHING_TO_OFFER = SPARSE_PROFILES.filter(
  ([, profile]) => profile !== NO_STARTERS && profile !== ONE_STARTER_PROFILE
);

const VARIETY_HEADINGS = [
  VARIETY_HEADING,
  USED_OPENERS_HEADING,
  OPENER_CHOICE_HEADING,
  USED_ASKS_HEADING,
  ASK_CHOICE_HEADING
];

/** Headings that carry a bullet list; a bare one would read as "invent your own". */
const LIST_HEADINGS = VARIETY_HEADINGS.filter((heading) => heading !== VARIETY_HEADING);

const EXEMPLARS = ['hi Sam\n\nsaw the round close. worth 15 minutes next week?\n\nthanks,\nAna'];
const RECIPIENT = { email: 'sam@corp.example', name: 'Sam', company: 'Corp' };
const GOAL = 'ask for 15 minutes to walk through the numbers';
const LETTER = 'Hi Sam,\n\n[[PERSONALIZED 1]]\n\nthanks,\nAna';
const SIGNED_DRAFT = {
  subject: 'the numbers',
  body: 'hi Sam\n\nworth 15 minutes next week?\n\nthanks,\nAna'
};

function bulletsIn(text) {
  return text
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2));
}

/** The bullets under ONE heading — sections of the block end at a blank line. */
function bulletsUnder(block, heading) {
  const at = block.indexOf(heading);

  return at === -1 ? [] : bulletsIn(block.slice(at).split('\n\n')[0]);
}

/** Any heading printed with nothing under it. Must always come back empty. */
function headingsWithNoBullets(block) {
  return LIST_HEADINGS.filter(
    (heading) => block.includes(heading) && bulletsUnder(block, heading).length === 0
  );
}

/** N leads through one ledger — reserve() called well past the end of the list. */
function reserveMany(profileJson, count) {
  const ledger = createVarietyLedger(profileJson);

  return Array.from({ length: count }, () => ledger.reserve());
}

function draftPromptFor(profileJson, extra = {}) {
  return buildDraftUserPrompt({
    profileJson,
    exemplars: EXEMPLARS,
    recipient: RECIPIENT,
    research: {},
    goal: GOAL,
    varietyBlock: createVarietyLedger(profileJson).reserve().promptBlock,
    violations: [],
    ...extra
  });
}

describe('a thin profile still produces every prompt', () => {
  for (const [label, profileJson] of SPARSE_PROFILES) {
    it(`writes draft, personalize and fidelity prompts for a new user with ${label}`, () => {
      const draft = draftPromptFor(profileJson);
      const personalize = buildPersonalizeUserPrompt({
        profileJson,
        exemplars: EXEMPLARS,
        recipient: RECIPIENT,
        research: null,
        letter: LETTER,
        sectionCount: 1,
        violations: []
      });
      const fidelity = buildFidelityUserPrompt({
        profileJson,
        exemplars: EXEMPLARS,
        draft: SIGNED_DRAFT
      });

      expect(draft).toContain(RECIPIENT.email);
      expect(draft).toContain(GOAL);
      // The sign-off instruction survives even with no styles to name: the
      // alternative is a letter going out unsigned under the user's own name.
      expect(draft).toContain('SIGN-OFF (required)');
      expect(personalize).toContain('[[PERSONALIZED 1]]');
      expect(personalize).toContain('Write 1 section(s)');
      expect(fidelity).toContain(SIGNED_DRAFT.body);

      for (const prompt of [draft, personalize, fidelity]) {
        expect(prompt).not.toContain('undefined');
        expect(prompt).not.toContain('[object Object]');
      }
    });
  }

  // The floor: a user who connected Gmail and did nothing else. Every optional
  // argument absent, not merely empty.
  it('writes usable prompts when the caller passes no profile at all', () => {
    expect(buildDraftUserPrompt({})).toContain('SIGN-OFF (required)');
    expect(buildFidelityUserPrompt({})).toContain('Score it.');
    expect(buildPersonalizeUserPrompt({ sectionCount: 1 })).toContain('Write 1 section(s)');
  });
});

describe('a thin profile is never filled in with constructions the user does not write', () => {
  /**
   * THE ASSERTION THIS FILE EXISTS FOR. A block reading "every opening available
   * to you:" with nothing under it is worse than no block: it tells the model this
   * person has no openings and invites it to supply some.
   */
  for (const [label, profileJson] of NOTHING_TO_OFFER) {
    it(`offers a new user with ${label} no opening list at all, not an empty one`, () => {
      expect(ownOpeners(profileJson)).toEqual([]);
      expect(ownAskForms(profileJson)).toEqual([]);

      for (const assignment of reserveMany(profileJson, 6)) {
        expect(assignment.promptBlock).toBe('');
        expect(assignment.openerStarter).toBeNull();
        expect(assignment.ctaForm).toBeNull();
      }

      // And no trace of the block survives into the prompt that reaches the model.
      const prompt = draftPromptFor(profileJson);
      for (const heading of VARIETY_HEADINGS) expect(prompt).not.toContain(heading);
    });
  }

  it('names no openings to a user who has none, while still varying their asks', () => {
    const [first, second] = reserveMany(NO_STARTERS, 2);

    expect(first.openerStarter).toBeNull();
    for (const block of [first.promptBlock, second.promptBlock]) {
      expect(block).not.toContain(OPENER_CHOICE_HEADING);
      expect(block).not.toContain(USED_OPENERS_HEADING);
      for (const suggestion of bulletsIn(block)) expect(suggestion).toBe(ONE_ASK);
    }
  });

  /**
   * One opener, six leads: reuse is unavoidable. What must never happen is the
   * block reaching for a seventh construction to fill the gap.
   */
  it('reuses the single opening a new user has rather than inventing five more', () => {
    const theirOwn = [ONE_STARTER, ONE_ASK];

    for (const [index, assignment] of reserveMany(ONE_STARTER_PROFILE, 6).entries()) {
      const { promptBlock } = assignment;

      expect(assignment.openerStarter).toBe(ONE_STARTER);
      expect(assignment.ctaForm).toBe(ONE_ASK);
      expect(bulletsUnder(promptBlock, OPENER_CHOICE_HEADING)).toEqual([ONE_STARTER]);

      // Every suggestion in every section of the block, not just the chosen one.
      for (const suggestion of bulletsIn(promptBlock)) expect(theirOwn).toContain(suggestion);

      // Past the end of the list it asks for reuse; it never asks for something new.
      expect(bulletsUnder(promptBlock, USED_OPENERS_HEADING)).toEqual(
        index === 0 ? [] : [ONE_STARTER]
      );
    }
  });

  it('never prints a heading with an empty list under it, for any thin profile', () => {
    for (const [label, profileJson] of SPARSE_PROFILES) {
      for (const { promptBlock } of reserveMany(profileJson, 6)) {
        expect(headingsWithNoBullets(promptBlock), label).toEqual([]);
      }
    }
  });
});

describe('a thin profile degrades to unknown, never to a made-up value', () => {
  /**
   * `Number(null)` is 0 and 0 is finite — that exact bug once recorded a profile
   * of unknown version as a real generation-0 cohort. Null means unknown; 0 and ''
   * are claims about a user we know nothing about yet.
   */
  it("records a brand-new user's variant as unknown, not as generation zero", () => {
    const [assignment] = reserveMany({}, 1);
    const record = variantRecord({
      assignment,
      body: SIGNED_DRAFT.body,
      profileJson: {},
      profileVersion: null
    });

    expect(record).toEqual({
      opener_starter: null,
      cta_form: null,
      length_band: null,
      profile_version: null
    });
    expect(record.profile_version).not.toBe(0);
    expect(record.length_band).not.toBe('');
  });

  it('reports an unknown length band and version rather than guessing either', () => {
    for (const [label, profileJson] of SPARSE_PROFILES) {
      const [assignment] = reserveMany(profileJson, 1);
      const record = variantRecord({ assignment, body: SIGNED_DRAFT.body, profileJson });

      expect([null, 'short', 'mid', 'long'], label).toContain(record.length_band);
      expect(record.profile_version, label).toBeNull();
    }

    // No median to measure against: unknown, not "short".
    for (const profileJson of [{}, ALL_NULL, WRONG_TYPES]) {
      expect(lengthBand(SIGNED_DRAFT.body, profileJson)).toBeNull();
    }
    expect(lengthBand(SIGNED_DRAFT.body, NO_STARTERS)).toBe('short');
  });
});

describe('a thin profile never blocks a new user on a check we cannot make', () => {
  it('raises no sign-off violation when the profile names no sign-off', () => {
    for (const [label, profileJson] of NOTHING_TO_OFFER) {
      expect(signoffStyles(profileJson), label).toEqual([]);
      expect(findMissingSignoff({ body: 'hi Sam\n\nworth a look?' }, profileJson), label).toEqual([]);
    }
  });

  it('accepts a properly signed draft for every thin profile', () => {
    for (const [label, profileJson] of SPARSE_PROFILES) {
      expect(findMissingSignoff(SIGNED_DRAFT, profileJson), label).toEqual([]);
    }
  });
});

describe('a thin profile still gets the spelling carve-out and honest exemplar wording', () => {
  /**
   * A new user must get correct spelling too, and the carve-out cannot depend on
   * the profile naming a quirk — a profile that names nothing would otherwise drop
   * the one instruction that is not about this person at all.
   */
  it('carries the carve-out into every prompt for every thin profile', () => {
    for (const [label, profileJson] of SPARSE_PROFILES) {
      expect(draftPromptFor(profileJson), label).toContain(SPELLING_CARVE_OUT);
      expect(
        buildPersonalizeUserPrompt({ profileJson, letter: LETTER, sectionCount: 1 }),
        label
      ).toContain(SPELLING_CARVE_OUT);
      expect(buildFidelityUserPrompt({ profileJson, draft: SIGNED_DRAFT }), label).toContain(
        FIDELITY_SPELLING_RULE
      );
    }
  });

  /**
   * Settings lets a user hard-delete their exemplars, so "no exemplars" is a
   * supported state and not an edge case. The prompt must not announce example
   * emails it is not carrying — the model would go looking for them.
   */
  it('does not claim to include example emails when the user has none', () => {
    for (const exemplars of [[], null, undefined, 'not an array']) {
      const prompt = draftPromptFor({}, { exemplars });

      expect(prompt).toContain('No sample emails are available');
      expect(prompt).not.toContain('real emails this person wrote');
      expect(prompt).not.toContain('REAL EMAIL 1');
    }

    const fidelity = buildFidelityUserPrompt({ profileJson: {}, exemplars: [], draft: SIGNED_DRAFT });
    expect(fidelity).toContain('No sample emails are available');
  });
});
