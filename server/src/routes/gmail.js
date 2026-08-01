import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import { requireAuth } from '../middleware/auth.js';
import { buildAuthUrl, handleCallback } from '../services/gmail.js';
import { generateVoiceProfileForUser } from '../services/voice.js';
import { safeMessage } from '../lib/httpError.js';
import { logger } from '../lib/logger.js';

const router = Router();

const DEFAULT_APP_URL = 'http://localhost:5173';

/** OAuth endpoints get a stricter limit than the global one (CLAUDE.md, Security). */
const oauthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down' }
});

/** POST /api/gmail/connect — returns the Google consent URL for this user. */
router.post('/gmail/connect', oauthLimiter, requireAuth, (req, res) => {
  try {
    return res.status(200).json({ url: buildAuthUrl(req.user.id) });
  } catch (err) {
    logger.error('gmail_connect_failed', { userId: req.user.id, status: 500, name: err?.name });
    return res.status(500).json({ error: 'Could not start the Gmail connection' });
  }
});

/**
 * GET /api/gmail/callback — Google redirects here, so there is no JWT.
 * Trust comes from the signed, encrypted `state` param instead.
 */
router.get('/gmail/callback', oauthLimiter, async (req, res) => {
  if (req.query?.error) {
    return res.status(400).json({ error: 'Google denied the authorization request' });
  }

  const code = typeof req.query?.code === 'string' ? req.query.code : '';
  const state = typeof req.query?.state === 'string' ? req.query.state : '';
  if (!code || !state) {
    return res.status(400).json({ error: 'Missing authorization code or state' });
  }

  let userId;
  try {
    ({ userId } = await handleCallback(code, state));
  } catch (err) {
    const status = Number(err?.status) || 500;
    // The code itself is never logged, and only our own messages are echoed back.
    logger.error('gmail_callback_failed', { status, name: err?.name });
    return res
      .status(status)
      .json({ error: safeMessage(err, 'Could not complete the Gmail connection') });
  }

  // Ingestion + profile build run in the background: the browser redirect must not wait.
  generateVoiceProfileForUser(userId).catch((err) => {
    logger.error('voice_profile_build_failed', { userId, status: 500, name: err?.name });
  });

  const appUrl = process.env.APP_URL || DEFAULT_APP_URL;
  return res.redirect(`${appUrl}/onboarding?connected=1`);
});

export default router;
