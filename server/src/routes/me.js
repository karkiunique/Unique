import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getSenderName, setSenderName } from '../services/senderName.js';
import { safeMessage } from '../lib/httpError.js';
import { logger } from '../lib/logger.js';

const router = Router();

/**
 * The signed-in user, and their sign-off name.
 *
 * OWNER SCOPING: the owner is `req.user.id`, taken from the verified JWT and
 * nowhere else. A `user_id` in the body is ignored, never read.
 *
 * PRIVACY: `full_name` is PII, treated exactly like an email address — it is
 * returned only to its owner and never reaches a log line. Failures here log the
 * status and the error NAME, never a message that could quote the value sent.
 */

/**
 * GET /api/me — who is signed in, and whether they have given a sign-off name.
 * `full_name` is null for a pre-006 account, which is what the backfill prompt
 * in the web app keys off.
 */
router.get('/me', requireAuth, async (req, res) => {
  // getSenderName never throws: an unreadable name must not cost the caller the
  // rest of this response.
  const fullName = await getSenderName(req.user.id);

  res.status(200).json({
    user: {
      id: req.user.id,
      email: req.user.email,
      full_name: fullName
    }
  });
});

/**
 * PATCH /api/me — set the sign-off name. This is the backfill path for accounts
 * created before migration 006; new signups arrive with the name already on the
 * row, put there by the auth trigger from the signup metadata.
 */
router.patch('/me', requireAuth, async (req, res) => {
  const payload = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body
    : {};

  try {
    const fullName = await setSenderName(req.user.id, payload.full_name);

    return res.status(200).json({ user: { id: req.user.id, full_name: fullName } });
  } catch (err) {
    const status = Number(err?.status) || 500;
    logger.error('sender_name_update_failed', { userId: req.user.id, status, name: err?.name });

    return res.status(status).json({ error: safeMessage(err, 'Could not save your name') });
  }
});

export default router;
