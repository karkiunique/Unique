import { describe, it, expect } from 'vitest';

import {
  VARIETY_HEADING,
  USED_OPENERS_HEADING,
  OPENER_CHOICE_HEADING,
  ASK_CHOICE_HEADING,
  ownOpeners,
  ownAskForms,
  createVarietyLedger,
  lengthBand,
  variantRecord
} from '../src/services/batchVariety.js';

/**
 * The variety ledger on its own (CLAUDE.md, Decisions 2026-08-12). The wiring —
 * that a batch actually sends these blocks and stores these variants — is proved
 * against the model payload in generateBatch.test.js. What is proved here is the
 * two rules the module exists to keep: every suggestion is one the user already
 * writes, and a spent list degrades into reuse rather than invention.
 *
 * No model, no database, no clock. All of this is pure.
 */

const STARTERS = ['saw that', 'quick one —', 'been meaning to reach out'];
const ASK_FORMS = ['worth 15 minutes next week?', 'open to a look?'];

const PROFILE = {
  sentence_starters: STARTERS,
  how_they_ask: `flat out, no build-up: "${ASK_FORMS[0]}" or "${ASK_FORMS[1]}"`,
  typical_length_words: { min: 40, median: 100, max: 160 }
};

function bulletsIn(text) {
  return text
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2));
}

function bulletsUnder(block, heading) {
  const at = block.indexOf(heading);

  return at === -1 ? [] : bulletsIn(block.slice(at).split('\n\n')[0]);
}

function words(count) {
  return Array.from({ length: count }, () => 'word').join(' ');
}

describe("reading the user's own constructions", () => {
  it('trims, de-duplicates and drops anything unusable', () => {
    const opener = ownOpeners({
      sentence_starters: ['  saw that  ', 'Saw that', '', null, 42, 'quick one —']
    });

    expect(opener).toEqual(['saw that', 'quick one —']);
  });

  it('returns nothing rather than guessing when the profile names no openers', () => {
    expect(ownOpeners({})).toEqual([]);
    expect(ownOpeners(null)).toEqual([]);
    expect(ownOpeners({ sentence_starters: 'not a list' })).toEqual([]);
  });

  /**
   * `how_they_ask` is one descriptive string in the schema, "with a verbatim
   * example" — the quoted spans are the forms. Splitting the description any
   * other way would manufacture asks the user never made.
   */
  it('takes the ask forms from the quoted examples inside how_they_ask', () => {
    expect(ownAskForms(PROFILE)).toEqual(ASK_FORMS);
  });

  it('falls back to the whole description when it quotes no example', () => {
    expect(ownAskForms({ how_they_ask: 'asks directly, always at the end' })).toEqual([
      'asks directly, always at the end'
    ]);
    expect(ownAskForms({ how_they_ask: '   ' })).toEqual([]);
    expect(ownAskForms({ how_they_ask: ['one way', 'another way'] })).toEqual([
      'one way',
      'another way'
    ]);
  });
});

describe('the variety ledger', () => {
  it('hands out a different opener and ask to each lead, in their own words', () => {
    const ledger = createVarietyLedger(PROFILE);
    const assignments = [ledger.reserve(), ledger.reserve(), ledger.reserve()];

    expect(assignments.map((one) => one.openerStarter)).toEqual(STARTERS);
    for (const assignment of assignments) {
      expect(ASK_FORMS).toContain(assignment.ctaForm);
    }
  });

  it('names the openers already reserved, and names none to the first lead', () => {
    const ledger = createVarietyLedger(PROFILE);

    expect(bulletsUnder(ledger.reserve().promptBlock, USED_OPENERS_HEADING)).toEqual([]);
    expect(bulletsUnder(ledger.reserve().promptBlock, USED_OPENERS_HEADING)).toEqual([STARTERS[0]]);
    expect(bulletsUnder(ledger.reserve().promptBlock, USED_OPENERS_HEADING)).toEqual([
      STARTERS[0],
      STARTERS[1]
    ]);
  });

  it('suggests nothing the user does not already write', () => {
    const ledger = createVarietyLedger(PROFILE);
    const theirOwn = [...STARTERS, ...ASK_FORMS];

    for (let index = 0; index < 6; index += 1) {
      const { promptBlock } = ledger.reserve();

      for (const suggestion of bulletsIn(promptBlock)) expect(theirOwn).toContain(suggestion);
      expect(STARTERS).toContain(bulletsUnder(promptBlock, OPENER_CHOICE_HEADING)[0]);
      expect(ASK_FORMS).toContain(bulletsUnder(promptBlock, ASK_CHOICE_HEADING)[0]);
    }
  });

  it('reuses in order once the list is spent, never running dry', () => {
    const ledger = createVarietyLedger(PROFILE);
    const drawn = Array.from({ length: 7 }, () => ledger.reserve().openerStarter);

    expect(drawn).toEqual([...STARTERS, ...STARTERS, STARTERS[0]]);
  });

  it('says nothing at all when the profile names no constructions', () => {
    const ledger = createVarietyLedger({ typical_length_words: { median: 100 } });
    const assignment = ledger.reserve();

    // A block with an empty list would read as an instruction to invent one.
    expect(assignment.promptBlock).toBe('');
    expect(assignment.openerStarter).toBeNull();
    expect(assignment.ctaForm).toBeNull();
  });

  it('carries the variety heading so the prompt is greppable', () => {
    expect(createVarietyLedger(PROFILE).reserve().promptBlock).toContain(VARIETY_HEADING);
  });
});

describe('the variant record', () => {
  it('bands a letter against the median the user actually writes to', () => {
    expect(lengthBand(words(50), PROFILE)).toBe('short');
    expect(lengthBand(words(100), PROFILE)).toBe('mid');
    expect(lengthBand(words(200), PROFILE)).toBe('long');
  });

  it('reports an unknown band rather than guessing one', () => {
    expect(lengthBand(words(50), {})).toBeNull();
    expect(lengthBand('   ', PROFILE)).toBeNull();
    expect(lengthBand(null, PROFILE)).toBeNull();
  });

  it('records all four fields for a lead that had an assignment', () => {
    const assignment = createVarietyLedger(PROFILE).reserve();

    expect(
      variantRecord({ assignment, body: words(50), profileJson: PROFILE, profileVersion: 6 })
    ).toEqual({
      opener_starter: STARTERS[0],
      cta_form: ASK_FORMS[0],
      length_band: 'short',
      profile_version: 6
    });
  });

  it('leaves the assigned fields null when there was no batch to vary against', () => {
    expect(
      variantRecord({ body: words(100), profileJson: PROFILE, profileVersion: null })
    ).toEqual({
      opener_starter: null,
      cta_form: null,
      length_band: 'mid',
      profile_version: null
    });
  });
});
