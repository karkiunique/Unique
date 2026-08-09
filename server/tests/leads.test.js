import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Lead upload service tests.
 *
 * Two things this file is really about.
 *
 * OWNER SCOPING: the Supabase fake records the filters of every query, because
 * the server uses the service-role key and bypasses RLS — the `user_id` filter
 * IS the access control. A test that only checked the returned counts would pass
 * just as happily against a service that filtered nothing.
 *
 * MESS: a real uploaded list is not a clean CSV. Every failure mode below —
 * duplicates, malformed rows, smuggled columns, a domain that cannot receive
 * mail, a resolver that times out — gets its own test, because a green suite
 * over a tidy fixture tells you nothing about the file a user will actually
 * upload.
 */

const { supabaseFrom, verifyRecipient } = vi.hoisted(() => ({
  supabaseFrom: vi.fn(),
  verifyRecipient: vi.fn()
}));

vi.mock('../src/lib/supabase.js', () => ({
  getSupabaseAdmin: () => ({ from: supabaseFrom }),
  resetSupabaseAdmin: () => {}
}));

vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  sanitizeMeta: (meta) => meta
}));

// Only the DNS-facing call is stubbed; the reason and status vocabularies stay
// real, so a rename in recipientCheck.js breaks this suite rather than sliding past.
vi.mock('../src/services/recipientCheck.js', async (importOriginal) => {
  const actual = await importOriginal();

  return { ...actual, verifyRecipient };
});

const { addLeads, checkLeadAddresses, MAX_LEADS_PER_REQUEST } = await import(
  '../src/services/leads.js'
);
const { logger } = await import('../src/lib/logger.js');

const OWNER = 'user-owner';
const STRANGER = 'user-stranger';
const CAMPAIGN_ID = 'camp-1';

const LEAD_COLUMNS = [
  'user_id',
  'campaign_id',
  'email',
  'first_name',
  'last_name',
  'company',
  'title',
  'linkedin_url',
  'status'
];

const DELIVERABLE = { status: 'ok', reasons: [], hasMx: true };

let campaignRows = [];
let leadRows = [];
let queries = [];

function matchesFilters(row, filters) {
  return Object.entries(filters).every(([column, value]) => row[column] === value);
}

function runQuery(query) {
  if (query.op === 'insert') {
    const values = Array.isArray(query.values) ? query.values : [query.values];
    const created = values.map((value, position) => ({
      id: `new-${leadRows.length + position + 1}`,
      created_at: '2026-08-07T00:00:00.000Z',
      ...value
    }));

    leadRows.push(...created);

    return created;
  }

  const rows = query.table === 'campaigns' ? campaignRows : leadRows;

  return rows.filter((row) => matchesFilters(row, query.filters));
}

/** Resolve once per query, so awaiting an insert twice cannot write twice. */
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

function insertedPayload() {
  const [insert] = queriesOn('leads', 'insert');

  return insert ? insert.values : [];
}

function seedCampaign(overrides = {}) {
  const row = { id: CAMPAIGN_ID, user_id: OWNER, ...overrides };
  campaignRows.push(row);

  return row;
}

function seedLead(email, overrides = {}) {
  const row = {
    id: `seeded-${leadRows.length + 1}`,
    campaign_id: CAMPAIGN_ID,
    user_id: OWNER,
    email,
    status: 'pending',
    ...overrides
  };
  leadRows.push(row);

  return row;
}

/** Per-domain verdicts; anything unlisted is a healthy domain. */
function verdictsByDomain(byDomain) {
  verifyRecipient.mockImplementation(async (address) => {
    const domain = String(address).split('@')[1]?.toLowerCase() ?? '';

    return byDomain[domain] ?? DELIVERABLE;
  });
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
  verifyRecipient.mockReset();
  verifyRecipient.mockResolvedValue(DELIVERABLE);
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
});

describe('addLeads — the happy path', () => {
  it("inserts valid rows as 'pending'", async () => {
    seedCampaign();

    const result = await addLeads(OWNER, CAMPAIGN_ID, [
      {
        email: 'marguerite@blackwood.example',
        first_name: 'Marguerite',
        last_name: 'Vance',
        company: 'Blackwood Holdings',
        title: 'Head of Operations',
        linkedin_url: 'https://linkedin.com/in/mvance'
      },
      { email: 'lee@corp.com' }
    ]);

    expect(result.inserted).toBe(2);
    expect(result.skipped).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(leadRows.map((row) => row.status)).toEqual(['pending', 'pending']);
    expect(leadRows[0].first_name).toBe('Marguerite');
    // A column the file did not carry is null, never an empty string that would
    // later merge into a letter as a blank.
    expect(leadRows[1].company).toBeNull();
  });

  it('trims every value before it is stored', async () => {
    seedCampaign();

    await addLeads(OWNER, CAMPAIGN_ID, [
      {
        email: '  sam@corp.com  ',
        first_name: '  Sam  ',
        company: '\tCorp\n',
        title: ' Head of Ops '
      }
    ]);

    expect(leadRows[0]).toMatchObject({
      email: 'sam@corp.com',
      first_name: 'Sam',
      company: 'Corp',
      title: 'Head of Ops'
    });
  });
});

describe('addLeads — duplicates are a no-op, not an error', () => {
  it('skips an address listed twice in the same upload, inserting it once', async () => {
    seedCampaign();

    const result = await addLeads(OWNER, CAMPAIGN_ID, [
      { email: 'sam@corp.com', first_name: 'Sam' },
      { email: 'sam@corp.com', first_name: 'Samuel' }
    ]);

    expect(result.inserted).toBe(1);
    expect(result.skipped).toEqual([
      { index: 1, email: 'sam@corp.com', reason: 'duplicate_in_file' }
    ]);
    expect(result.rejected).toEqual([]);
    expect(leadRows).toHaveLength(1);
    // First occurrence wins; the second is dropped whole, not merged.
    expect(leadRows[0].first_name).toBe('Sam');
  });

  it('skips an address already on the campaign', async () => {
    seedCampaign();
    seedLead('sam@corp.com');

    const result = await addLeads(OWNER, CAMPAIGN_ID, [
      { email: 'sam@corp.com' },
      { email: 'lee@corp.com' }
    ]);

    expect(result.inserted).toBe(1);
    expect(result.skipped).toEqual([
      { index: 0, email: 'sam@corp.com', reason: 'duplicate_in_campaign' }
    ]);
    expect(insertedPayload().map((row) => row.email)).toEqual(['lee@corp.com']);
  });

  it('compares case-insensitively and ignores surrounding whitespace', async () => {
    seedCampaign();
    seedLead('sam@corp.com');

    const result = await addLeads(OWNER, CAMPAIGN_ID, [
      { email: '  SAM@Corp.com  ' },
      { email: 'lee@corp.com' },
      { email: ' Lee@CORP.com ' }
    ]);

    expect(result.inserted).toBe(1);
    expect(result.skipped).toEqual([
      { index: 0, email: 'SAM@Corp.com', reason: 'duplicate_in_campaign' },
      { index: 2, email: 'Lee@CORP.com', reason: 'duplicate_in_file' }
    ]);
  });

  it('does not treat a lead on another campaign as a duplicate', async () => {
    seedCampaign();
    seedLead('sam@corp.com', { campaign_id: 'camp-other' });

    const result = await addLeads(OWNER, CAMPAIGN_ID, [{ email: 'sam@corp.com' }]);

    expect(result.inserted).toBe(1);
    expect(result.skipped).toEqual([]);

    const [read] = queriesOn('leads', 'select');
    expect(read.filters).toEqual({ campaign_id: CAMPAIGN_ID, user_id: OWNER });
  });
});

describe('addLeads — one bad row is that row s problem', () => {
  it('rejects the malformed rows and still inserts the good ones', async () => {
    seedCampaign();

    const result = await addLeads(OWNER, CAMPAIGN_ID, [
      { email: 'sam@corp.com' },
      'not-a-row',
      { email: 'nope' },
      { email: '   ' },
      null,
      { email: 'lee@corp.com' }
    ]);

    expect(result.inserted).toBe(2);
    expect(result.rejected).toEqual([
      { index: 1, email: '', reason: 'not_a_row' },
      { index: 2, email: 'nope', reason: 'invalid_email' },
      { index: 3, email: '', reason: 'missing_email' },
      { index: 4, email: '', reason: 'not_a_row' }
    ]);
    expect(insertedPayload().map((row) => row.email)).toEqual(['sam@corp.com', 'lee@corp.com']);
  });

  it('rejects an address past the RFC 5321 length without touching the insert', async () => {
    seedCampaign();

    const result = await addLeads(OWNER, CAMPAIGN_ID, [
      { email: `${'x'.repeat(250)}@corp.com` },
      { email: 'sam@corp.com' }
    ]);

    expect(result.rejected).toEqual([
      { index: 0, email: `${'x'.repeat(250)}@corp.com`, reason: 'email_too_long' }
    ]);
    expect(result.inserted).toBe(1);
  });
});

describe('addLeads — what a row is not allowed to carry', () => {
  it('ignores a client-supplied status, user_id and campaign_id', async () => {
    seedCampaign();

    await addLeads(OWNER, CAMPAIGN_ID, [
      {
        email: 'sam@corp.com',
        status: 'sent',
        user_id: STRANGER,
        campaign_id: 'camp-somewhere-else',
        id: 'lead-hijacked'
      }
    ]);

    expect(insertedPayload()).toEqual([
      {
        user_id: OWNER,
        campaign_id: CAMPAIGN_ID,
        email: 'sam@corp.com',
        first_name: null,
        last_name: null,
        company: null,
        title: null,
        linkedin_url: null,
        status: 'pending'
      }
    ]);
  });

  it('never lets an unknown column reach the insert', async () => {
    seedCampaign();

    await addLeads(OWNER, CAMPAIGN_ID, [
      {
        email: 'sam@corp.com',
        salary: '120000',
        notes: 'called twice, keen',
        __parsed_extra: ['stray', 'columns'],
        fidelity_score: 100,
        sent_at: '2020-01-01'
      }
    ]);

    expect(Object.keys(insertedPayload()[0]).sort()).toEqual([...LEAD_COLUMNS].sort());
  });
});

describe('addLeads — the envelope', () => {
  it('refuses more rows than the cap and inserts nothing', async () => {
    seedCampaign();
    const rows = Array.from({ length: MAX_LEADS_PER_REQUEST + 1 }, (_unused, index) => ({
      email: `person${index}@corp.com`
    }));

    expect(await rejectionStatus(addLeads(OWNER, CAMPAIGN_ID, rows))).toBe(400);

    expect(leadRows).toHaveLength(0);
    expect(queriesOn('leads', 'insert')).toHaveLength(0);
    // Refused on the envelope, before the campaign is even looked up.
    expect(queriesOn('campaigns', 'select')).toHaveLength(0);
  });

  it('accepts a request sitting exactly on the cap', async () => {
    seedCampaign();
    const rows = Array.from({ length: MAX_LEADS_PER_REQUEST }, (_unused, index) => ({
      email: `person${index}@corp.com`
    }));

    const result = await addLeads(OWNER, CAMPAIGN_ID, rows);

    expect(result.inserted).toBe(MAX_LEADS_PER_REQUEST);
  });

  it('400s on an empty rows array rather than 500ing on it', async () => {
    seedCampaign();

    expect(await rejectionStatus(addLeads(OWNER, CAMPAIGN_ID, []))).toBe(400);
    expect(queriesOn('leads', 'insert')).toHaveLength(0);
  });

  it('400s when rows is not an array at all', async () => {
    seedCampaign();

    for (const rows of [undefined, null, 'sam@corp.com', { email: 'sam@corp.com' }, 7]) {
      expect(await rejectionStatus(addLeads(OWNER, CAMPAIGN_ID, rows))).toBe(400);
    }

    expect(queriesOn('leads', 'insert')).toHaveLength(0);
  });

  it('400s without a userId or a campaign id', async () => {
    seedCampaign();

    expect(await rejectionStatus(addLeads('', CAMPAIGN_ID, [{ email: 'a@corp.com' }]))).toBe(400);
    expect(await rejectionStatus(addLeads(OWNER, '', [{ email: 'a@corp.com' }]))).toBe(400);
  });
});

describe('addLeads — owner scoping', () => {
  it("404s on another user's campaign and writes nothing", async () => {
    seedCampaign();

    const status = await rejectionStatus(
      addLeads(STRANGER, CAMPAIGN_ID, [{ email: 'sam@corp.com' }])
    );

    expect(status).toBe(404);
    expect(leadRows).toHaveLength(0);
    expect(queriesOn('leads', 'insert')).toHaveLength(0);
    // The existing recipients are never even read: ownership is settled first.
    expect(queriesOn('leads', 'select')).toHaveLength(0);

    const [lookup] = queriesOn('campaigns', 'select');
    expect(lookup.filters).toEqual({ id: CAMPAIGN_ID, user_id: STRANGER });
  });

  it('404s on a campaign that does not exist', async () => {
    expect(await rejectionStatus(addLeads(OWNER, 'camp-nope', [{ email: 'a@corp.com' }]))).toBe(404);
  });

  it("stamps every inserted row with the caller's id and the campaign from the URL", async () => {
    seedCampaign();

    await addLeads(OWNER, CAMPAIGN_ID, [{ email: 'sam@corp.com' }, { email: 'lee@corp.com' }]);

    for (const row of insertedPayload()) {
      expect(row.user_id).toBe(OWNER);
      expect(row.campaign_id).toBe(CAMPAIGN_ID);
    }
  });
});

describe('addLeads — address verification is advisory', () => {
  it('flags a domain with no mail server but still inserts it', async () => {
    seedCampaign();
    verdictsByDomain({
      'nowhere.example': { status: 'invalid', reasons: ['no_mx'], hasMx: false }
    });

    const result = await addLeads(OWNER, CAMPAIGN_ID, [
      { email: 'sam@corp.com' },
      { email: 'lee@nowhere.example' }
    ]);

    // Advisory, never blocking: MX proves a domain can receive mail, never that
    // a mailbox exists, and the user may know something we do not.
    expect(result.inserted).toBe(2);
    expect(leadRows.map((row) => row.email)).toContain('lee@nowhere.example');
    expect(result.flagged).toEqual([
      { index: 1, email: 'lee@nowhere.example', status: 'invalid', reasons: ['no_mx'] }
    ]);
  });

  it("carries a DNS timeout through as 'unknown', never as invalid", async () => {
    seedCampaign();
    verdictsByDomain({
      'slow.example': { status: 'unknown', reasons: ['dns_timeout'], hasMx: false }
    });

    const result = await addLeads(OWNER, CAMPAIGN_ID, [{ email: 'sam@slow.example' }]);

    expect(result.inserted).toBe(1);
    expect(result.flagged).toEqual([
      { index: 0, email: 'sam@slow.example', status: 'unknown', reasons: ['dns_timeout'] }
    ]);
    // A slow resolver must never condemn a good address.
    expect(result.flagged[0].status).not.toBe('invalid');
  });

  it('resolves once per unique domain, not once per row', async () => {
    seedCampaign();
    const rows = [];
    for (let index = 0; index < 10; index += 1) {
      rows.push({ email: `person${index}@corp.com` });
      rows.push({ email: `person${index}@other.example` });
    }

    await addLeads(OWNER, CAMPAIGN_ID, rows);

    expect(rows).toHaveLength(20);
    expect(verifyRecipient).toHaveBeenCalledTimes(2);

    const asked = verifyRecipient.mock.calls.map(([address]) => String(address).split('@')[1]);
    expect(new Set(asked)).toEqual(new Set(['corp.com', 'other.example']));
  });

  it('flags a role inbox per row even though its domain was checked once', async () => {
    seedCampaign();

    const result = await addLeads(OWNER, CAMPAIGN_ID, [
      { email: 'sam@corp.com' },
      { email: 'info@corp.com' }
    ]);

    expect(verifyRecipient).toHaveBeenCalledTimes(1);
    expect(result.inserted).toBe(2);
    expect(result.flagged).toEqual([
      { index: 1, email: 'info@corp.com', status: 'warn', reasons: ['role_address'] }
    ]);
  });

  it('does not let the representative address lend its role flag to its neighbours', async () => {
    seedCampaign();

    // The FIRST address on this domain is the role inbox, so it is the one the
    // resolver is asked about — and it comes back flagged. That flag belongs to
    // the address, not the domain, and must not spread to its neighbours.
    verifyRecipient.mockImplementation(async (address) =>
      address === 'info@corp.com'
        ? { status: 'warn', reasons: ['role_address'], hasMx: true }
        : DELIVERABLE
    );

    const result = await addLeads(OWNER, CAMPAIGN_ID, [
      { email: 'info@corp.com' },
      { email: 'sam@corp.com' }
    ]);

    expect(verifyRecipient).toHaveBeenCalledTimes(1);
    expect(verifyRecipient.mock.calls[0][0]).toBe('info@corp.com');
    expect(result.flagged).toEqual([
      { index: 0, email: 'info@corp.com', status: 'warn', reasons: ['role_address'] }
    ]);
  });

  it('still completes the upload when verification itself falls over', async () => {
    seedCampaign();
    verifyRecipient.mockRejectedValue(new Error('resolver exploded'));

    const result = await addLeads(OWNER, CAMPAIGN_ID, [{ email: 'sam@corp.com' }]);

    expect(result.inserted).toBe(1);
    expect(result.flagged).toEqual([]);
  });
});

describe('checkLeadAddresses', () => {
  it("returns 'ok' with no reasons for a healthy address", async () => {
    const results = await checkLeadAddresses([{ index: 0, email: 'sam@corp.com' }]);

    expect(results).toEqual([{ index: 0, email: 'sam@corp.com', status: 'ok', reasons: [] }]);
  });

  it('gives every row on a dead domain the same verdict from one lookup', async () => {
    verdictsByDomain({
      'nowhere.example': { status: 'invalid', reasons: ['no_mx'], hasMx: false }
    });

    const results = await checkLeadAddresses([
      { index: 0, email: 'a@nowhere.example' },
      { index: 1, email: 'b@nowhere.example' },
      { index: 2, email: 'c@nowhere.example' }
    ]);

    expect(verifyRecipient).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.status)).toEqual(['invalid', 'invalid', 'invalid']);
  });

  it('returns an empty list for an empty input without asking the resolver', async () => {
    expect(await checkLeadAddresses([])).toEqual([]);
    expect(await checkLeadAddresses(null)).toEqual([]);
    expect(verifyRecipient).not.toHaveBeenCalled();
  });
});

describe('lead upload logging', () => {
  it('logs ids and counts only — never an address, name, company or title', async () => {
    seedCampaign();
    seedLead('lee@corp.com');

    await addLeads(OWNER, CAMPAIGN_ID, [
      {
        email: 'marguerite@blackwood.example',
        first_name: 'Marguerite',
        last_name: 'Vance',
        company: 'Blackwood Holdings',
        title: 'Head of Operations',
        linkedin_url: 'https://linkedin.com/in/mvance'
      },
      { email: 'lee@corp.com' },
      { email: 'not-an-address' }
    ]);

    const serialized = loggedText();

    // A lead row is third-party personal data (CLAUDE.md § Privacy).
    expect(serialized).not.toContain('marguerite@blackwood.example');
    expect(serialized).not.toContain('Marguerite');
    expect(serialized).not.toContain('Vance');
    expect(serialized).not.toContain('Blackwood');
    expect(serialized).not.toContain('Head of Operations');
    expect(serialized).not.toContain('linkedin.com');
    expect(serialized).not.toContain('lee@corp.com');
    expect(serialized).not.toContain('not-an-address');

    expect(logger.info).toHaveBeenCalledWith('leads_added', {
      userId: OWNER,
      campaignId: CAMPAIGN_ID,
      count: 1
    });
  });

  it('logs nothing at all when the campaign is not the caller s', async () => {
    seedCampaign();

    await rejectionStatus(addLeads(STRANGER, CAMPAIGN_ID, [{ email: 'sam@corp.com' }]));

    expect(loggedText()).not.toContain('sam@corp.com');
    expect(logger.info).not.toHaveBeenCalled();
  });
});
