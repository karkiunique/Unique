import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The edit-learning loop.
 *
 * The important half of this suite is the NEGATIVE half. A false positive here
 * is permanent: it teaches the voice profile something the user never meant and
 * then feeds it into every future generation. So the classifier is asserted to
 * stay silent on rewritten sentences, cut paragraphs, added claims and changed
 * sign-offs — anything where the words themselves moved.
 */

const { supabaseFrom } = vi.hoisted(() => ({ supabaseFrom: vi.fn() }));

vi.mock('../src/lib/supabase.js', () => ({
  getSupabaseAdmin: () => ({ from: supabaseFrom }),
  resetSupabaseAdmin: () => {}
}));

vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  sanitizeMeta: (meta) => meta
}));

const { classifyEdit, recordEditCorrections, CORRECTION, MAX_LEARNED_CORRECTIONS } = await import(
  '../src/services/editLearning.js'
);
const { logger } = await import('../src/lib/logger.js');

const OWNER = 'user-owner';
const STRANGER = 'user-stranger';

const DRAFT = 'Hi Marguerite,\n\nsaw the raise go through! worth 15 minutes?\n\nthanks,\nAna';

let profileRows = [];
let queries = [];

function matchesFilters(row, filters) {
  return Object.entries(filters).every(([column, value]) => row[column] === value);
}

function builderFor(op, values) {
  const query = { op, values, filters: {}, settled: null };
  queries.push(query);

  const chain = {
    select: () => chain,
    eq(column, value) {
      query.filters[column] = value;
      return chain;
    },
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => ({ data: settle(query)[0] ?? null, error: null }),
    then: (onFulfilled, onRejected) =>
      Promise.resolve({ data: settle(query), error: null }).then(onFulfilled, onRejected)
  };

  return chain;
}

function settle(query) {
  if (query.settled) return query.settled;

  const found = profileRows.filter((row) => matchesFilters(row, query.filters));
  if (query.op === 'update') {
    for (const row of found) Object.assign(row, query.values);
  }
  query.settled = found;

  return found;
}

function tableFake() {
  return {
    update: (values) => builderFor('update', values),
    select: () => builderFor('select', null)
  };
}

function seedProfile(corrections = []) {
  const row = {
    id: 'vp-1',
    user_id: OWNER,
    profile_json: { tone: 'direct', learned_corrections: corrections }
  };
  profileRows.push(row);

  return row;
}

function storedCorrections() {
  return profileRows[0]?.profile_json?.learned_corrections ?? [];
}

beforeEach(() => {
  profileRows = [];
  queries = [];
  supabaseFrom.mockReset();
  supabaseFrom.mockImplementation(tableFake);
  logger.info.mockClear();
  logger.warn.mockClear();
});

describe('classifyEdit — what counts as stylistic', () => {
  it('learns that the user takes out exclamation marks', () => {
    const edited = DRAFT.replace('go through!', 'go through.');

    expect(classifyEdit(DRAFT, edited)).toEqual([CORRECTION.NO_EXCLAMATIONS]);
  });

  it('learns that the user takes out semicolons', () => {
    const before = 'Hi Sam,\n\nwe build cold email; it works.\n\nthanks,\nAna';
    const after = 'Hi Sam,\n\nwe build cold email. it works.\n\nthanks,\nAna';

    expect(classifyEdit(before, after)).toEqual([CORRECTION.NO_SEMICOLONS]);
  });

  it('learns that the user takes out ellipses', () => {
    const before = 'Hi Sam,\n\nworth a look... maybe next week.\n\nthanks,\nAna';
    const after = 'Hi Sam,\n\nworth a look, maybe next week.\n\nthanks,\nAna';

    expect(classifyEdit(before, after)).toEqual([CORRECTION.NO_ELLIPSES]);
  });

  it('learns that the user shortens the greeting to just the name', () => {
    const before = 'Hi Marguerite,\n\nworth 15 minutes?\n\nthanks,\nAna';
    const after = 'Marguerite,\n\nworth 15 minutes?\n\nthanks,\nAna';

    expect(classifyEdit(before, after)).toEqual([CORRECTION.SHORT_GREETING]);
  });

  it('learns lower case only when nothing but the case changed', () => {
    const before = 'Hi Sam,\n\nWorth 15 minutes?\n\nthanks,\nAna';
    const after = 'Hi Sam,\n\nworth 15 minutes?\n\nthanks,\nAna';

    expect(classifyEdit(before, after)).toEqual([CORRECTION.LOWERCASE]);
  });

  it('learns from a one-paragraph letter with no greeting line', () => {
    expect(classifyEdit('worth 15 minutes?!', 'worth 15 minutes?')).toEqual([
      CORRECTION.NO_EXCLAMATIONS
    ]);
  });

  it('learns both marks when both went in one edit', () => {
    const before = 'Hi Sam,\n\nit works; really!\n\nthanks,\nAna';
    const after = 'Hi Sam,\n\nit works. really.\n\nthanks,\nAna';

    expect(classifyEdit(before, after)).toEqual([
      CORRECTION.NO_EXCLAMATIONS,
      CORRECTION.NO_SEMICOLONS
    ]);
  });
});

describe('classifyEdit — what must never be learned', () => {
  it('learns nothing from a rewritten sentence', () => {
    const after = DRAFT.replace(
      'saw the raise go through! worth 15 minutes?',
      'congratulations on the funding. can we talk on Thursday?'
    );

    expect(classifyEdit(DRAFT, after)).toEqual([]);
  });

  it('learns nothing when a sentence is cut, even though the marks went with it', () => {
    const after = 'Hi Marguerite,\n\nworth 15 minutes?\n\nthanks,\nAna';

    expect(classifyEdit(DRAFT, after)).toEqual([]);
  });

  it('learns nothing when a swapped word takes the exclamation mark with it', () => {
    // Equal word COUNT on both sides, so only comparing word IDENTITY tells this
    // content rewrite apart from a punctuation habit. A count-only comparison
    // would learn "user removes exclamation marks" from a changed claim, and a
    // wrong note is permanent.
    const before = 'We cut onboarding time by half!';
    const after = 'We cut onboarding time by third.';

    expect(classifyEdit(before, after)).toEqual([]);
  });

  it('learns nothing when a swapped word takes the semicolon with it', () => {
    const before = 'Hi Sam,\n\nwe build cold email; it works.\n\nthanks,\nAna';
    const after = 'Hi Sam,\n\nwe build cold email. it scales.\n\nthanks,\nAna';

    expect(classifyEdit(before, after)).toEqual([]);
  });

  it('learns nothing when a swapped word takes the ellipsis with it', () => {
    const before = 'Hi Sam,\n\nworth a look... maybe next week.\n\nthanks,\nAna';
    const oneCharacter = 'Hi Sam,\n\nworth a look… maybe next week.\n\nthanks,\nAna';
    const after = 'Hi Sam,\n\nworth a look, maybe next month.\n\nthanks,\nAna';

    expect(classifyEdit(before, after)).toEqual([]);
    expect(classifyEdit(oneCharacter, after)).toEqual([]);
  });

  it('learns nothing when a word is added', () => {
    const before = 'Hi Sam,\n\nworth 15 minutes?\n\nthanks,\nAna';
    const after = 'Hi Sam,\n\nworth just 15 minutes?\n\nthanks,\nAna';

    expect(classifyEdit(before, after)).toEqual([]);
  });

  it('learns nothing when the sign-off changes', () => {
    const before = 'Hi Sam,\n\nworth 15 minutes?\n\nthanks,\nAna';
    const after = 'Hi Sam,\n\nworth 15 minutes?\n\nbest,\nAna';

    expect(classifyEdit(before, after)).toEqual([]);
  });

  it('learns nothing when the greeting is rewritten rather than shortened', () => {
    const before = 'Hi Marguerite,\n\nworth 15 minutes?\n\nthanks,\nAna';
    const after = 'Dear Ms Okonjo,\n\nworth 15 minutes?\n\nthanks,\nAna';

    expect(classifyEdit(before, after)).toEqual([]);
  });

  it('learns nothing from a partial removal — one mark left is not a habit', () => {
    const before = 'Hi Sam,\n\nit works! really!\n\nthanks,\nAna';
    const after = 'Hi Sam,\n\nit works! really.\n\nthanks,\nAna';

    expect(classifyEdit(before, after)).toEqual([]);
  });

  it('learns nothing from an unrecognised punctuation change', () => {
    const before = 'Hi Sam,\n\nworth 15 minutes, next week?\n\nthanks,\nAna';
    const after = 'Hi Sam,\n\nworth 15 minutes — next week?\n\nthanks,\nAna';

    expect(classifyEdit(before, after)).toEqual([]);
  });

  it('learns nothing from an empty, missing or unchanged body', () => {
    expect(classifyEdit(DRAFT, DRAFT)).toEqual([]);
    expect(classifyEdit(DRAFT, '   ')).toEqual([]);
    expect(classifyEdit('', 'anything at all')).toEqual([]);
    expect(classifyEdit(null, undefined)).toEqual([]);
  });
});

describe('recordEditCorrections', () => {
  it('appends the note to the profile it belongs to', async () => {
    seedProfile();

    const result = await recordEditCorrections(OWNER, DRAFT, DRAFT.replace('through!', 'through.'));

    expect(result).toEqual({ learned: 1 });
    expect(storedCorrections()).toEqual([CORRECTION.NO_EXCLAMATIONS]);
  });

  it('writes nothing for a content edit', async () => {
    seedProfile();

    const result = await recordEditCorrections(OWNER, DRAFT, 'a completely different letter');

    expect(result).toEqual({ learned: 0 });
    expect(queries.filter((query) => query.op === 'update')).toHaveLength(0);
  });

  it('does not repeat a note it has already learned', async () => {
    seedProfile([CORRECTION.NO_EXCLAMATIONS]);

    const result = await recordEditCorrections(OWNER, DRAFT, DRAFT.replace('through!', 'through.'));

    expect(result).toEqual({ learned: 0 });
    expect(storedCorrections()).toEqual([CORRECTION.NO_EXCLAMATIONS]);
  });

  it('caps at twenty, dropping the oldest first', async () => {
    const older = Array.from(
      { length: MAX_LEARNED_CORRECTIONS },
      (_unused, index) => `note ${index}`
    );
    seedProfile(older);

    await recordEditCorrections(OWNER, DRAFT, DRAFT.replace('through!', 'through.'));

    const stored = storedCorrections();
    expect(stored).toHaveLength(MAX_LEARNED_CORRECTIONS);
    // FIFO: the oldest fell off the front, the new note is on the end.
    expect(stored).not.toContain('note 0');
    expect(stored[0]).toBe('note 1');
    expect(stored[stored.length - 1]).toBe(CORRECTION.NO_EXCLAMATIONS);
  });

  it("reads and writes only this user's profile", async () => {
    seedProfile();

    const edited = DRAFT.replace('through!', 'through.');
    const result = await recordEditCorrections(STRANGER, DRAFT, edited);

    expect(result).toEqual({ learned: 0 });
    expect(storedCorrections()).toEqual([]);
    for (const query of queries) expect(query.filters.user_id).toBe(STRANGER);
  });

  it('does nothing when the user has no voice profile yet', async () => {
    expect(await recordEditCorrections(OWNER, DRAFT, DRAFT.replace('through!', 'through.'))).toEqual(
      { learned: 0 }
    );
  });

  it('logs a count only — never the letter or the note', async () => {
    seedProfile();

    await recordEditCorrections(OWNER, DRAFT, DRAFT.replace('through!', 'through.'));

    const serialized = JSON.stringify(logger.info.mock.calls);

    expect(serialized).not.toContain('saw the raise go through');
    expect(serialized).not.toContain('Marguerite');
    expect(logger.info).toHaveBeenCalledWith('voice_corrections_learned', {
      userId: OWNER,
      count: 1
    });
  });
});
