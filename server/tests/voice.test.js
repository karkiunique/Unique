import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { create, fetchSentEmails, supabaseFrom } = vi.hoisted(() => ({
  create: vi.fn(),
  fetchSentEmails: vi.fn(),
  supabaseFrom: vi.fn()
}));

// Real module except the client: getModel() must stay real so the pinned model is tested.
vi.mock('../src/lib/anthropic.js', async () => {
  const actual = await vi.importActual('../src/lib/anthropic.js');
  return { ...actual, getAnthropic: () => ({ messages: { create } }) };
});

vi.mock('../src/lib/supabase.js', () => ({
  getSupabaseAdmin: () => ({ from: supabaseFrom }),
  resetSupabaseAdmin: () => {}
}));

// Keeps googleapis out of this test entirely.
vi.mock('../src/services/gmail.js', () => ({ fetchSentEmails }));

vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  sanitizeMeta: (meta) => meta
}));

const {
  parseProfileJson,
  parseExemplarIndices,
  redactPii,
  capEmailsToCharBudget,
  buildVoiceProfile,
  selectExemplars,
  saveVoiceProfile,
  getVoiceProfile,
  generateVoiceProfileForUser,
  MAX_PROFILE_INPUT_CHARS
} = await import('../src/services/voice.js');
const { decrypt } = await import('../src/lib/crypto.js');
const { logger } = await import('../src/lib/logger.js');

const KEY = Buffer.alloc(32, 11).toString('base64');
let previousKey;

function textResponse(text) {
  return { content: [{ type: 'text', text }] };
}

const PROFILE_TEXT = JSON.stringify({
  tone: 'direct and warm',
  formality_1to10: 4,
  greeting_styles: ['hey Sam'],
  signoff_styles: ['thanks,'],
  typical_length_words: { min: 40, median: 80, max: 140 },
  never_does: ['never says "I hope this email finds you well"']
});

function longEmail(marker, words = 30) {
  return `${marker} ${Array.from({ length: words }, (_, i) => `word${i}`).join(' ')}`;
}

/** Supabase chain for saveVoiceProfile: from().insert().select().single() */
function mockInsert(result) {
  const capture = {};
  supabaseFrom.mockReturnValue({
    insert: (payload) => {
      capture.payload = payload;
      return { select: () => ({ single: async () => result }) };
    }
  });
  return capture;
}

/** Supabase chain for getVoiceProfile: from().select().eq().order().limit().maybeSingle() */
function mockSelectLatest(result) {
  supabaseFrom.mockReturnValue({
    select: () => ({
      eq: () => ({
        order: () => ({ limit: () => ({ maybeSingle: async () => result }) })
      })
    })
  });
}

beforeEach(() => {
  previousKey = process.env.TOKEN_ENC_KEY;
  process.env.TOKEN_ENC_KEY = KEY;

  create.mockReset();
  fetchSentEmails.mockReset();
  supabaseFrom.mockReset();
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
});

afterEach(() => {
  if (previousKey === undefined) delete process.env.TOKEN_ENC_KEY;
  else process.env.TOKEN_ENC_KEY = previousKey;
});

describe('parseProfileJson', () => {
  it('parses a bare JSON object', () => {
    expect(parseProfileJson('{"tone":"warm"}')).toEqual({ tone: 'warm' });
  });

  it('strips ```json fences', () => {
    const parsed = parseProfileJson('```json\n{"tone":"warm","never_does":["semicolons"]}\n```');

    expect(parsed.tone).toBe('warm');
    expect(parsed.never_does).toEqual(['semicolons']);
  });

  it('strips bare ``` fences', () => {
    expect(parseProfileJson('```\n{"tone":"blunt"}\n```')).toEqual({ tone: 'blunt' });
  });

  it('ignores prose around the object', () => {
    expect(parseProfileJson('Here is the profile:\n{"tone":"warm"}\nHope that helps.')).toEqual({
      tone: 'warm'
    });
  });

  it('throws on malformed JSON', () => {
    expect(() => parseProfileJson('{"tone": "warm", oops')).toThrow(/not valid JSON/i);
    expect(() => parseProfileJson('not json at all')).toThrow(/not valid JSON/i);
  });

  it('throws on empty or non-object responses', () => {
    expect(() => parseProfileJson('')).toThrow(/empty/i);
    expect(() => parseProfileJson('   ')).toThrow(/empty/i);
    expect(() => parseProfileJson(null)).toThrow(/empty/i);
    expect(() => parseProfileJson('[1,2]')).toThrow(/not a JSON object/i);
  });

  it('never echoes the model output in the error', () => {
    try {
      parseProfileJson('{"body": "hey Sam, following up on pricing" oops');
      throw new Error('parseProfileJson should have thrown');
    } catch (err) {
      expect(err.message).not.toContain('following up on pricing');
    }
  });
});

describe('parseExemplarIndices', () => {
  it('converts 1-based email numbers to 0-based indices', () => {
    expect(parseExemplarIndices('[1,3,5]', 10)).toEqual([0, 2, 4]);
  });

  it('strips fences and prose', () => {
    expect(parseExemplarIndices('```json\n[2, 4]\n```', 10)).toEqual([1, 3]);
    expect(parseExemplarIndices('I picked [2, 4] for you', 10)).toEqual([1, 3]);
  });

  it('drops out-of-range, duplicate and junk entries', () => {
    expect(parseExemplarIndices('[0, 1, 1, 11, "x", 3]', 10)).toEqual([0, 2]);
  });

  it('returns an empty list for unparseable output', () => {
    expect(parseExemplarIndices('no idea', 10)).toEqual([]);
    expect(parseExemplarIndices('', 10)).toEqual([]);
  });
});

describe('redactPii', () => {
  it('removes email addresses', () => {
    const result = redactPii('ping sam.rivera+news@acme.co.uk when you can');

    expect(result).not.toContain('acme.co.uk');
    expect(result).toContain('[email redacted]');
  });

  it('removes phone numbers', () => {
    const result = redactPii('call me on +1 (415) 555-0132 tomorrow');

    expect(result).not.toContain('555');
    expect(result).toContain('[phone redacted]');
  });

  it('leaves ordinary prose and short numbers alone', () => {
    expect(redactPii('we need 2 or 3 seats, Sam')).toBe('we need 2 or 3 seats, Sam');
  });

  it('returns an empty string for non-strings', () => {
    expect(redactPii(undefined)).toBe('');
  });
});

describe('capEmailsToCharBudget', () => {
  it('keeps the most recent emails that fit the budget', () => {
    const emails = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)];

    expect(capEmailsToCharBudget(emails, 100)).toEqual([emails[0], emails[1]]);
  });

  it('keeps everything when it already fits', () => {
    const emails = ['short one', 'short two'];

    expect(capEmailsToCharBudget(emails, 1000)).toEqual(emails);
  });

  it('defaults to the 80k char window', () => {
    expect(MAX_PROFILE_INPUT_CHARS).toBe(80000);

    const emails = Array.from({ length: 100 }, (_, i) => `MARK${i} ${'x'.repeat(1000)}`);
    const kept = capEmailsToCharBudget(emails);

    expect(kept.length).toBeLessThan(emails.length);
    expect(kept[0]).toContain('MARK0');
    expect(kept.join('').length).toBeLessThanOrEqual(80000);
  });

  it('ignores empty entries', () => {
    expect(capEmailsToCharBudget(['', '  ', 'real'], 1000)).toEqual(['real']);
  });
});

describe('buildVoiceProfile', () => {
  it('makes exactly one Anthropic call with the pinned model', async () => {
    create.mockResolvedValue(textResponse(PROFILE_TEXT));

    const profile = await buildVoiceProfile(['hey Sam, following up on the deck']);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].model).toBe('claude-sonnet-4-6');
    expect(profile.tone).toBe('direct and warm');
    expect(profile.never_does).toHaveLength(1);
  });

  it('seeds learned_corrections so the edit-learning loop has somewhere to append', async () => {
    create.mockResolvedValue(textResponse(PROFILE_TEXT));

    const profile = await buildVoiceProfile(['hey Sam, following up on the deck']);

    expect(profile.learned_corrections).toEqual([]);
  });

  it('caps the prompt at the 80k char window, keeping the most recent emails', async () => {
    create.mockResolvedValue(textResponse(PROFILE_TEXT));
    const emails = Array.from({ length: 100 }, (_, i) => `MARK${i} ${'x'.repeat(1000)}`);

    await buildVoiceProfile(emails);

    const prompt = create.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('MARK0');
    expect(prompt).not.toContain('MARK99');
    expect(prompt.length).toBeLessThan(MAX_PROFILE_INPUT_CHARS + 5000);
  });

  it('rejects an empty inbox without calling the model', async () => {
    await expect(buildVoiceProfile([])).rejects.toThrow(/no sent emails/i);
    await expect(buildVoiceProfile(['   '])).rejects.toThrow(/no sent emails/i);
    expect(create).not.toHaveBeenCalled();
  });

  it('surfaces a parse failure without leaking the model output', async () => {
    create.mockResolvedValue(textResponse('sorry, I cannot help with hey Sam pricing'));

    await expect(buildVoiceProfile(['hey Sam'])).rejects.toThrow(/not valid JSON/i);
  });
});

describe('selectExemplars', () => {
  const emails = Array.from({ length: 12 }, (_, i) => longEmail(`MARK${i}`));

  it('returns the emails the model picked, redacted', async () => {
    const withPii = `${longEmail('MARK0')} reach me at sam@acme.com or +1 415 555 0132`;
    create.mockResolvedValue(textResponse('[1,3,5,7,9]'));

    const exemplars = await selectExemplars([withPii, ...emails.slice(1)]);

    expect(exemplars).toHaveLength(5);
    expect(exemplars[0]).toContain('[email redacted]');
    expect(exemplars[0]).toContain('[phone redacted]');
    expect(exemplars[0]).not.toContain('sam@acme.com');
  });

  it('never returns more than 8 anchors', async () => {
    create.mockResolvedValue(textResponse('[1,2,3,4,5,6,7,8,9,10,11,12]'));

    expect(await selectExemplars(emails)).toHaveLength(8);
  });

  it('tops up to 5 when the model under-picks', async () => {
    create.mockResolvedValue(textResponse('[2]'));

    const exemplars = await selectExemplars(emails);

    expect(exemplars).toHaveLength(5);
    expect(exemplars[0]).toContain('MARK1');
  });

  it('excludes one-liners from the candidate pool', async () => {
    create.mockResolvedValue(textResponse('[]'));

    const exemplars = await selectExemplars(['ok', 'thanks!', ...emails]);

    expect(exemplars).toHaveLength(5);
    for (const exemplar of exemplars) {
      expect(exemplar).not.toBe('ok');
      expect(exemplar).not.toBe('thanks!');
    }
  });

  it('returns nothing when there is no usable input', async () => {
    expect(await selectExemplars([])).toEqual([]);
    expect(await selectExemplars(['hi'])).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('saveVoiceProfile', () => {
  it('encrypts the exemplars before the write', async () => {
    const capture = mockInsert({ data: { id: 'vp-1', version: 1 }, error: null });
    const exemplars = ['hey Sam, following up on the deck'];

    await saveVoiceProfile('user-1', { tone: 'warm' }, exemplars, 42);

    expect(capture.payload.user_id).toBe('user-1');
    expect(capture.payload.source_email_count).toBe(42);
    expect(capture.payload.version).toBe(1);
    expect(capture.payload.exemplars_enc).not.toContain('following up on the deck');
    expect(JSON.parse(decrypt(capture.payload.exemplars_enc))).toEqual(exemplars);
  });

  it('stores null when there are no exemplars', async () => {
    const capture = mockInsert({ data: { id: 'vp-1', version: 1 }, error: null });

    const saved = await saveVoiceProfile('user-1', { tone: 'warm' }, [], 3);

    expect(capture.payload.exemplars_enc).toBeNull();
    expect(saved.has_exemplars).toBe(false);
  });

  it('never returns the encrypted exemplars to the caller', async () => {
    mockInsert({ data: { id: 'vp-1', version: 1 }, error: null });

    const saved = await saveVoiceProfile('user-1', { tone: 'warm' }, ['anchor email'], 1);

    expect(saved.exemplars_enc).toBeUndefined();
    expect(saved.has_exemplars).toBe(true);
  });

  it('validates its inputs', async () => {
    await expect(saveVoiceProfile('', { tone: 'warm' }, [], 1)).rejects.toThrow(/userId/i);
    await expect(saveVoiceProfile('user-1', null, [], 1)).rejects.toThrow(/profile/i);
  });

  it('raises a generic failure when the insert fails', async () => {
    mockInsert({ data: null, error: { message: 'db down' } });

    await expect(saveVoiceProfile('user-1', { tone: 'warm' }, [], 1)).rejects.toThrow(
      /could not save the voice profile/i
    );
  });
});

describe('getVoiceProfile', () => {
  it('returns the row without the encrypted exemplars', async () => {
    mockSelectLatest({
      data: { id: 'vp-1', profile_json: { tone: 'warm' }, version: 2, exemplars_enc: 'ciphertext' },
      error: null
    });

    const profile = await getVoiceProfile('user-1');

    expect(profile.exemplars_enc).toBeUndefined();
    expect(profile.has_exemplars).toBe(true);
    expect(profile.profile_json).toEqual({ tone: 'warm' });
  });

  it('returns null when the user has no profile yet', async () => {
    mockSelectLatest({ data: null, error: null });

    expect(await getVoiceProfile('user-1')).toBeNull();
  });
});

describe('generateVoiceProfileForUser', () => {
  it('ingests, analyses, and saves without ever logging a body', async () => {
    fetchSentEmails.mockResolvedValue([longEmail('MARK0'), longEmail('MARK1')]);
    create
      .mockResolvedValueOnce(textResponse(PROFILE_TEXT))
      .mockResolvedValueOnce(textResponse('[1,2]'));
    const capture = mockInsert({ data: { id: 'vp-1', version: 1 }, error: null });

    const saved = await generateVoiceProfileForUser('user-1');

    expect(fetchSentEmails).toHaveBeenCalledWith('user-1');
    expect(capture.payload.source_email_count).toBe(2);
    expect(saved.id).toBe('vp-1');
    expect(logger.info).toHaveBeenCalledWith('voice_profile_built', {
      userId: 'user-1',
      count: 2,
      version: 1
    });
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('MARK0');
  });

  it('rejects when the mailbox has no sent email', async () => {
    fetchSentEmails.mockResolvedValue([]);

    await expect(generateVoiceProfileForUser('user-1')).rejects.toThrow(/no sent emails found/i);
    expect(create).not.toHaveBeenCalled();
  });

  it('still saves the profile when exemplar selection fails', async () => {
    fetchSentEmails.mockResolvedValue([longEmail('MARK0')]);
    create
      .mockResolvedValueOnce(textResponse(PROFILE_TEXT))
      .mockRejectedValueOnce(new Error('anthropic down'));
    const capture = mockInsert({ data: { id: 'vp-1', version: 1 }, error: null });

    await generateVoiceProfileForUser('user-1');

    expect(capture.payload.exemplars_enc).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });
});
