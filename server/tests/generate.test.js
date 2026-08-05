import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { create, supabaseFrom } = vi.hoisted(() => ({
  create: vi.fn(),
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
vi.mock('../src/services/gmail.js', () => ({ fetchSentEmails: vi.fn() }));

vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  sanitizeMeta: (meta) => meta
}));

const { generateEmail, findBannedPhrases, MIN_FIDELITY_SCORE } = await import(
  '../src/services/generate.js'
);
const { encrypt } = await import('../src/lib/crypto.js');
const { verifyToken } = await import('../src/lib/unsubscribe.js');
const { logger } = await import('../src/lib/logger.js');

const KEY = Buffer.alloc(32, 13).toString('base64');
const ENV_KEYS = ['TOKEN_ENC_KEY', 'UNSUB_SECRET', 'APP_URL'];
const envBackup = {};

const TO = 'sam@corp.com';
const GOAL = 'ask for 15 minutes to show the demo';

const EXEMPLAR = 'hey Sam\n\nsaw the raise go through. worth 15 minutes next week?\n\nthanks,\nAna';

const PROFILE = {
  tone: 'direct and warm',
  formality_1to10: 4,
  greeting_styles: ['hey [Name]'],
  signoff_styles: ['thanks,'],
  typical_length_words: { min: 40, median: 70, max: 120 },
  never_does: ['never uses semicolons'],
  learned_corrections: []
};

function textResponse(text) {
  return { content: [{ type: 'text', text }] };
}

function draftJson(subject, body) {
  return JSON.stringify({ subject, body });
}

function fidelityJson(score, violations = []) {
  return JSON.stringify({ score_0to100: score, violations });
}

/** Supabase chain for loadProfileWithExemplars: select().eq().order().limit().maybeSingle() */
function mockProfileRow({ exemplars = [EXEMPLAR], profileJson = PROFILE } = {}) {
  supabaseFrom.mockReturnValue({
    select: () => ({
      eq: () => ({
        order: () => ({
          limit: () => ({
            maybeSingle: async () => ({
              data: {
                id: 'vp-1',
                profile_json: profileJson,
                exemplars_enc:
                  exemplars.length > 0 ? encrypt(JSON.stringify(exemplars)) : null
              },
              error: null
            })
          })
        })
      })
    })
  });
}

function promptsSentToModel() {
  return create.mock.calls.map((call) => call[0].messages[0].content);
}

beforeEach(() => {
  for (const key of ENV_KEYS) envBackup[key] = process.env[key];

  process.env.TOKEN_ENC_KEY = KEY;
  process.env.UNSUB_SECRET = 'unsub-secret-for-tests';
  process.env.APP_URL = 'http://localhost:5173';

  create.mockReset();
  supabaseFrom.mockReset();
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (envBackup[key] === undefined) delete process.env[key];
    else process.env[key] = envBackup[key];
  }
});

describe('generateEmail', () => {
  it('returns a subject and body, parsing a fenced ```json response', async () => {
    mockProfileRow();
    create
      .mockResolvedValueOnce(
        textResponse(
          '```json\n{"subject":"about the raise","body":"hey Sam\\n\\nworth 15 minutes?"}\n```'
        )
      )
      .mockResolvedValueOnce(textResponse(fidelityJson(92)));

    const result = await generateEmail('user-1', { to: TO, goal: GOAL });

    expect(result.subject).toBe('about the raise');
    expect(result.body).toContain('hey Sam');
    expect(result.fidelityScore).toBe(92);
    expect(result.violations).toEqual([]);
    // One draft call plus one fidelity call, and nothing else.
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0].model).toBe('claude-sonnet-4-6');
  });

  it('regenerates exactly once when a banned phrase is used', async () => {
    mockProfileRow();
    create
      .mockResolvedValueOnce(
        textResponse(
          draftJson('about the raise', 'I hope this email finds you well. worth 15 minutes?')
        )
      )
      .mockResolvedValueOnce(
        textResponse(draftJson('about the raise', 'hey Sam\n\nworth 15 minutes?'))
      )
      .mockResolvedValueOnce(textResponse(fidelityJson(90)));

    const result = await generateEmail('user-1', { to: TO, goal: GOAL });

    // draft, ONE redraft, fidelity — not two redrafts.
    expect(create).toHaveBeenCalledTimes(3);
    expect(result.body).not.toContain('I hope this email finds you well');
    // The violation is fed back into the retry prompt (normalised to lower case).
    expect(promptsSentToModel()[1]).toContain('i hope this email finds you well');
  });

  it('rejects "quick question" as a subject and regenerates once', async () => {
    mockProfileRow();
    create
      .mockResolvedValueOnce(textResponse(draftJson('quick question', 'hey Sam\n\nworth 15?')))
      .mockResolvedValueOnce(
        textResponse(draftJson('about the raise', 'hey Sam\n\nworth 15 minutes?'))
      )
      .mockResolvedValueOnce(textResponse(fidelityJson(88)));

    const result = await generateEmail('user-1', { to: TO, goal: GOAL });

    expect(create).toHaveBeenCalledTimes(3);
    expect(result.subject).toBe('about the raise');
  });

  it('regenerates once on a low fidelity score and returns the score rather than throwing', async () => {
    mockProfileRow();
    create
      .mockResolvedValueOnce(
        textResponse(draftJson('about the raise', 'hey Sam\n\nthis one runs far too long'))
      )
      .mockResolvedValueOnce(textResponse(fidelityJson(61, ['far longer than their median'])))
      .mockResolvedValueOnce(textResponse(draftJson('about the raise', 'hey Sam\n\nshorter?')))
      .mockResolvedValueOnce(textResponse(fidelityJson(72, ['still longer than their median'])));

    const result = await generateEmail('user-1', { to: TO, goal: GOAL });

    // draft, score, ONE redraft, re-score. No third draft.
    expect(create).toHaveBeenCalledTimes(4);
    expect(result.fidelityScore).toBe(72);
    expect(result.fidelityScore).toBeLessThan(MIN_FIDELITY_SCORE);
    expect(result.violations).toContain('still longer than their median');
    expect(promptsSentToModel()[2]).toContain('far longer than their median');
  });

  it('does not regenerate when the fidelity score clears the bar', async () => {
    mockProfileRow();
    create
      .mockResolvedValueOnce(
        textResponse(draftJson('about the raise', 'hey Sam\n\nworth 15 minutes?'))
      )
      .mockResolvedValueOnce(textResponse(fidelityJson(80)));

    const result = await generateEmail('user-1', { to: TO, goal: GOAL });

    expect(create).toHaveBeenCalledTimes(2);
    expect(result.fidelityScore).toBe(80);
  });

  it('appends the unsubscribe line with a token that verifies back to user and recipient', async () => {
    mockProfileRow();
    create
      .mockResolvedValueOnce(
        textResponse(draftJson('about the raise', 'hey Sam\n\nworth 15 minutes?'))
      )
      .mockResolvedValueOnce(textResponse(fidelityJson(95)));

    const result = await generateEmail('user-1', { to: TO, goal: GOAL });

    expect(result.body).toContain(
      "\n\nDon't want emails from me? [Unsubscribe](http://localhost:5173/u/"
    );

    const token = result.body.split('/u/')[1].replace(/\)\s*$/, '');
    expect(verifyToken(token)).toEqual({ u: 'user-1', e: TO });
  });

  it('decrypts the exemplars into the prompt and never logs them', async () => {
    mockProfileRow();
    create
      .mockResolvedValueOnce(
        textResponse(draftJson('about the raise', 'hey Sam\n\nworth 15 minutes?'))
      )
      .mockResolvedValueOnce(textResponse(fidelityJson(93)));

    await generateEmail('user-1', { to: TO, goal: GOAL });

    const [draftPrompt, fidelityPrompt] = promptsSentToModel();
    expect(draftPrompt).toContain('saw the raise go through');
    expect(draftPrompt).toContain('real emails this person wrote');
    expect(fidelityPrompt).toContain('saw the raise go through');

    const calls = [
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls
    ];
    for (const call of calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain('saw the raise go through');
      expect(serialized).not.toContain('worth 15 minutes');
      expect(serialized).not.toContain(TO);
    }

    expect(logger.info).toHaveBeenCalledWith('email_generated', {
      userId: 'user-1',
      score: 93,
      count: 0
    });
  });

  it('still generates when the profile has no exemplars stored', async () => {
    mockProfileRow({ exemplars: [] });
    create
      .mockResolvedValueOnce(
        textResponse(draftJson('about the raise', 'hey Sam\n\nworth 15 minutes?'))
      )
      .mockResolvedValueOnce(textResponse(fidelityJson(85)));

    const result = await generateEmail('user-1', { to: TO, goal: GOAL });

    expect(result.subject).toBe('about the raise');
    expect(promptsSentToModel()[0]).toContain('No sample emails are available');
  });

  it('validates its input before calling the model', async () => {
    mockProfileRow();

    await expect(generateEmail('user-1', { to: 'nope', goal: GOAL })).rejects.toThrow(
      /valid recipient/i
    );
    await expect(generateEmail('user-1', { to: TO, goal: '  ' })).rejects.toThrow(/goal/i);
    await expect(generateEmail('', { to: TO, goal: GOAL })).rejects.toThrow(/userId/i);

    expect(create).not.toHaveBeenCalled();
  });

  it('never echoes model output when the response is not JSON', async () => {
    mockProfileRow();
    create.mockResolvedValueOnce(textResponse('sorry, I cannot help with hey Sam pricing'));

    await expect(generateEmail('user-1', { to: TO, goal: GOAL })).rejects.toThrow(
      /did not return valid JSON/i
    );
  });
});

describe('findBannedPhrases', () => {
  it('flags every banned phrase in the subject or body', () => {
    const hits = findBannedPhrases({
      subject: 'catching up',
      body: "I know you're busy, so I'll keep this brief."
    });

    // Detection is case-insensitive, and the violation text echoes the constant,
    // which is stored lower case — it is fed back into a retry prompt, not shown.
    const joined = hits.join(' ').toLowerCase();

    expect(hits).toHaveLength(2);
    expect(joined).toContain("i know you're busy");
    expect(joined).toContain("i'll keep this brief");
  });

  it('allows "leverage" and "delve" when the user writes them themselves', () => {
    const draft = { subject: 'the numbers', body: 'we can leverage the existing contract.' };

    expect(findBannedPhrases(draft, '')).toHaveLength(1);
    expect(findBannedPhrases(draft, 'we leverage partners all the time')).toHaveLength(0);
  });

  it('bans "quick question" as a subject but not inside the body', () => {
    expect(findBannedPhrases({ subject: 'Quick Question', body: 'hey' })).toHaveLength(1);
    expect(findBannedPhrases({ subject: 'the demo', body: 'a quick question for you' })).toEqual(
      []
    );
  });
});
