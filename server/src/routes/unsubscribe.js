import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import { getSupabaseAdmin } from '../lib/supabase.js';
import { verifyToken } from '../lib/unsubscribe.js';
import { logger } from '../lib/logger.js';

const router = Router();

const INVALID_LINK = 'Invalid or expired unsubscribe link';

/** Public and unauthenticated, so it gets a stricter limit than the global one. */
const unsubscribeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down' }
});

/**
 * POST /api/unsubscribe/:token — PUBLIC, no auth (CLAUDE.md).
 *
 * Trust comes entirely from the HMAC: the token carries the user id and the
 * recipient address, so a valid signature is enough to write the row without a
 * lookup, and an attacker cannot enumerate recipients by guessing.
 */
router.post('/unsubscribe/:token', unsubscribeLimiter, async (req, res) => {
  let payload;
  try {
    payload = verifyToken(req.params?.token);
  } catch {
    // Never say why it failed: the reason is a free oracle for token probing.
    return res.status(400).json({ error: INVALID_LINK });
  }

  const userId = typeof payload.u === 'string' ? payload.u.trim() : '';
  const email = typeof payload.e === 'string' ? payload.e.trim().toLowerCase() : '';

  if (userId === '' || email === '') {
    return res.status(400).json({ error: INVALID_LINK });
  }

  try {
    // on conflict do nothing: unsubscribing twice is a success, not an error.
    const { error } = await getSupabaseAdmin()
      .from('unsubscribes')
      .upsert({ user_id: userId, email }, { onConflict: 'user_id,email', ignoreDuplicates: true });

    if (error) throw new Error('insert failed');
  } catch {
    logger.error('unsubscribe_failed', { userId, status: 500 });
    return res.status(500).json({ error: 'Could not record the unsubscribe' });
  }

  // The address is the third party's own — it never reaches a log line.
  logger.info('unsubscribed', { userId });

  return res.status(200).json({ unsubscribed: true });
});

export default router;
