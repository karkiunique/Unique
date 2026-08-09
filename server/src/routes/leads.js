import { Router } from 'express';

import { requireAuth } from '../middleware/auth.js';
import { getLead, updateLead } from '../services/leadReview.js';
import { regenerateLead } from '../services/leadRegenerate.js';
import { safeMessage } from '../lib/httpError.js';
import { logger } from '../lib/logger.js';

/**
 * The review screen's routes — read one letter, edit it, approve it, redraft it.
 *
 * PATCH /api/leads/:id is the batch approval gate (CLAUDE.md's contract: "edit
 * body/subject, approve, etc."). Approval is per-lead and explicit: there is no
 * route here that approves anything the caller did not name by id, and the
 * legality of the transition itself is checked in the service, not the browser.
 *
 * The patch is assembled key by key rather than forwarded, exactly as
 * campaigns.js does: `status`, `user_id`, `campaign_id` and `fidelity_score` are
 * dropped structurally, so no future change to the service can accidentally make
 * them settable from a request body.
 *
 * NOTHING FROM A LETTER OR A LEAD IS LOGGED. A generated body, an edited body,
 * a recipient's name, employer or address are all covered by CLAUDE.md § Privacy
 * exactly like a raw email body. Ids and counts only, failure path included.
 */

const router = Router();

// The shape `leads.id` always has. Rejecting anything else here keeps a
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

function leadIdOf(req) {
  const id = typeof req.params?.id === 'string' ? req.params.id.trim() : '';

  return UUID.test(id) ? id : null;
}

/** GET /api/leads/:id — one lead with its letter. 404 unless it is this user's. */
router.get('/leads/:id', requireAuth, async (req, res) => {
  const leadId = leadIdOf(req);
  if (!leadId) return res.status(400).json({ error: 'Invalid recipient id' });

  try {
    const lead = await getLead(req.user.id, leadId);

    return res.status(200).json({ lead });
  } catch (err) {
    return fail(res, 'lead_read_failed', req.user.id, err, 'Could not load the recipient');
  }
});

/**
 * PATCH /api/leads/:id — edit the subject or body, and/or approve this one lead.
 *
 * `approve: true` is the ONLY way a lead reaches `approved`, and it is refused
 * unless the lead already has a draft a human could have read. Once Phase 4
 * sends without a person in the loop, this is the last human checkpoint.
 */
router.patch('/leads/:id', requireAuth, async (req, res) => {
  const leadId = leadIdOf(req);
  if (!leadId) return res.status(400).json({ error: 'Invalid recipient id' });

  const payload = bodyOf(req);
  const patch = {};

  if ('subject' in payload) patch.subject = payload.subject;
  if ('body' in payload) patch.body = payload.body;
  if ('approve' in payload) patch.approve = payload.approve;

  try {
    const lead = await updateLead(req.user.id, leadId, patch);

    return res.status(200).json({ lead });
  } catch (err) {
    return fail(res, 'lead_update_failed', req.user.id, err, 'Could not update the recipient');
  }
});

/**
 * POST /api/leads/:id/regenerate — redraft this one lead, leaving the rest of
 * the campaign untouched. Synchronous: it is a single letter, and the reviewer
 * is waiting on this exact one.
 */
router.post('/leads/:id/regenerate', requireAuth, async (req, res) => {
  const leadId = leadIdOf(req);
  if (!leadId) return res.status(400).json({ error: 'Invalid recipient id' });

  const { goal } = bodyOf(req);

  try {
    const lead = await regenerateLead(req.user.id, leadId, goal);

    return res.status(200).json({ lead });
  } catch (err) {
    return fail(res, 'lead_regenerate_failed', req.user.id, err, 'Could not redraft the letter');
  }
});

export default router;
