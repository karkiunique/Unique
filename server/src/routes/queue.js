import { Router } from 'express';

import { requireAuth } from '../middleware/auth.js';
import { getReviewQueue, rejectLead } from '../services/reviewQueue.js';
import { safeMessage } from '../lib/httpError.js';
import { logger } from '../lib/logger.js';

const router = Router();

/**
 * The daily review queue (CLAUDE.md, Decisions 2026-08-16).
 *
 * OWNER SCOPING: `req.user.id` from the verified JWT, never the body or the path.
 * The lead id in the path is attacker-controlled, so `rejectLead` re-filters on
 * the owner before it writes and answers 404 — not 403 — for someone else's lead,
 * because a 403 confirms the id exists.
 */

const REJECT_REASONS = new Set([
  'wrong_role',
  'wrong_company',
  'bad_timing',
  'weak_hook',
  'other'
]);

const MAX_NOTE_LENGTH = 500;

/** GET /api/queue — letters waiting for review, no bodies. */
router.get('/queue', requireAuth, async (req, res) => {
  try {
    const { campaignId, leads } = await getReviewQueue(req.user.id);

    return res.status(200).json({ campaignId, leads });
  } catch (err) {
    const status = Number(err?.status) || 500;
    if (status >= 500) logger.error('queue_read_failed', { userId: req.user.id, status });

    return res.status(status).json({ error: safeMessage(err, 'Could not read your queue') });
  }
});

/**
 * POST /api/leads/:id/reject — the user declines this letter.
 *
 * The reason is a CLOSED SET: free text cannot be aggregated into a targeting
 * signal, and this exists to improve targeting. The optional note is the user's
 * own words and is stored but never logged.
 */
router.post('/leads/:id/reject', requireAuth, async (req, res) => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';

  if (!REJECT_REASONS.has(reason)) {
    return res.status(400).json({ error: 'A valid reason is required' });
  }

  const rawNote = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
  const note = rawNote === '' ? null : rawNote.slice(0, MAX_NOTE_LENGTH);

  try {
    const result = await rejectLead(req.user.id, req.params.id, reason, note);

    return res.status(200).json(result);
  } catch (err) {
    const status = Number(err?.status) || 500;
    if (status >= 500) logger.error('lead_reject_failed', { userId: req.user.id, status });

    return res.status(status).json({ error: safeMessage(err, 'Could not record the rejection') });
  }
});

export default router;
