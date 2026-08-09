import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

/**
 * The /api/campaigns routes: mounted, authenticated, and strict about what they
 * forward to the service. The service itself is mocked here — its behaviour is
 * covered in campaigns.test.js — so these assertions are about the wiring:
 * who the owner is, which body keys survive, and which status codes come back.
 */

// This suite exercises no Gmail call; the mock only keeps the real SDK out of the graph.
const { OAuth2, gmailFactory } = vi.hoisted(() => {
  const oauthClient = {
    generateAuthUrl: vi.fn(),
    getToken: vi.fn(),
    setCredentials: vi.fn()
  };
  const gmailApi = {
    users: {
      getProfile: vi.fn(),
      messages: { list: vi.fn(), get: vi.fn(), send: vi.fn() },
      threads: { list: vi.fn(), get: vi.fn() }
    }
  };

  return {
    // `new google.auth.OAuth2(...)` — the impl must be constructible, so no arrow.
    OAuth2: vi.fn(function OAuth2Mock() {
      return oauthClient;
    }),
    gmailFactory: vi.fn(() => gmailApi)
  };
});

const { getUser, create, list, get, update, add, begin, run } = vi.hoisted(() => ({
  getUser: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  add: vi.fn(),
  begin: vi.fn(),
  run: vi.fn()
}));

vi.mock('googleapis', () => ({
  google: { auth: { OAuth2 }, gmail: gmailFactory }
}));

vi.mock('../src/lib/supabase.js', () => ({
  getSupabaseAdmin: () => ({ auth: { getUser }, from: vi.fn() }),
  resetSupabaseAdmin: () => {}
}));

vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  sanitizeMeta: (meta) => meta
}));

vi.mock('../src/services/campaigns.js', () => ({
  createCampaign: create,
  listCampaigns: list,
  getCampaign: get,
  updateCampaign: update
}));

// Only addLeads is stubbed; MAX_LEADS_PER_REQUEST stays real, so the row-cap
// assertions below track the service rather than a number copied into a mock.
vi.mock('../src/services/leads.js', async (importOriginal) => {
  const actual = await importOriginal();

  return { ...actual, addLeads: add };
});

// The last three are the single-lead regenerate path's seam into the batch. They
// are unused by these routes, but the module is mocked whole, so the mock has to
// export everything leadRegenerate.js imports from it.
vi.mock('../src/services/generateBatch.js', () => ({
  beginCampaignGeneration: begin,
  runCampaignGeneration: run,
  draftForLead: vi.fn(),
  campaignGoal: vi.fn(),
  missingMergeVarsFor: vi.fn(() => [])
}));

const { createApp } = await import('../src/app.js');
const { MAX_LEADS_PER_REQUEST } = await import('../src/services/leads.js');
const { logger } = await import('../src/lib/logger.js');

const USER_ID = 'user-abc';
const TOKEN = 'Bearer good.jwt';
const CAMPAIGN_ID = '11111111-2222-4333-8444-555555555555';
const TEMPLATE = 'Hi {{first_name}},\n\n{{personalized}}\n\nworth 15 minutes?';

const CAMPAIGN = {
  id: CAMPAIGN_ID,
  user_id: USER_ID,
  name: 'Series A outreach',
  mode: 'template',
  template_body: TEMPLATE,
  subject_template: null,
  status: 'draft',
  created_at: '2026-08-06T00:00:00.000Z'
};

/**
 * What beginCampaignGeneration hands back. It carries the user's DECRYPTED voice
 * exemplars, so the route must pass it straight on and never serialize it — the
 * assertions below check exactly that.
 */
const PREPARED = {
  userId: USER_ID,
  campaign: CAMPAIGN,
  leads: [{ id: 'lead-1' }, { id: 'lead-2' }, { id: 'lead-3' }],
  voice: { profileJson: { tone: 'direct' }, exemplars: ['hey Sam, saw the raise go through'] },
  goal: 'Series A outreach',
  pending: 3
};

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  return err;
}

function authed(method, path) {
  return request(createApp())[method](path).set('Authorization', TOKEN);
}

beforeEach(() => {
  getUser.mockReset();
  getUser.mockResolvedValue({
    data: { user: { id: USER_ID, email: 'dev@example.com' } },
    error: null
  });

  create.mockReset();
  list.mockReset();
  get.mockReset();
  update.mockReset();
  add.mockReset();
  begin.mockReset();
  run.mockReset();

  create.mockResolvedValue(CAMPAIGN);
  list.mockResolvedValue([{ ...CAMPAIGN, sentCount: 2, repliedCount: 1 }]);
  get.mockResolvedValue({ ...CAMPAIGN, sentCount: 0, repliedCount: 0, leads: [] });
  update.mockResolvedValue({ ...CAMPAIGN, name: 'Renamed run' });
  add.mockResolvedValue({ inserted: 1, skipped: [], rejected: [], flagged: [] });
  begin.mockResolvedValue(PREPARED);
  run.mockResolvedValue({ campaignId: CAMPAIGN_ID, generated: 3, failed: 0, failures: [] });

  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
});

describe('campaign routes — authentication', () => {
  it('401s on every campaign route without a token', async () => {
    const app = createApp();

    const responses = await Promise.all([
      request(app).post('/api/campaigns'),
      request(app).get('/api/campaigns'),
      request(app).get(`/api/campaigns/${CAMPAIGN_ID}`),
      request(app).patch(`/api/campaigns/${CAMPAIGN_ID}`)
    ]);

    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Missing or malformed Authorization header' });
    }

    // Nothing reached the data layer.
    expect(create).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

describe('POST /api/campaigns', () => {
  it('creates the campaign for the authenticated user', async () => {
    const res = await authed('post', '/api/campaigns').send({
      name: 'Series A outreach',
      mode: 'template',
      template_body: TEMPLATE,
      subject_template: 'a question about {{company}}'
    });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ campaign: CAMPAIGN });
    expect(create).toHaveBeenCalledWith(USER_ID, {
      name: 'Series A outreach',
      mode: 'template',
      templateBody: TEMPLATE,
      subjectTemplate: 'a question about {{company}}'
    });
  });

  it('ignores a user_id in the body — the owner is the token, always', async () => {
    await authed('post', '/api/campaigns').send({
      name: 'Series A outreach',
      mode: 'voice',
      user_id: 'user-someone-else'
    });

    const [ownerId, input] = create.mock.calls[0];
    expect(ownerId).toBe(USER_ID);
    expect(input).not.toHaveProperty('user_id');
  });

  it('returns the service status and message for invalid input', async () => {
    create.mockRejectedValue(httpError(400, "Mode must be either 'voice' or 'template'"));

    const res = await authed('post', '/api/campaigns').send({ name: 'x', mode: 'sequence' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Mode must be either 'voice' or 'template'" });
  });
});

describe('GET /api/campaigns', () => {
  it("lists the caller's campaigns with counts", async () => {
    const res = await authed('get', '/api/campaigns');

    expect(res.status).toBe(200);
    expect(res.body.campaigns).toHaveLength(1);
    expect(res.body.campaigns[0].sentCount).toBe(2);
    expect(res.body.campaigns[0].repliedCount).toBe(1);
    expect(list).toHaveBeenCalledWith(USER_ID);
  });
});

describe('GET /api/campaigns/:id', () => {
  it('returns the detail with its leads', async () => {
    const res = await authed('get', `/api/campaigns/${CAMPAIGN_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.campaign.id).toBe(CAMPAIGN_ID);
    expect(res.body.campaign.leads).toEqual([]);
    expect(get).toHaveBeenCalledWith(USER_ID, CAMPAIGN_ID);
  });

  it('400s on an id that is not a campaign id, without touching the service', async () => {
    const res = await authed('get', '/api/campaigns/not-a-uuid');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid campaign id' });
    expect(get).not.toHaveBeenCalled();
  });

  it("404s when the campaign is not the caller's", async () => {
    get.mockRejectedValue(httpError(404, 'Campaign not found'));

    const res = await authed('get', `/api/campaigns/${CAMPAIGN_ID}`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Campaign not found' });
  });
});

describe('POST /api/campaigns/:id/leads', () => {
  const ROWS = [{ email: 'marguerite@blackwood.example', first_name: 'Marguerite' }];

  it('forwards the rows for the authenticated user and returns the summary', async () => {
    const res = await authed('post', `/api/campaigns/${CAMPAIGN_ID}/leads`).send({ rows: ROWS });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ inserted: 1, skipped: [], rejected: [], flagged: [] });
    expect(add).toHaveBeenCalledWith(USER_ID, CAMPAIGN_ID, ROWS);
  });

  it('401s without a token, without reaching the service', async () => {
    const res = await request(createApp())
      .post(`/api/campaigns/${CAMPAIGN_ID}/leads`)
      .send({ rows: ROWS });

    expect(res.status).toBe(401);
    expect(add).not.toHaveBeenCalled();
  });

  it('400s when rows is missing or not an array, rather than 500ing', async () => {
    const bodies = [{}, { rows: null }, { rows: 'sam@corp.com' }, { rows: { email: 'a@b.com' } }];

    for (const body of bodies) {
      const res = await authed('post', `/api/campaigns/${CAMPAIGN_ID}/leads`).send(body);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'rows must be an array of recipients' });
    }

    expect(add).not.toHaveBeenCalled();
  });

  it('400s cleanly on an empty rows array', async () => {
    const res = await authed('post', `/api/campaigns/${CAMPAIGN_ID}/leads`).send({ rows: [] });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'There are no recipients to add' });
    expect(add).not.toHaveBeenCalled();
  });

  it('400s above the row cap and never reaches the service', async () => {
    const rows = Array.from({ length: MAX_LEADS_PER_REQUEST + 1 }, (_unused, index) => ({
      email: `person${index}@corp.com`
    }));

    const res = await authed('post', `/api/campaigns/${CAMPAIGN_ID}/leads`).send({ rows });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain(String(MAX_LEADS_PER_REQUEST));
    expect(add).not.toHaveBeenCalled();
  });

  it('400s on an id that is not a campaign id', async () => {
    const res = await authed('post', '/api/campaigns/not-a-uuid/leads').send({ rows: ROWS });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid campaign id' });
    expect(add).not.toHaveBeenCalled();
  });

  it("404s when the campaign is not the caller's", async () => {
    add.mockRejectedValue(httpError(404, 'Campaign not found'));

    const res = await authed('post', `/api/campaigns/${CAMPAIGN_ID}/leads`).send({ rows: ROWS });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Campaign not found' });
  });

  it('logs ids and a count only — never a row', async () => {
    await authed('post', `/api/campaigns/${CAMPAIGN_ID}/leads`).send({
      rows: [
        {
          email: 'marguerite@blackwood.example',
          first_name: 'Marguerite',
          company: 'Blackwood Holdings'
        }
      ]
    });

    const serialized = JSON.stringify([
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls
    ]);

    // A lead row is third-party personal data (CLAUDE.md § Privacy).
    expect(serialized).not.toContain('marguerite@blackwood.example');
    expect(serialized).not.toContain('Marguerite');
    expect(serialized).not.toContain('Blackwood');

    expect(logger.info).toHaveBeenCalledWith('leads_upload', {
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      count: 1
    });
  });

  it('logs no row content when the upload fails either', async () => {
    add.mockRejectedValue(httpError(404, 'Campaign not found'));

    await authed('post', `/api/campaigns/${CAMPAIGN_ID}/leads`).send({
      rows: [{ email: 'marguerite@blackwood.example' }]
    });

    const serialized = JSON.stringify(logger.error.mock.calls);

    expect(serialized).not.toContain('marguerite@blackwood.example');
  });
});

describe('POST /api/campaigns/:id/generate', () => {
  it('starts the run for the authenticated user and answers 202 with counts', async () => {
    const res = await authed('post', `/api/campaigns/${CAMPAIGN_ID}/generate`).send({});

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ campaignId: CAMPAIGN_ID, status: 'generating', pending: 3 });
    expect(begin).toHaveBeenCalledWith(USER_ID, CAMPAIGN_ID, undefined);
    expect(run).toHaveBeenCalledWith(PREPARED);
  });

  it('forwards an explicit goal and ignores a user_id in the body', async () => {
    await authed('post', `/api/campaigns/${CAMPAIGN_ID}/generate`).send({
      goal: 'book a 15 minute demo',
      user_id: 'user-someone-else'
    });

    expect(begin).toHaveBeenCalledWith(USER_ID, CAMPAIGN_ID, 'book a 15 minute demo');
  });

  it('returns no lead data and no exemplars in the response', async () => {
    const res = await authed('post', `/api/campaigns/${CAMPAIGN_ID}/generate`).send({});

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('saw the raise go through');
    expect(serialized).not.toContain('lead-1');
    expect(res.body).not.toHaveProperty('leads');
    expect(res.body).not.toHaveProperty('voice');
  });

  it('401s without a token, without reaching the service', async () => {
    const res = await request(createApp()).post(`/api/campaigns/${CAMPAIGN_ID}/generate`).send({});

    expect(res.status).toBe(401);
    expect(begin).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  /**
   * The trailing-slash variant matches the same route by Express default, so it
   * must clear the same auth gate. Pinned rather than assumed: this repo has
   * already shipped a route variant that reached a service past a green suite,
   * and `app.set('strict routing')` would change this matching silently.
   */
  it('401s on the trailing-slash variant too, without reaching the service', async () => {
    const res = await request(createApp()).post(`/api/campaigns/${CAMPAIGN_ID}/generate/`).send({});

    expect(res.status).toBe(401);
    expect(begin).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("404s when the campaign is not the caller's, and never starts a run", async () => {
    begin.mockRejectedValue(httpError(404, 'Campaign not found'));

    const res = await authed('post', `/api/campaigns/${CAMPAIGN_ID}/generate`).send({});

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Campaign not found' });
    expect(run).not.toHaveBeenCalled();
  });

  it('400s on an id that is not a campaign id', async () => {
    const res = await authed('post', '/api/campaigns/not-a-uuid/generate').send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid campaign id' });
    expect(begin).not.toHaveBeenCalled();
  });

  it('surfaces the service status when there is nothing to generate', async () => {
    begin.mockRejectedValue(httpError(400, 'There are no recipients waiting for a draft'));

    const res = await authed('post', `/api/campaigns/${CAMPAIGN_ID}/generate`).send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'There are no recipients waiting for a draft' });
  });

  it('still answers 202 when the background run rejects, and logs no content', async () => {
    run.mockRejectedValue(new Error('anthropic said hey Sam, saw the raise go through'));

    const res = await authed('post', `/api/campaigns/${CAMPAIGN_ID}/generate`).send({});
    // Let the deliberately un-awaited run settle before reading the log.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(res.status).toBe(202);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('saw the raise go through');
  });

  it('logs ids and counts only', async () => {
    await authed('post', `/api/campaigns/${CAMPAIGN_ID}/generate`).send({
      goal: 'reach Marguerite at Blackwood Holdings'
    });

    const serialized = JSON.stringify([
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls
    ]);

    expect(serialized).not.toContain('Marguerite');
    expect(serialized).not.toContain('Blackwood');
    expect(serialized).not.toContain('saw the raise go through');
  });
});

describe('PATCH /api/campaigns/:id', () => {
  it('forwards only the editable fields', async () => {
    const res = await authed('patch', `/api/campaigns/${CAMPAIGN_ID}`).send({
      name: 'Renamed run',
      subject_template: 'new subject',
      status: 'sending',
      user_id: 'user-someone-else',
      mode: 'voice'
    });

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(USER_ID, CAMPAIGN_ID, {
      name: 'Renamed run',
      subjectTemplate: 'new subject'
    });
  });

  it('400s on a malformed campaign id', async () => {
    const res = await authed('patch', '/api/campaigns/12345').send({ name: 'nope' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid campaign id' });
    expect(update).not.toHaveBeenCalled();
  });
});
