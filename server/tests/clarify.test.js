import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The clarify pass.
 *
 * Three things are actually load-bearing here. The BRIEF has to reach the model
 * — that is the whole reason the column exists. The cap has to hold whatever the
 * model returns, because "at most 8" is a product rule and not a hope. And the
 * brief must not come back out anywhere: not in a log line, not in an error
 * message, not in a response beyond the questions themselves.
 *
 * Owner scoping is asserted on the QUERY the fake records, not on what the
 * caller gets back: the server bypasses RLS, so `user_id` on that read IS the
 * access control, and a service that filtered nothing would still 404 here by
 * luck of the fixtures.
 */

const { create, supabaseFrom } = vi.hoisted(() => ({
  create: vi.fn(),
  supabaseFrom: vi.fn()
}));

// Real module except the client: getModel() stays real so the pinned model is tested.
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

const { clarifyCampaign, parseClarifyQuestions } = await import('../src/services/clarify.js');
const { MAX_CLARIFYING_QUESTIONS, CLARIFY_SYSTEM_PROMPT } = await import(
  '../src/services/clarifyPrompts.js'
);
const { logger } = await import('../src/lib/logger.js');

const OWNER = 'user-owner';
const STRANGER = 'user-stranger';
const CAMPAIGN_ID = 'camp-1';

const BRIEF =
  'We run payroll for Nordic shipping firms. Blackwood Holdings just bought two fleets and ' +
  'their finance team is drowning in manual timesheets.';

const QUESTIONS = [
  'Who at a shipping firm should reply — finance, ops, or the captain?',
  'What is the one thing you want them to do?',
  'What results can you point to?'
];

let campaignRows = [];
let queries = [];

function textResponse(text) {
  return { content: [{ type: 'text', text }] };
}

function matchesFilters(row, filters) {
  return Object.entries(filters).every(([column, value]) => row[column] === value);
}

function builderFor(table, op) {
  const query = { table, op, columns: '', filters: {}, settled: null };
  queries.push(query);

  const chain = {
    select(columns = '') {
      query.columns = columns;
      return chain;
    },
    eq(column, value) {
      query.filters[column] = value;
      return chain;
    },
    maybeSingle: async () => {
      const found = campaignRows.filter((row) => matchesFilters(row, query.filters));
      return { data: found[0] ?? null, error: null };
    }
  };

  return chain;
}

function tableFake(table) {
  return { select: (columns) => builderFor(table, 'select').select(columns) };
}

function seedCampaign(overrides = {}) {
  const row = { id: CAMPAIGN_ID, user_id: OWNER, brief: BRIEF, ...overrides };
  campaignRows.push(row);

  return row;
}

/** The prompts the model was actually handed, system and user both. */
function modelCall(index = 0) {
  return create.mock.calls[index]?.[0] ?? null;
}

function loggedText() {
  return JSON.stringify([
    ...logger.info.mock.calls,
    ...logger.warn.mock.calls,
    ...logger.error.mock.calls
  ]);
}

/** The rejection itself, or null if the call did not reject at all. */
async function rejection(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

beforeEach(() => {
  campaignRows = [];
  queries = [];

  supabaseFrom.mockReset();
  supabaseFrom.mockImplementation(tableFake);

  create.mockReset();
  create.mockResolvedValue(textResponse(JSON.stringify({ questions: QUESTIONS })));

  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
});

describe('clarifyCampaign', () => {
  it('sends the brief to the model and returns its questions', async () => {
    seedCampaign();

    const result = await clarifyCampaign(OWNER, CAMPAIGN_ID);

    expect(result).toEqual({ campaignId: CAMPAIGN_ID, questions: QUESTIONS });

    const call = modelCall();
    expect(call.model).toBe('claude-sonnet-4-6');
    expect(call.system).toBe(CLARIFY_SYSTEM_PROMPT);
    // The brief is the input. Without it the model is inventing questions about
    // nothing, which is how "First test" happened in the first place.
    expect(call.messages[0].content).toContain(BRIEF);
  });

  it('tells the model not to ask about style, and to skip what the brief covers', async () => {
    seedCampaign();

    await clarifyCampaign(OWNER, CAMPAIGN_ID);

    const system = modelCall().system.toLowerCase();

    // Style comes from the voice profile, observed from real sent mail. Asking
    // would have the user describe a voice instead (CLAUDE.md, 2026-08-09).
    expect(system).toContain('never ask about their writing style');
    expect(system).toContain('never ask for anything the description already states');
    expect(system).toContain(String(MAX_CLARIFYING_QUESTIONS));
  });

  it(`returns at most ${MAX_CLARIFYING_QUESTIONS} questions when the model returns twenty`, async () => {
    seedCampaign();
    const twenty = Array.from({ length: 20 }, (_unused, index) => `Question number ${index + 1}?`);
    create.mockResolvedValue(textResponse(JSON.stringify({ questions: twenty })));

    const { questions } = await clarifyCampaign(OWNER, CAMPAIGN_ID);

    expect(questions).toHaveLength(MAX_CLARIFYING_QUESTIONS);
    expect(questions).toEqual(twenty.slice(0, MAX_CLARIFYING_QUESTIONS));
    expect(questions).not.toContain('Question number 9?');
  });

  it('400s without a brief, before a single model call is spent', async () => {
    seedCampaign({ brief: '   ' });

    const err = await rejection(clarifyCampaign(OWNER, CAMPAIGN_ID));

    expect(err?.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('accepts an empty question list as an answer, not a failure', async () => {
    seedCampaign();
    create.mockResolvedValue(textResponse(JSON.stringify({ questions: [] })));

    await expect(clarifyCampaign(OWNER, CAMPAIGN_ID)).resolves.toEqual({
      campaignId: CAMPAIGN_ID,
      questions: []
    });
  });
});

describe('clarifyCampaign — owner scoping', () => {
  it("404s on another user's campaign and never calls the model", async () => {
    seedCampaign();

    const err = await rejection(clarifyCampaign(STRANGER, CAMPAIGN_ID));

    expect(err?.status).toBe(404);
    expect(create).not.toHaveBeenCalled();
  });

  it('filters the campaign read by user_id, not by id alone', async () => {
    seedCampaign();

    await clarifyCampaign(OWNER, CAMPAIGN_ID);

    expect(queries).toHaveLength(1);
    expect(queries[0].filters).toEqual({ id: CAMPAIGN_ID, user_id: OWNER });
  });

  it('404s on an unknown campaign, and 400s without a userId or an id', async () => {
    expect((await rejection(clarifyCampaign(OWNER, 'camp-nope')))?.status).toBe(404);
    expect((await rejection(clarifyCampaign('', CAMPAIGN_ID)))?.status).toBe(400);
    expect((await rejection(clarifyCampaign(OWNER, '  ')))?.status).toBe(400);
  });
});

describe('clarifyCampaign — a model that misbehaves', () => {
  it('is a clean 502 on prose instead of JSON, and echoes none of it', async () => {
    seedCampaign();
    create.mockResolvedValue(
      textResponse(`I cannot help with that. Your brief mentioned ${BRIEF}`)
    );

    const err = await rejection(clarifyCampaign(OWNER, CAMPAIGN_ID));

    expect(err?.status).toBe(502);
    // The model's text is derived from the user's own brief: it never comes back.
    expect(err.message).not.toContain('Blackwood');
    expect(err.message).not.toContain('payroll');
    expect(err.message).not.toContain('I cannot help');
  });

  it('is a clean 502 when questions is not an array', async () => {
    seedCampaign();

    for (const payload of ['{"questions": "who should reply?"}', '{"notes": []}', '{}']) {
      create.mockResolvedValue(textResponse(payload));

      const err = await rejection(clarifyCampaign(OWNER, CAMPAIGN_ID));

      expect(err?.status).toBe(502);
    }
  });

  it('is a clean 502 on an empty response rather than a crash', async () => {
    seedCampaign();
    create.mockResolvedValue({ content: [] });

    const err = await rejection(clarifyCampaign(OWNER, CAMPAIGN_ID));

    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(502);
  });
});

describe('parseClarifyQuestions', () => {
  it('strips ```json fences the model wraps around the object', () => {
    const fenced = '```json\n{"questions": ["Who should reply?"]}\n```';

    expect(parseClarifyQuestions(fenced)).toEqual(['Who should reply?']);
  });

  it('drops blanks and duplicates, and trims what it keeps', () => {
    const text = JSON.stringify({
      questions: ['  Who should reply?  ', '', '   ', 'Who should reply?', 'What is the ask?']
    });

    expect(parseClarifyQuestions(text)).toEqual(['Who should reply?', 'What is the ask?']);
  });

  it('reads a question out of an object entry as well as a bare string', () => {
    const text = JSON.stringify({
      questions: [{ question: 'What proof do you have?' }, 'What is the ask?', { note: 'nope' }, 7]
    });

    expect(parseClarifyQuestions(text)).toEqual(['What proof do you have?', 'What is the ask?']);
  });
});

describe('clarify privacy', () => {
  it('logs ids and a count only — never the brief or a question', async () => {
    seedCampaign();

    await clarifyCampaign(OWNER, CAMPAIGN_ID);

    const serialized = loggedText();

    // The brief is user-authored content about their own business: it is treated
    // exactly like a template body (CLAUDE.md § Privacy).
    expect(serialized).not.toContain('Blackwood');
    expect(serialized).not.toContain('payroll');
    expect(serialized).not.toContain('Who at a shipping firm');

    expect(logger.info).toHaveBeenCalledWith('campaign_clarified', {
      userId: OWNER,
      campaignId: CAMPAIGN_ID,
      count: QUESTIONS.length
    });
  });

  it('logs nothing at all when the model response cannot be parsed', async () => {
    seedCampaign();
    create.mockResolvedValue(textResponse(`not json — ${BRIEF}`));

    await rejection(clarifyCampaign(OWNER, CAMPAIGN_ID));

    expect(loggedText()).not.toContain('Blackwood');
    expect(loggedText()).not.toContain('payroll');
    expect(logger.info).not.toHaveBeenCalled();
  });
});
