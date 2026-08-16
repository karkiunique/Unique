import { Router } from 'express';

import { requireAuth } from '../middleware/auth.js';
import { getTarget, putTarget } from '../services/leadTargets.js';
import { safeMessage } from '../lib/httpError.js';
import { logger } from '../lib/logger.js';

const router = Router();

/**
 * The user's standing ICP (CLAUDE.md, Decisions 2026-08-16).
 *
 * OWNER SCOPING: the owner is `req.user.id` from the verified JWT and nowhere
 * else. A `user_id` in the body is attacker-controlled and is never read.
 *
 * PRIVACY: `fit_notes` is the user's own description of their business — the same
 * class as `campaigns.brief`. It goes back to its owner and nowhere else, and it
 * never reaches a log line or an error message.
 */

/** GET /api/target — the standing ICP, or null if they have not set one yet. */
router.get('/target', requireAuth, async (req, res) => {
  try {
    return res.status(200).json({ target: await getTarget(req.user.id) });
  } catch (err) {
    logger.error('target_read_failed', { userId: req.user.id, status: 500 });
    return res.status(500).json({ error: safeMessage(err, 'Could not read your target') });
  }
});

/**
 * PUT /api/target — create or replace it. One per user, so a second call is an
 * edit rather than a second target.
 */
router.put('/target', requireAuth, async (req, res) => {
  try {
    const target = await putTarget(req.user.id, req.body);

    return res.status(200).json({ target });
  } catch (err) {
    const status = Number(err?.status) || 500;
    if (status >= 500) logger.error('target_save_failed', { userId: req.user.id, status });

    return res.status(status).json({ error: safeMessage(err, 'Could not save your target') });
  }
});

export default router;
