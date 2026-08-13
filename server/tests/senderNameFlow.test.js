import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * THE SIGN-OFF NAME, ON THE PATHS THAT ACTUALLY SEND (Decisions, 2026-08-13).
 *
 * signoffName.test.js pins the rule in isolation. This pins what a real user
 * experiences: that the name reaches the model on EVERY path that drafts under
 * their name — compose, the campaign batch, and the review screen's redraft of a
 * single lead — and that an unsigned draft from a brand-new user — no
 * `signoff_styles`, no exemplars — is caught and redrafted rather than sent.
 *
 * That user is the whole point. Enforcement used to be strongest for established
 * accounts and absent for first-time senders, and the failure was silent.
 *
 * Asserted on the payload the model actually received, so a service that stopped
 * passing the name would fail here even while every unit test stayed green.
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

const { generateEmail } = await import('../src/services/generate.js');
const { beginCampaignGeneration, runCampaignGeneration } = await import(
  '../src/services/generateBatch.js'
);
const { regenerateLead } = await import('../src/services/leadRegenerate.js');
const { logger } = await import('../src/lib/logger.js');

const KEY = Buffer.alloc(32, 13).toString('base64');
const OWNER = 'user-new';
const CAMPAIGN_ID = 'camp-1';
const NAME = 'Unique Karki';
const FIRST_NAME = 'Unique';

const TO = 'sam@corp.example';
const GOAL = 'ask for 15 minutes to walk through the numbers';

/** Day one: the profile row exists and says nothing about anyone. No exemplars. */
const NEW_USER_PROFILE = {};

const UNSIGNED_BODY = 'hey Sam\n\nworth 15 minutes next week?';
const SIGNED_BODY = `hey Sam\n\nworth 15 minutes next week?\n\nthanks,\n${FIRST_NAME}`;

let accountRows = [];
let profileRows = [];
let campaignRows = [];
let leadRows = [];
let encKeyBackup;

function textResponse(text) {
  return { content: [{ type: 'text', text }] };
}

function draftResponse(body) {
  return textResponse(JSON.stringify({ subject: 'the numbers', body }));
}

function fidelityResponse(score = 90) {
  return textResponse(JSON.stringify({ score_0to100: score, violations: [] }));
}

function rowsFor(table) {
  if (table === 'profiles') return accountRows;
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
    select: () => builderFor(table, 'select', null)
  };
}

/** The account row migration 006 writes the name onto. `null` = a pre-006 account. */
function seedAccount(fullName) {
  accountRows.push({ id: OWNER, email: 'ana@corp.example', full_name: fullName });
}

function seedVoiceProfile(profileJson = NEW_USER_PROFILE) {
  // exemplars_enc null: a brand-new user, or one who deleted them in Settings.
  profileRows.push({
    id: 'vp-1',
    user_id: OWNER,
    profile_json: profileJson,
    version: null,
    exemplars_enc: null
  });
}

function seedCampaignWithOneLead() {
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
  leadRows.push({
    id: 'lead-1',
    campaign_id: CAMPAIGN_ID,
    user_id: OWNER,
    email: TO,
    first_name: 'Sam',
    last_name: 'Okonjo',
    company: 'Corp',
    title: 'Head of Ops',
    research_json: null,
    status: 'pending',
    created_at: '2026-08-01T00:00:00.000Z'
  });
}

async function generateBatchOnce() {
  return runCampaignGeneration(await beginCampaignGeneration(OWNER, CAMPAIGN_ID));
}

function promptsSentToModel() {
  return create.mock.calls.map((call) => call[0].messages[0].content);
}

/** Just the sign-off section of a draft prompt — the profile JSON is above it. */
function signoffSection(prompt) {
  const at = prompt.indexOf('SIGN-OFF (required)');

  return at === -1 ? '' : prompt.slice(at);
}

beforeEach(() => {
  encKeyBackup = process.env.TOKEN_ENC_KEY;
  process.env.TOKEN_ENC_KEY = KEY;

  accountRows = [];
  profileRows = [];
  campaignRows = [];
  leadRows = [];

  supabaseFrom.mockReset();
  supabaseFrom.mockImplementation(tableFake);

  create.mockReset();
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
});

afterEach(() => {
  if (encKeyBackup === undefined) delete process.env.TOKEN_ENC_KEY;
  else process.env.TOKEN_ENC_KEY = encKeyBackup;
});

describe('the compose path', () => {
  it('tells the model the exact name to sign, even with no styles and no exemplars', async () => {
    seedAccount(NAME);
    seedVoiceProfile();
    create.mockResolvedValueOnce(draftResponse(SIGNED_BODY)).mockResolvedValueOnce(fidelityResponse());

    await generateEmail(OWNER, { to: TO, goal: GOAL });

    const section = signoffSection(promptsSentToModel()[0]);
    expect(section).toContain(NAME);
    expect(promptsSentToModel()[0]).toContain('No sample emails are available');
    // And it does not point the model at sample emails the prompt is not carrying:
    // that dangling reference is the other half of the new-user gap.
    expect(section).not.toContain('real emails above');
  });

  /**
   * THE GAP ITSELF. Before this, a new user's unsigned letter raised no violation
   * at all and went out under their own name.
   */
  it('redrafts a brand-new user\'s unsigned letter instead of sending it', async () => {
    seedAccount(NAME);
    seedVoiceProfile();
    create
      .mockResolvedValueOnce(draftResponse(UNSIGNED_BODY))
      .mockResolvedValueOnce(draftResponse(SIGNED_BODY))
      .mockResolvedValueOnce(fidelityResponse());

    const result = await generateEmail(OWNER, { to: TO, goal: GOAL });

    // draft, ONE redraft, fidelity.
    expect(create).toHaveBeenCalledTimes(3);
    expect(result.body).toBe(SIGNED_BODY);
    expect(result.violations).toEqual([]);
    // The violation is fed back into the retry prompt.
    expect(promptsSentToModel()[1]).toMatch(/signed with the sender's own name/i);
  });

  /**
   * A pre-006 account. It has no name and cannot be given one retroactively, so
   * it keeps exactly the old behaviour — nothing throws, nothing is blocked.
   */
  it('never blocks an account that has no name yet', async () => {
    seedAccount(null);
    seedVoiceProfile();
    create.mockResolvedValueOnce(draftResponse(UNSIGNED_BODY)).mockResolvedValueOnce(fidelityResponse());

    const result = await generateEmail(OWNER, { to: TO, goal: GOAL });

    // No retry: with neither a name nor a style there is no check to make.
    expect(create).toHaveBeenCalledTimes(2);
    expect(result.violations).toEqual([]);
    expect(result.body).toBe(UNSIGNED_BODY);
    expect(signoffSection(promptsSentToModel()[0])).not.toContain('undefined');
  });

  it('survives an account row that does not exist at all', async () => {
    seedVoiceProfile();
    create.mockResolvedValueOnce(draftResponse(UNSIGNED_BODY)).mockResolvedValueOnce(fidelityResponse());

    await expect(generateEmail(OWNER, { to: TO, goal: GOAL })).resolves.toMatchObject({
      violations: []
    });
  });

  it('never logs the name', async () => {
    seedAccount(NAME);
    seedVoiceProfile();
    create.mockResolvedValueOnce(draftResponse(SIGNED_BODY)).mockResolvedValueOnce(fidelityResponse());

    await generateEmail(OWNER, { to: TO, goal: GOAL });

    const lines = [
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls
    ];
    for (const line of lines) {
      const serialized = JSON.stringify(line);
      expect(serialized).not.toContain(NAME);
      expect(serialized).not.toContain(FIRST_NAME);
    }
  });
});

describe('the batch path', () => {
  it('carries the same name into every draft prompt of a run', async () => {
    seedAccount(NAME);
    seedVoiceProfile();
    seedCampaignWithOneLead();
    create.mockResolvedValueOnce(draftResponse(SIGNED_BODY)).mockResolvedValueOnce(fidelityResponse());

    const summary = await generateBatchOnce();

    expect(summary).toMatchObject({ generated: 1, failed: 0 });
    expect(signoffSection(promptsSentToModel()[0])).toContain(NAME);
  });

  it('redrafts an unsigned letter for a new user here too', async () => {
    seedAccount(NAME);
    seedVoiceProfile();
    seedCampaignWithOneLead();
    create
      .mockResolvedValueOnce(draftResponse(UNSIGNED_BODY))
      .mockResolvedValueOnce(draftResponse(SIGNED_BODY))
      .mockResolvedValueOnce(fidelityResponse());

    const summary = await generateBatchOnce();

    expect(create).toHaveBeenCalledTimes(3);
    expect(summary).toMatchObject({ generated: 1, failed: 0 });
    expect(leadRows[0].generated_body).toBe(SIGNED_BODY);
    expect(promptsSentToModel()[1]).toMatch(/signed with the sender's own name/i);
  });

  it('generates the run unchanged for an account with no name', async () => {
    seedAccount(null);
    seedVoiceProfile();
    seedCampaignWithOneLead();
    create.mockResolvedValueOnce(draftResponse(UNSIGNED_BODY)).mockResolvedValueOnce(fidelityResponse());

    const summary = await generateBatchOnce();

    expect(create).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ generated: 1, failed: 0 });
    expect(leadRows[0].status).toBe('generated');
  });
});

/**
 * The review screen's "redraft this one" is the THIRD caller into draftForLead,
 * and the one most easily forgotten: leadRegenerate.test.js mocks the batch
 * helpers wholesale, so nothing there notices if the redraft stops looking up the
 * sign-off name. These two run the real drafting, so dropping `senderName` from
 * the run object leadRegenerate.js builds fails here.
 */
describe('the redraft-one path (regenerateLead)', () => {
  it('carries the sign-off name into the redraft prompt, as the batch it reuses does', async () => {
    seedAccount(NAME);
    seedVoiceProfile();
    seedCampaignWithOneLead();
    const [lead] = leadRows;
    create.mockResolvedValueOnce(draftResponse(SIGNED_BODY)).mockResolvedValueOnce(fidelityResponse());

    const updated = await regenerateLead(OWNER, lead.id);

    expect(updated.generated_body).toBe(SIGNED_BODY);
    expect(signoffSection(promptsSentToModel()[0])).toContain(NAME);
  });

  /**
   * The assertion that matters: a prompt carrying the name proves nothing on its
   * own if the check never runs. A new user redrafting from the review screen must
   * get the same guardrail the batch gave them, not an unsigned letter stored back
   * onto the row they were reading.
   */
  it("redrafts a new user's unsigned letter here too, instead of storing it unsigned", async () => {
    seedAccount(NAME);
    seedVoiceProfile();
    seedCampaignWithOneLead();
    const [lead] = leadRows;
    create
      .mockResolvedValueOnce(draftResponse(UNSIGNED_BODY))
      .mockResolvedValueOnce(draftResponse(SIGNED_BODY))
      .mockResolvedValueOnce(fidelityResponse());

    const updated = await regenerateLead(OWNER, lead.id);

    // draft, ONE redraft, fidelity.
    expect(create).toHaveBeenCalledTimes(3);
    expect(updated.generated_body).toBe(SIGNED_BODY);
    expect(leadRows[0].generated_body).toBe(SIGNED_BODY);
    // The violation is fed back into the retry prompt.
    expect(promptsSentToModel()[1]).toMatch(/signed with the sender's own name/i);
  });
});
