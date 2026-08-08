import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Campaign service tests.
 *
 * The Supabase fake below records the filters of every query it is handed. That
 * is the point of most of this file: the server uses the service-role key and
 * bypasses RLS, so `user_id` on each query IS the access control, and a test
 * that only checks the returned rows would pass just as happily against a
 * service that filtered nothing and got lucky with the fixtures.
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

const { createCampaign, listCampaigns, getCampaign, updateCampaign } = await import(
  '../src/services/campaigns.js'
);
const { logger } = await import('../src/lib/logger.js');

const OWNER = 'user-owner';
const STRANGER = 'user-stranger';
const NAME = 'Series A outreach';
const SUBJECT = 'a question about {{company}}';
const TEMPLATE = 'Hi {{first_name}},\n\n{{personalized}}\n\nworth 15 minutes?';
const NO_MARKER = 'Hi {{first_name}},\n\nwe do cold email. worth 15 minutes?';

let campaignRows = [];
let leadRows = [];
let queries = [];

function rowsFor(table) {
  return table === 'campaigns' ? campaignRows : leadRows;
}

function matchesFilters(row, filters) {
  return Object.entries(filters).every(([column, value]) => row[column] === value);
}

/** `leads(status)` is an embedded join in PostgREST; the fake resolves it the same way. */
function embedLeads(row, columns) {
  if (!columns.includes('leads(status)')) return row;

  return {
    ...row,
    leads: leadRows
      .filter((lead) => lead.campaign_id === row.id)
      .map(({ status }) => ({ status }))
  };
}

function runQuery(query) {
  if (query.op === 'insert') {
    const created = {
      id: `created-${campaignRows.length + 1}`,
      created_at: '2026-08-06T00:00:00.000Z',
      ...query.values
    };
    campaignRows.push(created);
    return [created];
  }

  const found = rowsFor(query.table).filter((row) => matchesFilters(row, query.filters));

  if (query.op === 'update') {
    for (const row of found) Object.assign(row, query.values);
    return found;
  }

  return found.map((row) => embedLeads(row, query.columns));
}

/** Resolve once per query, so awaiting an insert twice cannot write twice. */
function settle(query) {
  if (!query.settled) query.settled = runQuery(query);
  return query.settled;
}

function builderFor(table, op, values) {
  const query = { table, op, values, columns: '', filters: {}, order: null, settled: null };
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
    order(column, options) {
      query.order = { column, ascending: options?.ascending };
      return chain;
    },
    single: async () => ({ data: settle(query)[0] ?? null, error: null }),
    maybeSingle: async () => ({ data: settle(query)[0] ?? null, error: null }),
    then: (onFulfilled, onRejected) =>
      Promise.resolve({ data: settle(query), error: null }).then(onFulfilled, onRejected)
  };

  return chain;
}

function tableFake(table) {
  return {
    insert: (values) => builderFor(table, 'insert', values),
    update: (values) => builderFor(table, 'update', values),
    select: (columns) => builderFor(table, 'select', null).select(columns)
  };
}

function queriesOn(table, op) {
  return queries.filter((query) => query.table === table && query.op === op);
}

function seedCampaign(overrides = {}) {
  const row = {
    id: `camp-${campaignRows.length + 1}`,
    user_id: OWNER,
    name: NAME,
    mode: 'voice',
    template_body: null,
    subject_template: null,
    status: 'draft',
    created_at: '2026-08-01T00:00:00.000Z',
    ...overrides
  };
  campaignRows.push(row);

  return row;
}

function seedLead(campaignId, status, overrides = {}) {
  const lead = {
    id: `lead-${leadRows.length + 1}`,
    campaign_id: campaignId,
    user_id: OWNER,
    email: `lead${leadRows.length + 1}@corp.com`,
    first_name: 'Sam',
    company: 'Corp',
    status,
    created_at: '2026-08-02T00:00:00.000Z',
    ...overrides
  };
  leadRows.push(lead);

  return lead;
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

function loggedText() {
  return JSON.stringify([
    ...logger.info.mock.calls,
    ...logger.warn.mock.calls,
    ...logger.error.mock.calls
  ]);
}

beforeEach(() => {
  campaignRows = [];
  leadRows = [];
  queries = [];
  supabaseFrom.mockReset();
  supabaseFrom.mockImplementation(tableFake);
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
});

describe('createCampaign', () => {
  it('creates a voice campaign with a null template body', async () => {
    const campaign = await createCampaign(OWNER, {
      name: `  ${NAME}  `,
      mode: 'voice',
      // Offered in voice mode on purpose: it must be dropped, not stored.
      templateBody: TEMPLATE,
      subjectTemplate: SUBJECT
    });

    expect(campaign.mode).toBe('voice');
    expect(campaign.template_body).toBeNull();
    expect(campaign.name).toBe(NAME);
    expect(campaign.subject_template).toBe(SUBJECT);
    expect(campaign.status).toBe('draft');
    expect(campaign.user_id).toBe(OWNER);
  });

  it('stores the template verbatim when it carries a {{personalized}} section', async () => {
    const campaign = await createCampaign(OWNER, {
      name: NAME,
      mode: 'template',
      templateBody: TEMPLATE
    });

    expect(campaign.mode).toBe('template');
    expect(campaign.template_body).toBe(TEMPLATE);
    expect(campaign.subject_template).toBeNull();
  });

  it('rejects a template with no {{personalized}} section', async () => {
    // A template with no personalised section is a mail merge: every recipient
    // would get the same letter, which is the thing this product exists not to send.
    const status = await rejectionStatus(
      createCampaign(OWNER, { name: NAME, mode: 'template', templateBody: NO_MARKER })
    );

    expect(status).toBe(400);
    expect(campaignRows).toHaveLength(0);
    expect(queriesOn('campaigns', 'insert')).toHaveLength(0);
  });

  it('rejects template mode with no template body at all', async () => {
    const status = await rejectionStatus(
      createCampaign(OWNER, { name: NAME, mode: 'template', templateBody: '   ' })
    );

    expect(status).toBe(400);
    expect(campaignRows).toHaveLength(0);
  });

  it("rejects any mode that is not exactly 'voice' or 'template'", async () => {
    const rejected = ['Voice', 'VOICE', 'sequence', 'voice,template', '', null, undefined, 7];

    for (const mode of rejected) {
      expect(await rejectionStatus(createCampaign(OWNER, { name: NAME, mode }))).toBe(400);
    }

    expect(campaignRows).toHaveLength(0);
  });

  it('rejects an empty or whitespace-only name', async () => {
    for (const name of ['', '   ', '\n\t', null, undefined]) {
      expect(await rejectionStatus(createCampaign(OWNER, { name, mode: 'voice' }))).toBe(400);
    }

    expect(campaignRows).toHaveLength(0);
  });

  it('rejects an over-long name', async () => {
    const status = await rejectionStatus(
      createCampaign(OWNER, { name: 'x'.repeat(500), mode: 'voice' })
    );

    expect(status).toBe(400);
  });

  it('requires a userId', async () => {
    expect(await rejectionStatus(createCampaign('', { name: NAME, mode: 'voice' }))).toBe(400);
  });
});

describe('listCampaigns', () => {
  it('returns sent and replied counts, and zero for a campaign with no leads', async () => {
    const busy = seedCampaign({ id: 'camp-busy' });
    seedCampaign({ id: 'camp-quiet' });

    seedLead(busy.id, 'sent');
    seedLead(busy.id, 'sent');
    seedLead(busy.id, 'replied');
    seedLead(busy.id, 'pending');

    const campaigns = await listCampaigns(OWNER);
    const byId = Object.fromEntries(campaigns.map((campaign) => [campaign.id, campaign]));

    expect(byId['camp-busy'].sentCount).toBe(2);
    expect(byId['camp-busy'].repliedCount).toBe(1);
    expect(byId['camp-quiet'].sentCount).toBe(0);
    expect(byId['camp-quiet'].repliedCount).toBe(0);
    // The embedded lead rows are an implementation detail of the count query.
    expect(byId['camp-quiet'].leads).toBeUndefined();
  });

  it('filters on user_id, in one query, newest first', async () => {
    seedCampaign();
    seedCampaign({ id: 'camp-theirs', user_id: STRANGER });

    const campaigns = await listCampaigns(OWNER);

    const selects = queriesOn('campaigns', 'select');
    expect(selects).toHaveLength(1);
    expect(selects[0].filters.user_id).toBe(OWNER);
    expect(selects[0].order).toEqual({ column: 'created_at', ascending: false });
    // Counts come from an embedded join, not a query per campaign.
    expect(selects[0].columns).toContain('leads(status)');
    expect(queriesOn('leads', 'select')).toHaveLength(0);

    expect(campaigns.map((campaign) => campaign.id)).not.toContain('camp-theirs');
  });
});

describe('getCampaign', () => {
  it('returns the campaign with its leads and counts', async () => {
    const campaign = seedCampaign({ id: 'camp-1' });
    seedLead(campaign.id, 'sent');
    seedLead(campaign.id, 'replied');

    const detail = await getCampaign(OWNER, 'camp-1');

    expect(detail.id).toBe('camp-1');
    expect(detail.leads).toHaveLength(2);
    expect(detail.sentCount).toBe(1);
    expect(detail.repliedCount).toBe(1);
  });

  it("404s on another user's campaign, and filters both reads on user_id", async () => {
    seedCampaign({ id: 'camp-1' });
    seedLead('camp-1', 'sent');

    expect(await rejectionStatus(getCampaign(STRANGER, 'camp-1'))).toBe(404);

    const [campaignRead] = queriesOn('campaigns', 'select');
    expect(campaignRead.filters).toEqual({ id: 'camp-1', user_id: STRANGER });
    // The leads are never even reached: ownership is settled first.
    expect(queriesOn('leads', 'select')).toHaveLength(0);
  });

  it('scopes the lead read to the owner as well as the campaign', async () => {
    seedCampaign({ id: 'camp-1' });

    await getCampaign(OWNER, 'camp-1');

    const [leadRead] = queriesOn('leads', 'select');
    expect(leadRead.filters).toEqual({ campaign_id: 'camp-1', user_id: OWNER });
  });

  it('404s on an unknown campaign id', async () => {
    expect(await rejectionStatus(getCampaign(OWNER, 'camp-nope'))).toBe(404);
  });
});

describe('updateCampaign', () => {
  it('updates the name and subject template', async () => {
    seedCampaign({ id: 'camp-1' });

    const updated = await updateCampaign(OWNER, 'camp-1', {
      name: 'Renamed run',
      subjectTemplate: SUBJECT
    });

    expect(updated.name).toBe('Renamed run');
    expect(updated.subject_template).toBe(SUBJECT);
  });

  it('cannot change status, user_id, mode or id', async () => {
    seedCampaign({ id: 'camp-1' });

    await updateCampaign(OWNER, 'camp-1', {
      name: 'Renamed run',
      status: 'sending',
      user_id: STRANGER,
      mode: 'template',
      id: 'camp-hijacked'
    });

    const [write] = queriesOn('campaigns', 'update');
    expect(Object.keys(write.values)).toEqual(['name']);
    expect(campaignRows[0].status).toBe('draft');
    expect(campaignRows[0].user_id).toBe(OWNER);
    expect(campaignRows[0].mode).toBe('voice');
    expect(campaignRows[0].id).toBe('camp-1');
  });

  it('400s when a patch carries nothing editable', async () => {
    seedCampaign({ id: 'camp-1' });

    const status = await rejectionStatus(
      updateCampaign(OWNER, 'camp-1', { status: 'done', user_id: STRANGER })
    );

    expect(status).toBe(400);
    expect(queriesOn('campaigns', 'update')).toHaveLength(0);
  });

  it("404s on another user's campaign and writes nothing", async () => {
    seedCampaign({ id: 'camp-1' });

    const status = await rejectionStatus(
      updateCampaign(STRANGER, 'camp-1', { name: 'Renamed run' })
    );

    expect(status).toBe(404);
    expect(queriesOn('campaigns', 'update')).toHaveLength(0);
    expect(campaignRows[0].name).toBe(NAME);
  });

  it('carries user_id on the write itself, not just the ownership check', async () => {
    seedCampaign({ id: 'camp-1' });

    await updateCampaign(OWNER, 'camp-1', { name: 'Renamed run' });

    const [write] = queriesOn('campaigns', 'update');
    expect(write.filters).toEqual({ id: 'camp-1', user_id: OWNER });
  });

  it('rejects a template body that loses its {{personalized}} section', async () => {
    seedCampaign({ id: 'camp-1', mode: 'template', template_body: TEMPLATE });

    const status = await rejectionStatus(
      updateCampaign(OWNER, 'camp-1', { templateBody: NO_MARKER })
    );

    expect(status).toBe(400);
    expect(campaignRows[0].template_body).toBe(TEMPLATE);
  });

  it('rejects a template body on a voice campaign', async () => {
    seedCampaign({ id: 'camp-1' });

    const status = await rejectionStatus(
      updateCampaign(OWNER, 'camp-1', { templateBody: TEMPLATE })
    );

    expect(status).toBe(400);
  });

  it('clears the subject template when it is emptied', async () => {
    seedCampaign({ id: 'camp-1', subject_template: SUBJECT });

    const updated = await updateCampaign(OWNER, 'camp-1', { subjectTemplate: '  ' });

    expect(updated.subject_template).toBeNull();
  });
});

describe('campaign logging', () => {
  it('logs ids and counts only — never a name, subject or template body', async () => {
    const created = await createCampaign(OWNER, {
      name: NAME,
      mode: 'template',
      templateBody: TEMPLATE,
      subjectTemplate: SUBJECT
    });

    await listCampaigns(OWNER);
    await getCampaign(OWNER, created.id);
    await updateCampaign(OWNER, created.id, { name: NAME, subjectTemplate: SUBJECT });

    const serialized = loggedText();

    // A template body is user-authored email content (CLAUDE.md § Privacy).
    expect(serialized).not.toContain(NAME);
    expect(serialized).not.toContain(SUBJECT);
    expect(serialized).not.toContain('{{personalized}}');
    expect(serialized).not.toContain('worth 15 minutes');

    expect(logger.info).toHaveBeenCalledWith('campaign_created', {
      userId: OWNER,
      campaignId: created.id
    });
    expect(logger.info).toHaveBeenCalledWith('campaigns_listed', { userId: OWNER, count: 1 });
  });
});
