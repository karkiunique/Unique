import { Router } from 'express';

import { requireAuth } from '../middleware/auth.js';
import {
  createCampaign,
  listCampaigns,
  getCampaign,
  updateCampaign
} from '../services/campaigns.js';
import { addLeads, MAX_LEADS_PER_REQUEST } from '../services/leads.js';
import {
  beginCampaignGeneration,
  runCampaignGeneration
} from '../services/generateBatch.js';
import { safeMessage } from '../lib/httpError.js';
import { logger } from '../lib/logger.js';

const router = Router();

// The shape `campaigns.id` always has. Rejecting anything else here keeps a
// malformed id from reaching the driver and coming back as a 500.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Only messages we wrote are echoed back — SDK errors carry a status too. */
function fail(res, event, userId, err, fallbackMessage) {
  const status = Number(err?.status) || 500;
  logger.error(event, { userId, status, name: err?.name });

  return res.status(status).json({ error: safeMessage(err, fallbackMessage) });
}

function bodyOf(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

function campaignIdOf(req) {
  const id = typeof req.params?.id === 'string' ? req.params.id.trim() : '';

  return UUID.test(id) ? id : null;
}

/**
 * POST /api/campaigns — create one. Body is {name, mode, template_body?,
 * subject_template?}, exactly the contract in CLAUDE.md.
 *
 * The owner is req.user.id and nothing else: a user_id in the body is ignored,
 * never read.
 */
router.post('/campaigns', requireAuth, async (req, res) => {
  const payload = bodyOf(req);

  try {
    const campaign = await createCampaign(req.user.id, {
      name: payload.name,
      mode: payload.mode,
      templateBody: payload.template_body,
      subjectTemplate: payload.subject_template
    });

    return res.status(201).json({ campaign });
  } catch (err) {
    return fail(res, 'campaign_create_failed', req.user.id, err, 'Could not create the campaign');
  }
});

/** GET /api/campaigns — this user's campaigns with sent/replied counts. */
router.get('/campaigns', requireAuth, async (req, res) => {
  try {
    const campaigns = await listCampaigns(req.user.id);

    return res.status(200).json({ campaigns });
  } catch (err) {
    return fail(res, 'campaigns_list_failed', req.user.id, err, 'Could not load your campaigns');
  }
});

/** GET /api/campaigns/:id — detail plus leads. 404 unless it is this user's. */
router.get('/campaigns/:id', requireAuth, async (req, res) => {
  const campaignId = campaignIdOf(req);
  if (!campaignId) return res.status(400).json({ error: 'Invalid campaign id' });

  try {
    const campaign = await getCampaign(req.user.id, campaignId);

    return res.status(200).json({ campaign });
  } catch (err) {
    return fail(res, 'campaign_read_failed', req.user.id, err, 'Could not load the campaign');
  }
});

/**
 * POST /api/campaigns/:id/leads — bulk add recipients. The CSV is parsed in the
 * browser; the body is `{rows: [...]}`, exactly the contract in CLAUDE.md.
 *
 * The envelope is checked here so a malformed upload is a 400 rather than a 500,
 * and so the row cap is refused before any of it is read. The cap is deliberate:
 * app.js holds a 1MB JSON limit as a security control, and a long file is sent
 * in batches instead of raising it.
 *
 * NOTHING FROM A ROW IS LOGGED. A lead row is third-party personal data — an
 * address, a name, an employer — and falls under CLAUDE.md § Privacy exactly
 * like an email body. Ids and counts only, here and in the failure path.
 */
router.post('/campaigns/:id/leads', requireAuth, async (req, res) => {
  const campaignId = campaignIdOf(req);
  if (!campaignId) return res.status(400).json({ error: 'Invalid campaign id' });

  const { rows } = bodyOf(req);

  if (!Array.isArray(rows)) {
    return res.status(400).json({ error: 'rows must be an array of recipients' });
  }
  if (rows.length === 0) {
    return res.status(400).json({ error: 'There are no recipients to add' });
  }
  if (rows.length > MAX_LEADS_PER_REQUEST) {
    return res.status(400).json({
      error: `An upload may carry at most ${MAX_LEADS_PER_REQUEST} recipients — send the file in batches`
    });
  }

  logger.info('leads_upload', { userId: req.user.id, campaignId, count: rows.length });

  try {
    const result = await addLeads(req.user.id, campaignId, rows);

    return res.status(201).json(result);
  } catch (err) {
    return fail(res, 'campaign_leads_failed', req.user.id, err, 'Could not add the recipients');
  }
});

/**
 * POST /api/campaigns/:id/generate — draft an email for every pending recipient.
 *
 * ASYNC BY CONTRACT (CLAUDE.md). Ownership, the campaign's shape and the voice
 * profile are all resolved before the response, so anything the caller can fix
 * comes back as a 4xx; then the run continues in the background and the browser
 * polls GET /api/campaigns/:id, where each lead flips to `generated` or `failed`
 * as it lands.
 *
 * `prepared` is opaque to this route — it carries the user's decrypted voice
 * exemplars, so it is handed straight back to the service and never serialized.
 * The response body is ids and counts.
 *
 * NOTHING FROM A LEAD OR A DRAFT IS LOGGED, here or in the failure path.
 */
router.post('/campaigns/:id/generate', requireAuth, async (req, res) => {
  const campaignId = campaignIdOf(req);
  if (!campaignId) return res.status(400).json({ error: 'Invalid campaign id' });

  const { goal } = bodyOf(req);

  try {
    const prepared = await beginCampaignGeneration(req.user.id, campaignId, goal);

    // Deliberately not awaited: the response goes out first. Per-lead failures
    // are already contained inside the run, so a rejection here is a run-level
    // fault with no client left to receive it — log the status, never the error.
    runCampaignGeneration(prepared).catch((err) => {
      logger.error('campaign_generate_failed', {
        userId: req.user.id,
        campaignId,
        status: Number(err?.status) || 500,
        name: err?.name
      });
    });

    return res.status(202).json({
      campaignId,
      status: 'generating',
      pending: prepared.pending
    });
  } catch (err) {
    return fail(res, 'campaign_generate_failed', req.user.id, err, 'Could not start generating');
  }
});

/**
 * PATCH /api/campaigns/:id — edit the name, template body or subject.
 *
 * The patch is assembled key by key rather than forwarded: `status`, `user_id`,
 * `mode` and `id` are dropped structurally, so no future change to the service
 * can accidentally make them settable from a request body.
 */
router.patch('/campaigns/:id', requireAuth, async (req, res) => {
  const campaignId = campaignIdOf(req);
  if (!campaignId) return res.status(400).json({ error: 'Invalid campaign id' });

  const payload = bodyOf(req);
  const patch = {};

  if ('name' in payload) patch.name = payload.name;
  if ('template_body' in payload) patch.templateBody = payload.template_body;
  if ('subject_template' in payload) patch.subjectTemplate = payload.subject_template;

  try {
    const campaign = await updateCampaign(req.user.id, campaignId, patch);

    return res.status(200).json({ campaign });
  } catch (err) {
    return fail(res, 'campaign_update_failed', req.user.id, err, 'Could not update the campaign');
  }
});

export default router;
