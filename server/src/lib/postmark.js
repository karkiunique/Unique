import { logger } from './logger.js';

/**
 * System mail, sent by Unique itself.
 *
 * WHAT THIS IS FOR: mail from the product to its own USER — the daily "drafts are
 * ready" notice, and the waitlist go-live invite. It is NEVER used to mail a
 * prospect. Prospect mail goes through the user's own Gmail and nowhere else
 * (CLAUDE.md, Decisions 2026-08-16).
 *
 * WHY NOT GMAIL: sending this through the user's mailbox would email them as
 * themselves, land in their own Sent folder, consume their daily send limit and
 * pollute `send_log`. It also has to work when Gmail is disconnected, which is
 * exactly when they most need telling.
 *
 * WHY NO SDK: Postmark's REST API is one POST. Node 20 has global fetch, so a
 * dependency here would be supply-chain surface bought for nothing.
 *
 * PRIVACY: callers must not pass draft bodies, prospect names or prospect
 * addresses through here. See `assertNoProspectContent` in services/notify.js —
 * this module cannot tell what it is being handed, so the guard lives with the
 * caller that knows.
 */

const POSTMARK_ENDPOINT = 'https://api.postmarkapp.com/email';
const SEND_TIMEOUT_MS = 10_000;

/** Configured only when both halves are present — a token with no From sends nothing. */
export function isPostmarkConfigured() {
  return Boolean(process.env.POSTMARK_API_TOKEN && process.env.POSTMARK_FROM_EMAIL);
}

/**
 * Send one transactional email.
 *
 * Resolves `{ sent: false, reason }` rather than throwing when Postmark is not
 * configured: a missing token must not fail a daily run that has already produced
 * good drafts. The drafts are in the app either way, and the run records that the
 * notification did not go out so it can be retried.
 */
export async function sendSystemEmail({ to, subject, textBody, htmlBody, tag }) {
  if (!isPostmarkConfigured()) {
    logger.warn('postmark_not_configured', { reason: 'missing_token_or_from' });
    return { sent: false, reason: 'not_configured' };
  }

  if (!to || !subject || !textBody) {
    throw new Error('sendSystemEmail requires to, subject and textBody');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

  try {
    const response = await fetch(POSTMARK_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Postmark-Server-Token': process.env.POSTMARK_API_TOKEN
      },
      body: JSON.stringify({
        From: process.env.POSTMARK_FROM_EMAIL,
        To: to,
        Subject: subject,
        TextBody: textBody,
        ...(htmlBody ? { HtmlBody: htmlBody } : {}),
        ...(tag ? { Tag: tag } : {}),
        MessageStream: 'outbound'
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      // Postmark echoes the recipient in its error payload, so the body is never
      // logged and never returned — only the status.
      logger.error('postmark_send_failed', { status: response.status, name: tag || 'system' });
      return { sent: false, reason: 'rejected' };
    }

    logger.info('postmark_sent', { name: tag || 'system' });

    return { sent: true };
  } catch (err) {
    // AbortError included: a slow provider must not hang a cron run.
    logger.error('postmark_send_failed', { status: 0, name: err?.name || 'unknown' });
    return { sent: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}
