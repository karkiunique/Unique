import { Router } from 'express';

import { requireAuth } from '../middleware/auth.js';
import { generateVoiceProfileForUser, getVoiceProfile } from '../services/voice.js';
import { summarizeCorpus } from '../services/corpusSummary.js';
import { safeMessage } from '../lib/httpError.js';
import { logger } from '../lib/logger.js';

const router = Router();

/** Only messages we wrote are echoed back — SDK errors carry a status too. */
function fail(res, event, userId, err, fallbackMessage) {
  const status = Number(err?.status) || 500;
  logger.error(event, { userId, status, name: err?.name });
  return res.status(status).json({ error: safeMessage(err, fallbackMessage) });
}

/**
 * POST /api/voice/generate — ingest sent mail, build the profile, save it.
 * Sent-email bodies stay in memory for the life of this request only.
 */
router.post('/voice/generate', requireAuth, async (req, res) => {
  try {
    const profile = await generateVoiceProfileForUser(req.user.id);
    return res.status(200).json({ profile });
  } catch (err) {
    return fail(res, 'voice_generate_failed', req.user.id, err, 'Could not build the voice profile');
  }
});

/**
 * GET /api/voice/corpus-summary — how much sent mail a profile would be built from.
 *
 * COUNTS ONLY. No bodies, no excerpts, no subjects, no recipients, at any level.
 * The corpus itself is only ever inspectable through the dev-gated ingest-preview
 * route; this is what production is allowed to see.
 */
router.get('/voice/corpus-summary', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');

  try {
    const summary = await summarizeCorpus(req.user.id);

    // Counts only — nothing derived from message content.
    logger.info('voice_corpus_summarized', { userId: req.user.id, count: summary.messageCount });

    return res.status(200).json(summary);
  } catch (err) {
    return fail(res, 'voice_corpus_summary_failed', req.user.id, err, 'Could not read your sent mail');
  }
});

/** GET /api/voice — the user's current voice profile. Exemplars are never returned. */
router.get('/voice', requireAuth, async (req, res) => {
  try {
    const profile = await getVoiceProfile(req.user.id);
    if (!profile) return res.status(404).json({ error: 'No voice profile yet' });
    return res.status(200).json({ profile });
  } catch (err) {
    return fail(res, 'voice_fetch_failed', req.user.id, err, 'Could not load the voice profile');
  }
});

export default router;
