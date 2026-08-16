import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Redrafting one lead from the review screen.
 *
 * What is specific to this path, and therefore what is tested here: it REUSES
 * the batch's drafting rather than writing its own (the batch's helpers are
 * mocked, so a fork would show up as an uncalled mock); a failed redraft leaves
 * the stored letter exactly as it was; a successful one withdraws approval and
 * clears the stale hand edit; and nothing it touches belongs to anybody else.
 *
 * Owner scoping is asserted on the QUERIES, not on the answer the caller gets.
 * Three layers are owner-scoped here — the lead read, the campaign read and the
 * write — so dropping `user_id` from any one of them on its own still 404s, or
 * still writes the right row, courtesy of the other two. Only the filters the
 * fake records show which layer did the filtering.
 */

const { supabaseFrom, loadProfile, draftForLead, missingMergeVarsFor, campaignGoal } = vi.hoisted(
  () => ({
    supabaseFrom: vi.fn(),
    loadProfile: vi.fn(),
    draftForLead: vi.fn(),
    missingMergeVarsFor: vi.fn(),
    campaignGoal: vi.fn()
  })
);

vi.mock('../src/lib/supabase.js', () => ({
  getSupabaseAdmin: () => ({ from: supabaseFrom }),
  resetSupabaseAdmin: () => {}
}));

vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  sanitizeMeta: (meta) => meta
}));

// Keeps googleapis out of this test entirely, and the exemplars encrypted-at-rest
// concern with it — decryption is voice.js's business and has its own suite.
vi.mock('../src/services/voice.js', () => ({ loadProfileWithExemplars: loadProfile }));

vi.mock('../src/services/generateBatch.js', () => ({
  draftForLead,
  missingMergeVarsFor,
  campaignGoal
}));

vi.mock('../src/services/editLearning.js', () => ({ recordEditCorrections: vi.fn() }));

const { regenerateLead } = await import('../src/services/leadRegenerate.js');
const { logger } = await import('../src/lib/logger.js');

const OWNER = 'user-owner';
const STRANGER = 'user-stranger';
const CAMPAIGN_ID = 'camp-1';

const OLD_SUBJECT = 'a question about Blackwood';
const OLD_BODY = 'hey Marguerite\n\nsaw the raise go through. worth 15 minutes?\n\nthanks,\nAna';
const OLD_EDIT = 'hey Marguerite\n\nworth 15 minutes next week?\n\nthanks,\nAna';
const NEW_DRAFT = {
  subject: 'about the raise',
  body: 'hey Marguerite\n\ncongratulations. worth 15 minutes?\n\nthanks,\nAna'
};

const VOICE = { profileJson: { tone: 'direct' }, exemplars: ['hey Sam, saw the raise go through'] };

let leadRows = [];
let campaignRows = [];
let queries = [];

function rowsFor(table) {
  return table === 'campaigns' ? campaignRows : leadRows;
}

function matchesFilters(row, filters) {
  return Object.entries(filters).every(([column, value]) => row[column] === value);
}

function settle(query) {
  if (query.settled) return query.settled;

  const found = rowsFor(query.table).filter((row) => matchesFilters(row, query.filters));
  if (query.op === 'update') {
    for (const row of found) Object.assign(row, query.values);
  }
  query.settled = found;

  return found;
}

function builderFor(table, op, values) {
  const query = { table, op, values, filters: {}, settled: null };
  queries.push(query);

  const chain = {
    select: () => chain,
    eq(column, value) {
      query.filters[column] = value;
      return chain;
    },
    order: () => chain,
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

/** The queries put to one table, in the order the service made them. */
function queriesOn(table, op) {
  return queries.filter((query) => query.table === table && query.op === op);
}

function seedCampaign(overrides = {}) {
  const row = {
    id: CAMPAIGN_ID,
    user_id: OWNER,
    name: 'Series A outreach',
    mode: 'voice',
    template_body: null,
    subject_template: null,
    status: 'review',
    ...overrides
  };
  campaignRows.push(row);

  return row;
}

function seedLead(overrides = {}) {
  const row = {
    id: `lead-${leadRows.length + 1}`,
    campaign_id: CAMPAIGN_ID,
    user_id: OWNER,
    email: 'marguerite@blackwood.example',
    first_name: 'Marguerite',
    last_name: 'Okonjo',
    company: 'Blackwood Holdings',
    title: 'Head of Ops',
    research_json: null,
    status: 'generated',
    fidelity_score: 61,
    generated_subject: OLD_SUBJECT,
    generated_body: OLD_BODY,
    edited_body: null,
    created_at: '2026-08-06T00:00:00.000Z',
    ...overrides
  };
  leadRows.push(row);

  return row;
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
  leadRows = [];
  campaignRows = [];
  queries = [];

  supabaseFrom.mockReset();
  supabaseFrom.mockImplementation(tableFake);

  loadProfile.mockReset();
  loadProfile.mockResolvedValue(VOICE);

  draftForLead.mockReset();
  draftForLead.mockResolvedValue({ draft: NEW_DRAFT, fidelityScore: 92, violations: [] });

  missingMergeVarsFor.mockReset();
  missingMergeVarsFor.mockReturnValue([]);

  campaignGoal.mockReset();
  campaignGoal.mockReturnValue('Series A outreach');

  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
});

describe('regenerateLead', () => {
  it('stores the new letter and sends the lead back for approval', async () => {
    seedCampaign();
    const lead = seedLead({ status: 'approved', edited_body: OLD_EDIT });

    const updated = await regenerateLead(OWNER, lead.id);

    expect(updated.generated_subject).toBe(NEW_DRAFT.subject);
    expect(updated.generated_body).toBe(NEW_DRAFT.body);
    expect(updated.fidelity_score).toBe(92);
    // New words are not the words that were approved.
    expect(updated.status).toBe('generated');
    // The old hand edit belonged to the old letter; keeping it would send it.
    expect(updated.edited_body).toBeNull();
  });

  /**
   * So does the old variant (migration 005). A redraft is not part of a batch, so
   * it has no assigned opener — but leaving the previous letter's variant on the
   * row would have the adaptation loop learn from a letter that no longer exists.
   */
  it('rewrites the variant on the same update, never leaving the old one behind', async () => {
    seedCampaign();
    const lead = seedLead({
      variant_json: { opener_starter: 'saw that', cta_form: 'worth 15 minutes next week?' }
    });

    await regenerateLead(OWNER, lead.id);

    const write = queriesOn('leads', 'update')[0];
    expect(write.values.generated_body).toBe(NEW_DRAFT.body);
    expect(write.values.variant_json).toEqual({
      opener_starter: null,
      cta_form: null,
      length_band: null,
      profile_version: null
    });
    expect(lead.variant_json.opener_starter).toBeNull();
  });

  it("reuses the batch's drafting, with this user's voice and campaign", async () => {
    const campaign = seedCampaign();
    const lead = seedLead();

    await regenerateLead(OWNER, lead.id, 'book fifteen minutes');

    expect(campaignGoal).toHaveBeenCalledWith(campaign, 'book fifteen minutes');
    const [run, drafted] = draftForLead.mock.calls[0];
    expect(run.userId).toBe(OWNER);
    expect(run.campaign.id).toBe(CAMPAIGN_ID);
    expect(run.voice).toBe(VOICE);
    expect(drafted.id).toBe(lead.id);
  });

  it('leaves every other lead on the campaign untouched', async () => {
    seedCampaign();
    const target = seedLead();
    const neighbour = seedLead({ status: 'approved' });
    const snapshot = { ...neighbour };

    await regenerateLead(OWNER, target.id);

    expect(neighbour).toEqual(snapshot);
    expect(draftForLead).toHaveBeenCalledTimes(1);
  });

  it('changes nothing when the model call fails', async () => {
    seedCampaign();
    const lead = seedLead({ status: 'approved' });
    const snapshot = { ...lead };
    draftForLead.mockRejectedValue(new Error('the model fell over'));

    await expect(regenerateLead(OWNER, lead.id)).rejects.toThrow();

    // A timeout must not cost the reviewer the letter they were reading.
    expect(lead).toEqual(snapshot);
    expect(queries.filter((query) => query.op === 'update')).toHaveLength(0);
  });

  it("404s on another user's lead, and never calls the model", async () => {
    seedCampaign();
    const lead = seedLead();

    expect(await rejectionStatus(regenerateLead(STRANGER, lead.id))).toBe(404);
    expect(draftForLead).not.toHaveBeenCalled();
    expect(loadProfile).not.toHaveBeenCalled();
  });

  it('404s when the campaign belongs to somebody else', async () => {
    seedCampaign({ user_id: STRANGER });
    const lead = seedLead();

    expect(await rejectionStatus(regenerateLead(OWNER, lead.id))).toBe(404);
    expect(draftForLead).not.toHaveBeenCalled();
  });

  it('filters the lead read on user_id, not just the campaign lookup behind it', async () => {
    seedCampaign();
    const lead = seedLead();

    expect(await rejectionStatus(regenerateLead(STRANGER, lead.id))).toBe(404);

    // The 404 alone proves nothing: an unfiltered lead read still 404s one step
    // later at the campaign. What must not happen is the row — address, name,
    // employer, research — being read into memory at all.
    expect(queriesOn('leads', 'select')[0].filters).toEqual({ id: lead.id, user_id: STRANGER });
  });

  it('carries user_id on the write itself, not just the two ownership checks', async () => {
    seedCampaign();
    const lead = seedLead();

    await regenerateLead(OWNER, lead.id);

    // Defence in depth: both reads ahead of this are owner-scoped, so an
    // unfiltered write still lands on the right row today. It is the last line
    // if either check is ever loosened.
    expect(queriesOn('leads', 'update')[0].filters).toEqual({ id: lead.id, user_id: OWNER });
  });

  it('refuses to redraft a letter that has gone out or is on its way', async () => {
    seedCampaign();

    for (const status of ['queued', 'sent', 'replied', 'bounced', 'unsubscribed']) {
      const lead = seedLead({ status });

      expect(await rejectionStatus(regenerateLead(OWNER, lead.id))).toBe(400);
      expect(lead.generated_body).toBe(OLD_BODY);
    }

    expect(draftForLead).not.toHaveBeenCalled();
  });

  it('redrafts a lead the batch could not write, and one never drafted for', async () => {
    seedCampaign();
    const failed = seedLead({ status: 'failed' });
    const untouched = seedLead({ status: 'pending', generated_body: null });

    expect((await regenerateLead(OWNER, failed.id)).status).toBe('generated');
    expect((await regenerateLead(OWNER, untouched.id)).status).toBe('generated');
  });

  it('refuses a lead missing a merge variable, naming the variable and not the value', async () => {
    seedCampaign({ mode: 'template', template_body: 'Hi {{first_name}},\n\n{{personalized}}' });
    const lead = seedLead({ company: null });
    missingMergeVarsFor.mockReturnValue(['company']);

    let message = '';
    try {
      await regenerateLead(OWNER, lead.id);
    } catch (err) {
      message = err.message;
    }

    expect(message).toContain('company');
    expect(message).not.toContain('Blackwood');
    expect(draftForLead).not.toHaveBeenCalled();
  });

  it('logs ids and the score only — never a letter or a recipient', async () => {
    seedCampaign();
    const lead = seedLead();

    await regenerateLead(OWNER, lead.id);

    const serialized = JSON.stringify([
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls
    ]);

    expect(serialized).not.toContain('congratulations');
    expect(serialized).not.toContain('Marguerite');
    expect(serialized).not.toContain('Blackwood');
    expect(serialized).not.toContain('marguerite@blackwood.example');
    expect(logger.info).toHaveBeenCalledWith('lead_redrafted', {
      userId: OWNER,
      campaignId: CAMPAIGN_ID,
      leadId: lead.id,
      score: 92
    });
  });
});
