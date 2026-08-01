/**
 * DEV-ONLY ingestion preview.
 *
 * This route is a deliberate, documented exception to CLAUDE.md's rule that raw
 * email bodies never leave process memory: it returns sent-mail text in an HTTP
 * response. It exists so a developer can eyeball the ingestion corpus and prove
 * that quoted reply chains, signatures and HTML junk were stripped BEFORE a voice
 * profile is built — junk in the corpus means the profile learns other people's
 * writing, which is the single worst bug this product can have.
 *
 * The exception is bounded:
 *  - it returns the authenticated user's OWN sent mail, to that same user;
 *  - it is double-gated by lib/devOnly.js and MUST NEVER be enabled in production;
 *  - nothing is written to the DB, to disk or to logs — counts only in logs, and
 *    the corpus lives in memory for the life of the request and nowhere else;
 *  - responses are Cache-Control: no-store, and no third party is called.
 */

import { Router } from 'express';

import { requireAuth } from '../middleware/auth.js';
import { fetchSentMessages, MAX_SENT_EMAILS } from '../services/gmail.js';
import { inspectCleaning } from '../services/gmailParse.js';
import { MAX_PROFILE_INPUT_CHARS } from '../services/voice.js';
import { devRoutesEnabled } from '../lib/devOnly.js';
import { safeMessage } from '../lib/httpError.js';
import { logger } from '../lib/logger.js';

const router = Router();

// Tag markup only. Written so a plain-text '<sam@acme.com>' is not a false positive.
const HTML_TAG = /<\/?[a-z][a-z0-9]*(\s[^<>]*)?\/?>/i;

/** A stage counts as having removed something only if it actually shortened the text. */
function describeEmail(rawText, index, includeRaw) {
  const stages = inspectCleaning(rawText);

  const rawChars = stages.raw.length;
  const cleanedChars = stages.cleaned.length;
  // Trimmed comparisons: losing trailing blank lines is not a "removal".
  const beforeQuoted = stages.raw.trim().length;
  const afterQuoted = stages.afterQuotedReplies.trim().length;
  const afterSignature = stages.afterSignature.trim().length;

  const email = {
    index,
    cleanedChars,
    rawChars,
    strippedChars: Math.max(rawChars - cleanedChars, 0),
    removed: {
      quotedReply: afterQuoted < beforeQuoted,
      signature: afterSignature < afterQuoted,
      html: HTML_TAG.test(stages.raw)
    },
    cleaned: stages.cleaned
  };

  // Opt-in only: the cleaned text plus the flags is enough for most eyeballing,
  // and this keeps the noisiest part of the payload off by default.
  if (includeRaw) email.raw = stages.raw;

  return email;
}

function buildSummary(emails) {
  const totalCleanedChars = emails.reduce((total, email) => total + email.cleanedChars, 0);

  return {
    messageCount: emails.length,
    totalCleanedChars,
    overCharBudget: totalCleanedChars > MAX_PROFILE_INPUT_CHARS,
    cappedAt: MAX_SENT_EMAILS
  };
}

/**
 * GET /api/dev/ingest-preview — the cleaned corpus plus what the cleaner removed.
 * `?includeRaw=1` adds the pre-clean extracted text per email.
 */
router.get('/dev/ingest-preview', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');

  // Belt and braces. app.js only mounts this router when dev routes are enabled,
  // but a route that is merely unmounted is one refactor away from being live.
  if (!devRoutesEnabled()) {
    return res.status(404).json({ error: 'Not found' });
  }

  const includeRaw = req.query?.includeRaw === '1' || req.query?.includeRaw === 'true';

  try {
    const messages = await fetchSentMessages(req.user.id);
    // Same filter fetchSentEmails applies, so messageCount is exactly the number
    // of bodies the voice builder would be handed.
    const emails = messages
      .filter((message) => Boolean(message.cleaned))
      .map((message, index) => describeEmail(message.raw, index, includeRaw));

    // Counts only — no body text, raw or cleaned, at any level.
    logger.info('dev_ingest_preview', { userId: req.user.id, count: emails.length });

    return res.status(200).json({ summary: buildSummary(emails), emails });
  } catch (err) {
    const status = Number(err?.status) || 500;
    logger.error('dev_ingest_preview_failed', { userId: req.user.id, status, name: err?.name });
    return res
      .status(status)
      .json({ error: safeMessage(err, 'Could not load the ingestion preview') });
  }
});

export default router;
