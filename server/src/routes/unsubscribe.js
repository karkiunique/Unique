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
 * Whether this address is already on the list.
 *
 * The public page reads differently for "removed just now" and "removed
 * earlier", and the second must not be dressed up as an error, so the two are
 * distinguished before the write rather than inferred from it.
 */
async function alreadyOnList(userId, email) {
  const { data, error } = await getSupabaseAdmin()
    .from('unsubscribes')
    .select('id')
    .eq('user_id', userId)
    .eq('email', email)
    .maybeSingle();

  if (error) throw new Error('lookup failed');

  return Boolean(data);
}

/**
 * POST /api/unsubscribe/:token — PUBLIC, no auth (CLAUDE.md).
 *
 * Trust comes entirely from the HMAC: the token carries the user id and the
 * recipient address, so a valid signature is enough to record the row, and an
 * attacker cannot enumerate recipients by guessing.
 *
 * Answers with one of three outcomes — 'unsubscribed', 'already', or a 400 —
 * because the public page has to render each of them differently.
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
    if (await alreadyOnList(userId, email)) {
      // The address is the third party's own — it never reaches a log line.
      logger.info('unsubscribe_repeat', { userId });
      return res.status(200).json({ status: 'already' });
    }

    // on conflict do nothing: a second click, or a race with one, is still a success.
    const { error } = await getSupabaseAdmin()
      .from('unsubscribes')
      .upsert({ user_id: userId, email }, { onConflict: 'user_id,email', ignoreDuplicates: true });

    if (error) throw new Error('insert failed');
  } catch {
    logger.error('unsubscribe_failed', { userId, status: 500 });
    return res.status(500).json({ error: 'Could not record the unsubscribe' });
  }

  logger.info('unsubscribed', { userId });

  return res.status(200).json({ status: 'unsubscribed' });
});

export default router;
