import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * THE NEW-USER GUARANTEE, ON THE BATCH PATH (CLAUDE.md, Rules: "This is a
 * platform, not one person's tool").
 *
 * sparseProfile.test.js pins the builders in isolation; this pins what a new user
 * actually experiences. They upload a CSV on day one, their voice profile is a
 * nearly empty object, they may have deleted their exemplars in Settings — and the
 * run must still finish with every lead `generated`, none `failed`, and not one
 * construction in the prompt that they do not already write.
 *
 * Asserted on the payload the model actually received, so a service that started
 * assuming a rich profile fails here even while every prompt unit test stays green.
 * Harness shape follows generateBatch.test.js: the model is dispatched on the
 * SYSTEM prompt, because at concurrency 3 the calls interleave across leads.
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

const { beginCampaignGeneration, runCampaignGeneration } = await import(
  '../src/services/generateBatch.js'
);
// Imported, never re-typed: a copy of the text here could drift from the prompt
// the model is actually sent and the assertion would still pass.
const { SPELLING_CARVE_OUT, FIDELITY_SPELLING_RULE } = await import(
  '../src/services/generatePrompts.js'
);
const { VARIETY_HEADING, USED_OPENERS_HEADING, OPENER_CHOICE_HEADING, ASK_CHOICE_HEADING } =
  await import('../src/services/batchVariety.js');
const { encrypt } = await import('../src/lib/crypto.js');

const KEY = Buffer.alloc(32, 13).toString('base64');
const OWNER = 'user-new';
const CAMPAIGN_ID = 'camp-1';
const NAMES = ['Alpha', 'Bruno', 'Cyrille', 'Delphine', 'Esteban', 'Fatoumata'];

const EXEMPLAR = 'hi Sam\n\nsaw the round close. worth 15 minutes next week?\n\nthanks,\nAna';
const ONE_STARTER = 'saw that';
const ONE_ASK = 'worth 15 minutes next week?';

/** Day one: the profile row exists, and it says nothing about anyone. */
const EMPTY_PROFILE = {};

const ONE_STARTER_PROFILE = {
  sentence_starters: [ONE_STARTER],
  how_they_ask: `they ask flat out: "${ONE_ASK}"`
};

let campaignRows = [];
let leadRows = [];
let profileRows = [];
let modelCalls = [];
let encKeyBackup;

function signedBody(name) {
  return `hi ${name}\n\nworth 15 minutes next week?\n\nthanks,\nAna`;
}

/** First names are unique per fixture and appear in every prompt for that lead. */
function leadForPrompt(prompt) {
  return leadRows.find((lead) => prompt.includes(lead.first_name)) ?? null;
}

function rowsFor(table) {
  if (table === 'campaigns') return campaignRows;
  if (table === 'leads') return leadRows;

  return profileRows;
}

function runQuery(query) {
  const found = rowsFor(query.table).filter((row) =>
    Object.entries(query.filters).every(([column, value]) => row[column] === value)
  );

  if (query.op === 'update') {
    for (const row of found) Object.assign(row, query.values);
  }

  return found;
}

/** Resolve once per query, so awaiting the same builder twice cannot write twice. */
function settle(query) {
  if (!query.settled) query.settled = runQuery(query);

  return query.settled;
}

function builderFor(table, op, values) {
  const query = { table, op, values, filters: {}, settled: null };
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

function tableFake(table) {
  return {
    update: (values) => builderFor(table, 'update', values),
    select: () => builderFor(table, 'select', null)
  };
}

function seedCampaign() {
  campaignRows.push({
    id: CAMPAIGN_ID,
    user_id: OWNER,
    name: 'First outreach',
    mode: 'voice',
    template_body: null,
    subject_template: null,
    brief: null,
    clarifications: null,
    status: 'draft'
  });
}

function seedProfile(profileJson, { version = null, exemplars = [EXEMPLAR] } = {}) {
  profileRows.push({
    id: 'vp-1',
    user_id: OWNER,
    profile_json: profileJson,
    version,
    exemplars_enc: exemplars.length > 0 ? encrypt(JSON.stringify(exemplars)) : null
  });
}

function seedLeads(count) {
  return NAMES.slice(0, count).map((firstName, index) => {
    const row = {
      id: `lead-${index + 1}`,
      campaign_id: CAMPAIGN_ID,
      user_id: OWNER,
      email: `${firstName.toLowerCase()}@corp.example`,
      first_name: firstName,
      last_name: 'Okonjo',
      company: 'Corp',
      title: 'Head of Ops',
      research_json: null,
      status: 'pending',
      created_at: `2026-08-0${index + 1}T00:00:00.000Z`
    };
    leadRows.push(row);

    return row;
  });
}

async function generateAll() {
  return runCampaignGeneration(await beginCampaignGeneration(OWNER, CAMPAIGN_ID));
}

function callsOfKind(kind) {
  return modelCalls.filter((call) => call.kind === kind);
}

function promptFor(leadId, kind) {
  return callsOfKind(kind).find((call) => call.leadId === leadId)?.prompt ?? '';
}

/**
 * Just the variety block of a prompt. Sliced rather than searched: a bare
 * toContain over the whole prompt would pass off the profile JSON, which lists the
 * very same starter a few thousand characters further up.
 */
function varietySection(prompt) {
  const start = prompt.indexOf(VARIETY_HEADING);
  const end = prompt.indexOf('SIGN-OFF (required)');

  return start === -1 || end <= start ? '' : prompt.slice(start, end);
}

function bulletsIn(text) {
  return text
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2));
}

beforeEach(() => {
  encKeyBackup = process.env.TOKEN_ENC_KEY;
  process.env.TOKEN_ENC_KEY = KEY;

  campaignRows = [];
  leadRows = [];
  profileRows = [];
  modelCalls = [];

  supabaseFrom.mockReset();
  supabaseFrom.mockImplementation(tableFake);

  create.mockReset();
  create.mockImplementation(async (request) => {
    const kind = request.system.includes('You score how closely') ? 'fidelity' : 'draft';
    const prompt = request.messages[0].content;
    const lead = leadForPrompt(prompt);

    modelCalls.push({ kind, leadId: lead?.id ?? null, system: request.system, prompt });
    // A real tick, so overlapping work is observable rather than assumed.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const text =
      kind === 'fidelity'
        ? JSON.stringify({ score_0to100: 90, violations: [] })
        : JSON.stringify({ subject: 'the numbers', body: signedBody(lead?.first_name ?? 'there') });

    return { content: [{ type: 'text', text }] };
  });
});

afterEach(() => {
  if (encKeyBackup === undefined) delete process.env.TOKEN_ENC_KEY;
  else process.env.TOKEN_ENC_KEY = encKeyBackup;
});

describe('a brand-new user with an empty voice profile', () => {
  it('generates every lead in the batch, and fails none of them', async () => {
    seedCampaign();
    seedProfile(EMPTY_PROFILE);
    const leads = seedLeads(6);

    const summary = await generateAll();

    expect(summary).toMatchObject({ generated: 6, failed: 0, failures: [] });
    for (const lead of leads) {
      expect(lead.status).toBe('generated');
      expect(lead.generated_subject).toBe('the numbers');
      expect(lead.generated_body).toBe(signedBody(lead.first_name));
    }
    expect(campaignRows[0].status).toBe('review');
  });

  /**
   * THE ONE THAT MATTERS MOST. With nothing of theirs to offer, the prompt says
   * nothing about variety — an empty list of "their own openings" reads to a model
   * as licence to invent some, which is worse than six letters that sound alike.
   */
  it('sends no variety block at all rather than an empty list of choices', async () => {
    seedCampaign();
    seedProfile(EMPTY_PROFILE);
    seedLeads(6);

    await generateAll();

    expect(callsOfKind('draft')).toHaveLength(6);
    const headings = [
      VARIETY_HEADING,
      USED_OPENERS_HEADING,
      OPENER_CHOICE_HEADING,
      ASK_CHOICE_HEADING
    ];
    for (const call of callsOfKind('draft')) {
      for (const heading of headings) expect(call.prompt).not.toContain(heading);
    }
  });

  /**
   * `Number(null)` is 0 and 0 is finite — that exact bug once recorded a profile of
   * unknown version as a real generation-0 cohort. Unknown must stay unknown.
   */
  it('stores a variant of nulls, not of zeros and empty strings', async () => {
    seedCampaign();
    seedProfile(EMPTY_PROFILE);
    const [alpha] = seedLeads(1);

    await generateAll();

    expect(alpha.variant_json).toEqual({
      opener_starter: null,
      cta_form: null,
      length_band: null,
      profile_version: null
    });
    expect(alpha.variant_json.profile_version).not.toBe(0);
  });

  // A new user must get correct spelling too, and the carve-out cannot depend on
  // the profile naming a quirk of theirs to hang it on.
  it('still carries the spelling carve-out to the model', async () => {
    seedCampaign();
    seedProfile(EMPTY_PROFILE);
    const [alpha] = seedLeads(1);

    await generateAll();

    const draft = callsOfKind('draft').find((call) => call.leadId === alpha.id);

    expect(draft.system).toContain(SPELLING_CARVE_OUT);
    expect(draft.prompt).toContain(SPELLING_CARVE_OUT);
    expect(promptFor(alpha.id, 'fidelity')).toContain(FIDELITY_SPELLING_RULE);
  });
});

/**
 * Settings hard-deletes exemplars on request, so a profile with no anchors is a
 * supported state and not an edge case.
 */
describe('a user who deleted their exemplars', () => {
  it('generates the batch and never claims to have example emails it does not have', async () => {
    seedCampaign();
    seedProfile(EMPTY_PROFILE, { exemplars: [] });
    const leads = seedLeads(3);

    const summary = await generateAll();

    expect(summary).toMatchObject({ generated: 3, failed: 0 });
    for (const lead of leads) expect(lead.status).toBe('generated');

    const prompt = promptFor(leads[0].id, 'draft');
    expect(prompt).toContain('No sample emails are available');
    expect(prompt).not.toContain('real emails this person wrote');
    expect(prompt).not.toContain('REAL EMAIL 1');
    expect(prompt).not.toContain(EXEMPLAR);
  });
});

/**
 * One opener across six leads is the ordinary shape of a thin profile against a
 * real campaign. Reuse is then unavoidable — inventing is not.
 */
describe('a user whose profile names exactly one opening', () => {
  it('offers only that opening to all six leads, and invents no others', async () => {
    seedCampaign();
    seedProfile(ONE_STARTER_PROFILE, { version: 1 });
    const leads = seedLeads(6);

    const summary = await generateAll();

    expect(summary).toMatchObject({ generated: 6, failed: 0 });

    const theirOwn = [ONE_STARTER, ONE_ASK];
    for (const lead of leads) {
      const offered = bulletsIn(varietySection(promptFor(lead.id, 'draft')));

      expect(offered.length).toBeGreaterThan(0);
      for (const suggestion of offered) expect(theirOwn).toContain(suggestion);
      expect(lead.variant_json.opener_starter).toBe(ONE_STARTER);
      expect(lead.variant_json.cta_form).toBe(ONE_ASK);
    }
  });
});
