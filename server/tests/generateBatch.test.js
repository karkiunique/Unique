import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Batch generation.
 *
 * Two things this file is really testing. First, containment: one lead's model
 * call falling over must cost that lead and nothing else. Second, owner scoping —
 * the server bypasses RLS, so the `user_id` filter on every read and every write
 * IS the access control, and a test that only checked the returned rows would
 * pass against a service that filtered nothing and got lucky with the fixtures.
 *
 * The model is dispatched on the SYSTEM PROMPT rather than a call-order chain:
 * with concurrency 3 the calls interleave across leads, so an ordered chain of
 * mockResolvedValueOnce would be testing the scheduler, not the service.
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

const { beginCampaignGeneration, runCampaignGeneration, GENERATION_FAIL_REASON } = await import(
  '../src/services/generateBatch.js'
);
const { encrypt } = await import('../src/lib/crypto.js');
const { logger } = await import('../src/lib/logger.js');

const KEY = Buffer.alloc(32, 13).toString('base64');
const OWNER = 'user-owner';
const STRANGER = 'user-stranger';
const CAMPAIGN_ID = 'camp-1';

const EXEMPLAR = 'hey there\n\nsaw the raise go through. worth 15 minutes next week?\n\nthanks,\nAna';
const PROFILE = {
  tone: 'direct and warm',
  greeting_styles: ['hey [Name]'],
  signoff_styles: ['thanks,'],
  typical_length_words: { min: 40, median: 70, max: 120 },
  never_does: ['never uses semicolons'],
  learned_corrections: []
};

const TEMPLATE = 'Hi {{first_name}},\n\n{{personalized}}\n\nthanks,\nAna';
const SUBJECT_TEMPLATE = 'a question about {{company}}';

const BRIEF =
  'We run payroll for Nordic shipping firms. Blackwood just bought two fleets and their ' +
  'finance team is still on manual timesheets.';

let campaignRows = [];
let leadRows = [];
let profileRows = [];
let queries = [];
let timeline = [];
let modelCalls = [];
let attempts = {};
let inflight = 0;
let maxInflight = 0;
let respond = defaultRespond;
let encKeyBackup;

function textResponse(text) {
  return { content: [{ type: 'text', text }] };
}

function draftJson(subject, body) {
  return JSON.stringify({ subject, body });
}

function fidelityJson(score, violations = []) {
  return JSON.stringify({ score_0to100: score, violations });
}

function sectionsJson(sections) {
  return JSON.stringify({ sections });
}

function signedBody(name) {
  return `hey ${name}\n\nworth 15 minutes?\n\nthanks,\nAna`;
}

function defaultRespond({ kind, lead }) {
  if (kind === 'fidelity') return fidelityJson(90);
  if (kind === 'personalize') return sectionsJson([`saw ${lead.first_name} in the news.`]);
  return draftJson('about the raise', signedBody(lead.first_name));
}

function kindOf(system) {
  if (system.includes('You score how closely')) return 'fidelity';
  if (system.includes('You write the personalised sections')) return 'personalize';
  return 'draft';
}

/**
 * Which lead a prompt belongs to. First names are unique per fixture and appear
 * in the recipient block, the merged letter and the draft body alike, so the
 * fidelity prompt (which carries no recipient) is still attributable.
 */
function leadForPrompt(prompt) {
  return leadRows.find((lead) => lead.first_name && prompt.includes(lead.first_name)) ?? null;
}

function rowsFor(table) {
  if (table === 'campaigns') return campaignRows;
  if (table === 'leads') return leadRows;
  return profileRows;
}

function matchesFilters(row, filters) {
  return Object.entries(filters).every(([column, value]) => row[column] === value);
}

function runQuery(query) {
  const found = rowsFor(query.table).filter((row) => matchesFilters(row, query.filters));

  if (query.op === 'update') {
    for (const row of found) Object.assign(row, query.values);
    if (query.table === 'leads') timeline.push('lead_update');
  }

  return found;
}

/** Resolve once per query, so awaiting the same builder twice cannot write twice. */
function settle(query) {
  if (!query.settled) query.settled = runQuery(query);
  return query.settled;
}

function builderFor(table, op, values) {
  const query = { table, op, values, columns: '', filters: {}, settled: null };
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
    order: () => chain,
    limit: () => chain,
    single: async () => ({ data: settle(query)[0] ?? null, error: null }),
    maybeSingle: async () => ({ data: settle(query)[0] ?? null, error: null }),
    then: (onFulfilled, onRejected) =>
      Promise.resolve({ data: settle(query), error: null }).then(onFulfilled, onRejected)
  };

  return chain;
}

function tableFake(table) {
  return {
    update: (values) => builderFor(table, 'update', values),
    select: (columns) => builderFor(table, 'select', null).select(columns)
  };
}

function seedCampaign(overrides = {}) {
  const row = {
    id: CAMPAIGN_ID,
    user_id: OWNER,
    name: 'Series A outreach',
    mode: 'voice',
    template_body: null,
    subject_template: null,
    brief: null,
    clarifications: null,
    status: 'draft',
    ...overrides
  };
  campaignRows.push(row);

  return row;
}

function seedLead(firstName, overrides = {}) {
  const row = {
    id: `lead-${leadRows.length + 1}`,
    campaign_id: CAMPAIGN_ID,
    user_id: OWNER,
    email: `${firstName.toLowerCase()}@blackwood.example`,
    first_name: firstName,
    last_name: 'Okonjo',
    company: 'Blackwood Holdings',
    title: 'Head of Ops',
    research_json: null,
    status: 'pending',
    generated_subject: null,
    generated_body: null,
    fidelity_score: null,
    created_at: `2026-08-0${leadRows.length + 1}T00:00:00.000Z`,
    ...overrides
  };
  leadRows.push(row);

  return row;
}

function seedProfile() {
  profileRows.push({
    id: 'vp-1',
    user_id: OWNER,
    profile_json: PROFILE,
    exemplars_enc: encrypt(JSON.stringify([EXEMPLAR]))
  });
}

function seedNames(count) {
  return ['Alpha', 'Bruno', 'Cyrille', 'Delphine', 'Esteban', 'Fatoumata', 'Gunnar']
    .slice(0, count)
    .map((name) => seedLead(name));
}

async function generateAll(goal) {
  const prepared = await beginCampaignGeneration(OWNER, CAMPAIGN_ID, goal);
  return runCampaignGeneration(prepared);
}

function promptsSentToModel() {
  return modelCalls.map((call) => call.prompt);
}

/**
 * Just the goal the draft prompt carried — everything between the "what this
 * email needs to do" heading and the sign-off block that follows it.
 *
 * Sliced rather than searched over the whole prompt on purpose: a brief happens
 * to mention a recipient's employer, so `prompt.toContain(brief)` could pass off
 * the recipient block while the goal itself was empty.
 */
function goalSentToModel() {
  const prompt = modelCalls.find((call) => call.kind === 'draft')?.prompt ?? '';
  const start = prompt.indexOf('WHAT THIS EMAIL NEEDS TO DO:');
  const end = prompt.indexOf('SIGN-OFF (required)');

  return start === -1 || end <= start ? '' : prompt.slice(start, end);
}

function callsForLead(leadId) {
  return modelCalls.filter((call) => call.leadId === leadId);
}

function loggedText() {
  return JSON.stringify([
    ...logger.info.mock.calls,
    ...logger.warn.mock.calls,
    ...logger.error.mock.calls
  ]);
}

/** The HTTP status a call rejected with, or null if it did not reject at all. */
async function rejectionStatus(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err?.status ?? 'no status';
  }
}

beforeEach(() => {
  encKeyBackup = process.env.TOKEN_ENC_KEY;
  process.env.TOKEN_ENC_KEY = KEY;

  campaignRows = [];
  leadRows = [];
  profileRows = [];
  queries = [];
  timeline = [];
  modelCalls = [];
  attempts = {};
  inflight = 0;
  maxInflight = 0;
  respond = defaultRespond;

  supabaseFrom.mockReset();
  supabaseFrom.mockImplementation(tableFake);

  create.mockReset();
  create.mockImplementation(async (request) => {
    const kind = kindOf(request.system);
    const prompt = request.messages[0].content;
    const lead = leadForPrompt(prompt);
    const key = `${lead?.id ?? 'none'}:${kind}`;
    attempts[key] = (attempts[key] ?? 0) + 1;

    modelCalls.push({ kind, leadId: lead?.id ?? null, prompt });
    timeline.push('model');
    inflight += 1;
    maxInflight = Math.max(maxInflight, inflight);

    try {
      // A real tick, so overlapping work is observable rather than assumed.
      await new Promise((resolve) => setTimeout(resolve, 0));
      return textResponse(await respond({ kind, lead, prompt, attempt: attempts[key] }));
    } finally {
      inflight -= 1;
    }
  });

  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
});

afterEach(() => {
  if (encKeyBackup === undefined) delete process.env.TOKEN_ENC_KEY;
  else process.env.TOKEN_ENC_KEY = encKeyBackup;
});

describe('voice mode', () => {
  it('drafts every pending lead and stores subject, body and score', async () => {
    seedCampaign();
    seedProfile();
    const [alpha, bruno] = seedNames(2);

    const summary = await generateAll();

    expect(summary).toMatchObject({ generated: 2, failed: 0, failures: [] });
    for (const lead of [alpha, bruno]) {
      expect(lead.status).toBe('generated');
      expect(lead.generated_subject).toBe('about the raise');
      expect(lead.generated_body).toBe(signedBody(lead.first_name));
      expect(lead.fidelity_score).toBe(90);
    }
  });

  it('moves the campaign draft -> generating -> review', async () => {
    seedCampaign();
    seedProfile();
    seedNames(1);

    const prepared = await beginCampaignGeneration(OWNER, CAMPAIGN_ID);
    expect(campaignRows[0].status).toBe('generating');

    await runCampaignGeneration(prepared);
    expect(campaignRows[0].status).toBe('review');
  });

  it('puts the decrypted exemplars in every generation prompt', async () => {
    seedCampaign();
    seedProfile();
    seedNames(3);

    await generateAll();

    const drafts = modelCalls.filter((call) => call.kind === 'draft');
    expect(drafts).toHaveLength(3);
    for (const call of drafts) {
      expect(call.prompt).toContain('saw the raise go through');
      expect(call.prompt).toContain('real emails this person wrote');
    }
  });

  it('uses the campaign name as the goal, and an explicit goal when given one', async () => {
    seedCampaign();
    seedProfile();
    seedNames(1);

    await generateAll();
    expect(promptsSentToModel()[0]).toContain('Series A outreach');

    modelCalls = [];
    leadRows[0].status = 'pending';
    campaignRows[0].status = 'draft';

    await generateAll('book a 15 minute demo');
    expect(promptsSentToModel()[0]).toContain('book a 15 minute demo');
  });

  /**
   * THE REGRESSION THIS WHOLE COLUMN EXISTS FOR (migration 004). A campaign
   * called "First test" produced six letters about running a first test, because
   * the NAME was the goal. The brief is the goal; the name is not the input.
   */
  it('sends the brief as the goal, and not the campaign name', async () => {
    seedCampaign({ name: 'First test', brief: BRIEF });
    seedProfile();
    seedNames(1);

    await generateAll();

    const goal = goalSentToModel();
    expect(goal).toContain(BRIEF);
    expect(goal).not.toContain('First test');
    expect(promptsSentToModel()[0]).not.toContain('First test');
  });

  /**
   * A skipped question carries a null answer and is dropped whole. A dangling
   * "Q: ... A: null" in the prompt is worse than no question at all — it tells
   * the model there is nothing there rather than that we never asked.
   */
  it('adds the answered clarifications to the goal and leaves the skipped ones out', async () => {
    seedCampaign({
      brief: BRIEF,
      clarifications: [
        { question: 'Who should reply?', answer: 'the head of finance' },
        { question: 'What proof do you have?', answer: null },
        { question: 'What is the ask?', answer: '   ' }
      ]
    });
    seedProfile();
    seedNames(1);

    await generateAll();

    const goal = goalSentToModel();
    expect(goal).toContain(BRIEF);
    expect(goal).toContain('Who should reply?');
    expect(goal).toContain('the head of finance');

    expect(goal).not.toContain('What proof do you have?');
    expect(goal).not.toContain('What is the ask?');
    expect(goal).not.toContain('null');
    expect(goal).not.toContain('undefined');
  });

  it('falls back to the campaign name when the brief is empty, not to nothing', async () => {
    seedCampaign({ name: 'Series A outreach', brief: '   ' });
    seedProfile();
    seedNames(1);

    await generateAll();

    expect(goalSentToModel()).toContain('Series A outreach');
  });

  it('still prefers an explicit per-run goal over the brief', async () => {
    seedCampaign({ brief: BRIEF });
    seedProfile();
    seedNames(1);

    await generateAll('book a 15 minute demo');

    const goal = goalSentToModel();
    expect(goal).toContain('book a 15 minute demo');
    expect(goal).not.toContain('Nordic shipping');
  });

  it("prefers the user's own subject line over the model's when they wrote one", async () => {
    seedCampaign({ subject_template: SUBJECT_TEMPLATE });
    seedProfile();
    const [alpha] = seedNames(1);

    await generateAll();

    expect(alpha.generated_subject).toBe('a question about Blackwood Holdings');
  });

  // Decisions, 2026-08-06. The footer returns for Phase 4 batch SENDING, which is
  // a different thing from batch generation — it must not appear on a draft.
  it('appends no unsubscribe footer to a generated body', async () => {
    seedCampaign();
    seedProfile();
    const [alpha] = seedNames(1);

    await generateAll();

    expect(alpha.generated_body).not.toContain("Don't want emails from me?");
    expect(alpha.generated_body).not.toContain('[Unsubscribe]');
    expect(alpha.generated_body).not.toContain('/u/');
  });
});

describe('template mode', () => {
  function seedTemplateCampaign(overrides = {}) {
    return seedCampaign({
      mode: 'template',
      template_body: TEMPLATE,
      subject_template: SUBJECT_TEMPLATE,
      ...overrides
    });
  }

  it('substitutes merge vars in code — the model never sees a raw {{var}}', async () => {
    seedTemplateCampaign();
    seedProfile();
    const [alpha] = seedNames(1);

    await generateAll();

    for (const prompt of promptsSentToModel()) {
      expect(prompt).not.toContain('{{first_name}}');
      expect(prompt).not.toContain('{{company}}');
      expect(prompt).not.toContain('{{title}}');
    }

    const personalize = modelCalls.find((call) => call.kind === 'personalize');
    expect(personalize.prompt).toContain('Hi Alpha,');
    expect(personalize.prompt).toContain('[[PERSONALIZED 1]]');

    expect(alpha.generated_subject).toBe('a question about Blackwood Holdings');
    expect(alpha.generated_body).toBe('Hi Alpha,\n\nsaw Alpha in the news.\n\nthanks,\nAna');
    expect(alpha.generated_body).not.toContain('{{');
  });

  /**
   * CLAUDE.md §3: a missing merge var fails the lead. It must NEVER go out with a
   * blank spliced in — "Hi ," under someone's own name cannot be recalled.
   */
  it('fails a lead with a missing merge var and never blanks the substitution', async () => {
    seedTemplateCampaign();
    seedProfile();
    const [alpha] = seedNames(1);
    const bruno = seedLead('Bruno', { company: '   ' });

    const summary = await generateAll();

    expect(bruno.status).toBe('failed');
    expect(bruno.generated_body).toBeNull();
    expect(bruno.generated_subject).toBeNull();
    expect(summary.failures).toEqual([
      { leadId: bruno.id, reason: `${GENERATION_FAIL_REASON.MISSING_MERGE_VAR}:company` }
    ]);

    // Not one model call was spent on the lead we could not merge.
    expect(callsForLead(bruno.id)).toHaveLength(0);

    // The rest of the campaign is unaffected.
    expect(alpha.status).toBe('generated');
    expect(summary.generated).toBe(1);
  });

  it('refuses to start when a template campaign has no subject line', async () => {
    seedTemplateCampaign({ subject_template: null });
    seedProfile();
    seedNames(1);

    expect(await rejectionStatus(beginCampaignGeneration(OWNER, CAMPAIGN_ID))).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses to start when the template lost its {{personalized}} section', async () => {
    seedTemplateCampaign({ template_body: 'Hi {{first_name}},\n\nthanks,\nAna' });
    seedProfile();
    seedNames(1);

    expect(await rejectionStatus(beginCampaignGeneration(OWNER, CAMPAIGN_ID))).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  /**
   * Template mode keeps its OWN copy of the fidelity retry (generateTemplate.js),
   * and seedCampaign() defaults to voice mode — so without this case the retry
   * could be deleted outright with the suite still green. CLAUDE.md §3 makes the
   * single regenerate mandatory in both modes, and a regression here is silent:
   * the lead still saves, still reads `generated`, and only sounds less like the
   * user. Same BATCH rule as voice mode — regenerate once, then store the score
   * and leave the lead for a human.
   */
  it('re-personalises once on a low fidelity score and stores the second score', async () => {
    seedTemplateCampaign();
    seedProfile();
    const [alpha] = seedNames(1);

    respond = (call) =>
      call.kind === 'fidelity'
        ? fidelityJson(call.attempt === 1 ? 55 : 62, ['far longer than their median'])
        : defaultRespond(call);

    const summary = await generateAll();

    expect(alpha.status).toBe('generated');
    expect(alpha.fidelity_score).toBe(62);
    expect(alpha.generated_body).toBe('Hi Alpha,\n\nsaw Alpha in the news.\n\nthanks,\nAna');
    expect(summary).toMatchObject({ generated: 1, failed: 0 });

    // personalize, score, ONE re-personalize, re-score — not a second retry.
    const calls = callsForLead(alpha.id);
    expect(calls.map((call) => call.kind)).toEqual([
      'personalize',
      'fidelity',
      'personalize',
      'fidelity'
    ]);
    // A second call is not enough: the violations have to reach the redraft.
    expect(calls[2].prompt).toContain('far longer than their median');
  });

  /**
   * The anti-AI-slop guardrail on template mode's own retry. The DETECTION is
   * covered by the generateCore unit tests; what is proved here is that template
   * mode acts on a hit rather than assembling the slop into the user's letter and
   * storing it. Only the model's sections are checked — the letter around them is
   * the user's own writing (generateTemplate.js).
   */
  it('re-personalises once when a section comes back with a banned phrase', async () => {
    seedTemplateCampaign();
    seedProfile();
    const [alpha] = seedNames(1);

    respond = (call) =>
      call.kind === 'personalize' && call.attempt === 1
        ? sectionsJson(['I hope this email finds you well. saw the funding news.'])
        : defaultRespond(call);

    const summary = await generateAll();

    const calls = callsForLead(alpha.id);
    expect(calls.map((call) => call.kind)).toEqual(['personalize', 'personalize', 'fidelity']);
    // The phrase that was rejected is named back to the model on the retry.
    expect(calls[1].prompt).toContain('never use the phrase "i hope this email finds you well"');

    // What lands on the row is the clean second attempt, not the slop.
    expect(alpha.status).toBe('generated');
    expect(alpha.generated_body).toBe('Hi Alpha,\n\nsaw Alpha in the news.\n\nthanks,\nAna');
    expect(alpha.generated_body).not.toContain('I hope this email finds you well');
    expect(summary).toMatchObject({ generated: 1, failed: 0 });
  });
});

describe('resilience', () => {
  it('fails one lead on a malformed model response and generates the rest', async () => {
    seedCampaign();
    seedProfile();
    const [alpha, bruno, cyrille] = seedNames(3);

    respond = (call) =>
      call.lead?.id === bruno.id && call.kind === 'draft'
        ? 'sorry, I cannot help with that'
        : defaultRespond(call);

    const summary = await generateAll();

    expect(bruno.status).toBe('failed');
    expect(summary.failures).toEqual([
      { leadId: bruno.id, reason: GENERATION_FAIL_REASON.MODEL_FAILED }
    ]);
    expect(alpha.status).toBe('generated');
    expect(cyrille.status).toBe('generated');
    expect(summary.generated).toBe(2);
  });

  /**
   * The one that bites: a throw on lead three must not cost leads four and five.
   * Asserting "no exception escaped" is not enough — the other leads have to
   * actually reach `generated`.
   */
  it('keeps the batch running when a model call throws mid-batch', async () => {
    seedCampaign();
    seedProfile();
    const leads = seedNames(5);
    const broken = leads[2];

    respond = (call) => {
      if (call.lead?.id === broken.id) throw new Error('upstream 529');
      return defaultRespond(call);
    };

    const summary = await generateAll();

    expect(broken.status).toBe('failed');
    expect(summary).toMatchObject({ generated: 4, failed: 1 });

    for (const lead of leads.filter((entry) => entry.id !== broken.id)) {
      expect(lead.status).toBe('generated');
      expect(lead.generated_body).toBe(signedBody(lead.first_name));
    }

    expect(campaignRows[0].status).toBe('review');
  });

  /**
   * The BATCH fidelity rule, deliberately looser than compose (CLAUDE.md §3):
   * regenerate once, then store the score and leave the lead for a human. Never
   * blocked, never failed.
   */
  it('stores a twice-failed fidelity score and still marks the lead generated', async () => {
    seedCampaign();
    seedProfile();
    const [alpha] = seedNames(1);

    respond = (call) =>
      call.kind === 'fidelity'
        ? fidelityJson(call.attempt === 1 ? 55 : 62, ['far longer than their median'])
        : defaultRespond(call);

    const summary = await generateAll();

    expect(alpha.status).toBe('generated');
    expect(alpha.fidelity_score).toBe(62);
    expect(alpha.generated_body).toBe(signedBody('Alpha'));
    expect(summary).toMatchObject({ generated: 1, failed: 0 });

    // draft, score, ONE redraft, re-score — not a second retry.
    expect(callsForLead(alpha.id)).toHaveLength(4);
    // The violations are fed back into the redraft.
    expect(callsForLead(alpha.id)[2].prompt).toContain('far longer than their median');
  });

  it('leaves a lead pending when the draft is fine but the write fails', async () => {
    seedCampaign();
    seedProfile();
    const [alpha] = seedNames(1);

    supabaseFrom.mockImplementation((table) => {
      const fake = tableFake(table);
      if (table !== 'leads') return fake;

      return {
        ...fake,
        update: () => ({
          eq: () => ({ eq: () => Promise.resolve({ data: null, error: { message: 'boom' } }) })
        })
      };
    });

    const summary = await generateAll();

    expect(alpha.status).toBe('pending');
    expect(summary.failures).toEqual([
      { leadId: alpha.id, reason: GENERATION_FAIL_REASON.SAVE_FAILED }
    ]);
  });
});

describe('concurrency and progress', () => {
  it('never runs more than three leads at once', async () => {
    seedCampaign();
    seedProfile();
    seedNames(7);

    await generateAll();

    expect(maxInflight).toBe(3);
    expect(modelCalls.filter((call) => call.kind === 'draft')).toHaveLength(7);
  });

  it('writes each lead as it completes rather than once at the end', async () => {
    seedCampaign();
    seedProfile();
    seedNames(6);

    await generateAll();

    // A lead row landed before the last model call was even made. A service that
    // collected results and wrote once at the end could not satisfy this.
    expect(timeline.indexOf('lead_update')).toBeGreaterThan(-1);
    expect(timeline.indexOf('lead_update')).toBeLessThan(timeline.lastIndexOf('model'));
  });
});

describe('owner scoping', () => {
  it("404s on another user's campaign, touching nothing", async () => {
    seedCampaign();
    seedProfile();
    seedNames(2);

    expect(await rejectionStatus(beginCampaignGeneration(STRANGER, CAMPAIGN_ID))).toBe(404);

    expect(campaignRows[0].status).toBe('draft');
    expect(leadRows.every((lead) => lead.status === 'pending')).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it('filters every read and every write by user_id', async () => {
    seedCampaign();
    seedProfile();
    seedNames(2);

    await generateAll();

    expect(queries.length).toBeGreaterThan(0);
    for (const query of queries) {
      expect(query.filters.user_id).toBe(OWNER);
    }
  });

  it('400s when there are no pending recipients, and 409s a run already going', async () => {
    seedCampaign();
    seedProfile();

    expect(await rejectionStatus(beginCampaignGeneration(OWNER, CAMPAIGN_ID))).toBe(400);

    seedNames(1);
    campaignRows[0].status = 'generating';
    expect(await rejectionStatus(beginCampaignGeneration(OWNER, CAMPAIGN_ID))).toBe(409);
  });

  it('400s before any model call when there is no voice profile yet', async () => {
    seedCampaign();
    seedNames(1);

    expect(await rejectionStatus(beginCampaignGeneration(OWNER, CAMPAIGN_ID))).toBe(400);
    expect(create).not.toHaveBeenCalled();
    expect(campaignRows[0].status).toBe('draft');
  });
});

describe('privacy', () => {
  it('logs ids, counts and a reason code only', async () => {
    seedCampaign({ mode: 'template', template_body: TEMPLATE, subject_template: SUBJECT_TEMPLATE });
    seedProfile();
    seedNames(1);
    const bruno = seedLead('Bruno', { company: null });

    await generateAll();

    const serialized = loggedText();

    expect(serialized).not.toContain('alpha@blackwood.example');
    expect(serialized).not.toContain('Alpha');
    expect(serialized).not.toContain('Blackwood');
    expect(serialized).not.toContain('Head of Ops');
    expect(serialized).not.toContain('worth 15 minutes');
    expect(serialized).not.toContain('saw the raise go through');
    expect(serialized).not.toContain('a question about');

    expect(logger.warn).toHaveBeenCalledWith('lead_generation_failed', {
      userId: OWNER,
      campaignId: CAMPAIGN_ID,
      leadId: bruno.id,
      reason: `${GENERATION_FAIL_REASON.MISSING_MERGE_VAR}:company`
    });
    expect(logger.info).toHaveBeenCalledWith('campaign_generated', {
      userId: OWNER,
      campaignId: CAMPAIGN_ID,
      count: 1
    });
  });

  it('logs nothing from the model when a call throws', async () => {
    seedCampaign();
    seedProfile();
    seedNames(1);

    respond = () => {
      throw new Error('Anthropic rejected: hey Alpha worth 15 minutes?');
    };

    await generateAll();

    expect(loggedText()).not.toContain('worth 15 minutes');
    expect(loggedText()).not.toContain('Alpha');
  });
});
