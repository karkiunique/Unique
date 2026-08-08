/**
 * Subject-line shaping for the confirmation step — pure functions, no React, no
 * network.
 *
 * These run in the BROWSER, before ConfirmSendDialog renders, because that dialog
 * promises "exactly this leaves your Gmail. Nothing is rewritten after you
 * confirm." Anything that shapes the subject — trimming it, adding the "Re: " of a
 * follow-up — therefore has to happen before the user reads it. Shaping it
 * afterwards would buy consent for one string and post another, which is the one
 * thing the whole send path is built to prevent.
 *
 * The server applies the identical rules again on its way out to Gmail. Both are
 * idempotent, so for anything that came through the dialog they are no-ops, and
 * they stay there only as a backstop.
 *
 * Nothing here logs: a subject line is email content.
 */

/** The subject as it will be sent: trimmed. A non-string reads as no subject. */
export function normaliseSubject(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * "Re: " once, never twice — `Re: x`, `RE: x` and `re:x` are all left alone.
 *
 * Deliberately the same rule as withReplyPrefix() in server/src/services/send.js,
 * empty case included: the server does not prefix an empty subject either, it
 * rejects it as missing. A bare "Re:" is not a subject line anyone approved.
 */
export function withReplyPrefix(value) {
  const clean = normaliseSubject(value);
  if (clean === '') return '';

  return /^re\s*:/i.test(clean) ? clean : `Re: ${clean}`;
}
