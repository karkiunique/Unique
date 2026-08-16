import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import { joinWaitlist, getWaitlistCount } from '../services/waitlist.js';
import { safeMessage } from '../lib/httpError.js';
import { logger } from '../lib/logger.js';

const router = Router();

/**
 * Public and unauthenticated, so stricter than the global limiter — and stricter
 * on the write than the read. The count is fetched once per landing-page view and
 * is cheap; the signup writes a row, and an unauthenticated write is the thing
 * worth rationing.
 */
const joinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down' }
});

const countLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down' }
});

/**
 * POST /api/waitlist — PUBLIC, no auth (CLAUDE.md).
 *
 * Body {email} -> {seat, count}. The address is PII and never leaves this
 * function: not to a log line, not into an error message, not back in the
 * response. The visitor already has it; the response only has to say which seat
 * they hold.
 *
 * A repeat address answers 200 with the seat it already holds, deliberately — see
 * Decisions, 2026-08-15.
 */
router.post('/waitlist', joinLimiter, async (req, res) => {
  try {
    const { seat, count } = await joinWaitlist(req.body?.email);

    // Counts only. `seat` is not on the logger allowlist and does not need to be:
    // it is the same number as count, and one of them is enough to see traffic.
    logger.info('waitlist_joined', { count });

    return res.status(201).json({ seat, count });
  } catch (err) {
    const status = Number(err?.status) || 500;
    if (status >= 500) logger.error('waitlist_join_failed', { status });

    return res.status(status).json({ error: safeMessage(err, 'Could not join the waitlist') });
  }
});

/**
 * GET /api/waitlist/count — PUBLIC, no auth. {count} for the live counter.
 *
 * Never returns an address and never returns how many rows exist as anything but
 * that one number, so it cannot be used to watch the list grow per-signup beyond
 * what the page already shows every visitor.
 */
router.get('/waitlist/count', countLimiter, async (req, res) => {
  try {
    return res.status(200).json({ count: await getWaitlistCount() });
  } catch (err) {
    logger.error('waitlist_count_failed', { status: Number(err?.status) || 500 });

    return res.status(500).json({ error: 'Could not read the waitlist' });
  }
});

export default router;
