import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

/**
 * The /api/leads routes: mounted, authenticated, and strict about what they
 * forward to the service. The service is mocked here — its behaviour is covered
 * in leadReview.test.js — so these assertions are about the wiring: who the
 * owner is, which body keys survive, and which status codes come back.
 *
 * The approval route is treated like the send route, because it is the same kind
 * of gate. That includes the trailing-slash variant: this repo has already
 * shipped a route variant that reached a service past a fully green suite.
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

const { getUser, read, update, regenerate } = vi.hoisted(() => ({
  getUser: vi.fn(),
  read: vi.fn(),
  update: vi.fn(),
  regenerate: vi.fn()
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

vi.mock('../src/services/leadReview.js', () => ({
  getLead: read,
  updateLead: update
}));

vi.mock('../src/services/leadRegenerate.js', () => ({ regenerateLead: regenerate }));

const { createApp } = await import('../src/app.js');
const { logger } = await import('../src/lib/logger.js');

const USER_ID = 'user-abc';
const TOKEN = 'Bearer good.jwt';
const LEAD_ID = '11111111-2222-4333-8444-555555555555';
const SUBJECT = 'a question about Blackwood';
const BODY = 'hey Marguerite\n\nsaw the raise go through. worth 15 minutes?\n\nthanks,\nAna';

const LEAD = {
  id: LEAD_ID,
  campaign_id: '99999999-8888-4777-8666-555555555555',
  user_id: USER_ID,
  email: 'marguerite@blackwood.example',
  first_name: 'Marguerite',
  last_name: 'Okonjo',
  company: 'Blackwood Holdings',
  title: 'Head of Ops',
  status: 'generated',
  fidelity_score: 72,
  generated_subject: SUBJECT,
  generated_body: BODY,
  edited_body: null,
  sent_at: null,
  created_at: '2026-08-06T00:00:00.000Z'
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

  read.mockReset();
  update.mockReset();
  regenerate.mockReset();

  read.mockResolvedValue(LEAD);
  update.mockResolvedValue({ ...LEAD, status: 'approved' });
  regenerate.mockResolvedValue({ ...LEAD, fidelity_score: 91 });

  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
});

describe('lead routes — authentication', () => {
  it('401s on every lead route without a token, and reaches no service', async () => {
    const app = createApp();

    const responses = await Promise.all([
      request(app).get(`/api/leads/${LEAD_ID}`),
      request(app).patch(`/api/leads/${LEAD_ID}`).send({ approve: true }),
      request(app).post(`/api/leads/${LEAD_ID}/regenerate`).send({})
    ]);

    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Missing or malformed Authorization header' });
    }

    expect(read).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(regenerate).not.toHaveBeenCalled();
  });

  /**
   * The trailing-slash variant matches the same route by Express default, so it
   * must clear the same auth gate — and must not be a second, ungated way to
   * approve a letter.
   */
  it('401s on the trailing-slash variant of the approval route too', async () => {
    const res = await request(createApp())
      .patch(`/api/leads/${LEAD_ID}/`)
      .send({ approve: true });

    expect(res.status).toBe(401);
    expect(update).not.toHaveBeenCalled();
  });

  it('approves for the authenticated user on the trailing-slash variant as well', async () => {
    const res = await authed('patch', `/api/leads/${LEAD_ID}/`).send({ approve: true });

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(USER_ID, LEAD_ID, { approve: true });
  });
});

describe('GET /api/leads/:id', () => {
  it('returns the letter for the authenticated user', async () => {
    const res = await authed('get', `/api/leads/${LEAD_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.lead.id).toBe(LEAD_ID);
    expect(read).toHaveBeenCalledWith(USER_ID, LEAD_ID);
  });

  it('400s on an id that is not a lead id, without touching the service', async () => {
    const res = await authed('get', '/api/leads/not-a-uuid');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid recipient id' });
    expect(read).not.toHaveBeenCalled();
  });

  it("404s when the lead is not the caller's", async () => {
    read.mockRejectedValue(httpError(404, 'Recipient not found'));

    const res = await authed('get', `/api/leads/${LEAD_ID}`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Recipient not found' });
  });
});

describe('PATCH /api/leads/:id', () => {
  it('forwards only the editable fields and the approval flag', async () => {
    const res = await authed('patch', `/api/leads/${LEAD_ID}`).send({
      subject: 'a shorter subject',
      body: BODY,
      approve: true,
      status: 'sent',
      user_id: 'user-someone-else',
      campaign_id: 'camp-someone-elses',
      fidelity_score: 100,
      sent_at: '2026-08-07T00:00:00.000Z'
    });

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(USER_ID, LEAD_ID, {
      subject: 'a shorter subject',
      body: BODY,
      approve: true
    });
  });

  it('is the owner from the token, never a user_id in the body', async () => {
    await authed('patch', `/api/leads/${LEAD_ID}`).send({
      approve: true,
      user_id: 'user-someone-else'
    });

    const [ownerId, , patch] = update.mock.calls[0];
    expect(ownerId).toBe(USER_ID);
    expect(patch).not.toHaveProperty('user_id');
    expect(patch).not.toHaveProperty('status');
  });

  it("404s when the lead is not the caller's, without approving anything", async () => {
    update.mockRejectedValue(httpError(404, 'Recipient not found'));

    const res = await authed('patch', `/api/leads/${LEAD_ID}`).send({ approve: true });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Recipient not found' });
  });

  it('surfaces the service status for an illegal transition', async () => {
    update.mockRejectedValue(httpError(400, 'A sent recipient cannot be approved'));

    const res = await authed('patch', `/api/leads/${LEAD_ID}`).send({ approve: true });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'A sent recipient cannot be approved' });
  });

  it('400s on an id that is not a lead id', async () => {
    const res = await authed('patch', '/api/leads/12345').send({ approve: true });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid recipient id' });
    expect(update).not.toHaveBeenCalled();
  });
});

describe('POST /api/leads/:id/regenerate', () => {
  it('redrafts this one lead for the authenticated user', async () => {
    const res = await authed('post', `/api/leads/${LEAD_ID}/regenerate`).send({ goal: 'book time' });

    expect(res.status).toBe(200);
    expect(res.body.lead.fidelity_score).toBe(91);
    expect(regenerate).toHaveBeenCalledWith(USER_ID, LEAD_ID, 'book time');
  });

  it("404s when the lead is not the caller's", async () => {
    regenerate.mockRejectedValue(httpError(404, 'Recipient not found'));

    const res = await authed('post', `/api/leads/${LEAD_ID}/regenerate`).send({});

    expect(res.status).toBe(404);
  });

  it('does not echo a model error back to the caller', async () => {
    regenerate.mockRejectedValue(new Error(`anthropic said ${BODY}`));

    const res = await authed('post', `/api/leads/${LEAD_ID}/regenerate`).send({});

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Could not redraft the letter' });
  });
});

describe('lead route logging', () => {
  it('logs ids and statuses only — never a letter or a recipient', async () => {
    await authed('patch', `/api/leads/${LEAD_ID}`).send({ subject: SUBJECT, body: BODY });

    update.mockRejectedValue(httpError(400, 'A sent recipient can no longer be edited'));
    await authed('patch', `/api/leads/${LEAD_ID}`).send({ body: BODY });

    const serialized = JSON.stringify([
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls
    ]);

    expect(serialized).not.toContain('saw the raise go through');
    expect(serialized).not.toContain('Marguerite');
    expect(serialized).not.toContain('Blackwood');
    expect(serialized).not.toContain('marguerite@blackwood.example');
  });
});
