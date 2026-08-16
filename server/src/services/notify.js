import { sendSystemEmail } from '../lib/postmark.js';

/**
 * The "your drafts are ready" notice.
 *
 * THE HARD RULE (CLAUDE.md, Decisions 2026-08-16): this email carries a COUNT and
 * a LINK. Never a draft body, never a prospect's name, never a prospect's address.
 *
 * The reason is not tidiness. Putting draft content in here would route the user's
 * prospect data and AI-drafted letters through a third party that has no business
 * holding them, which is the § Privacy rule that raw bodies reach no third party
 * except the Anthropic API. The link goes to the app, where the content already
 * lives and is already access-controlled.
 *
 * `assertNoProspectContent` enforces it at the boundary rather than trusting every
 * future caller to remember.
 */

const DEFAULT_APP_URL = 'http://localhost:5173';

function appUrl() {
  return (process.env.APP_URL || DEFAULT_APP_URL).replace(/\/+$/, '');
}

/**
 * Refuse to send anything shaped like prospect data.
 *
 * Deliberately crude — an address is the one thing with a machine-checkable shape,
 * and it is also the thing that must never appear. A body long enough to be a
 * letter is the other tell. This cannot catch every mistake; it catches the two
 * that matter and it fails LOUD, because a notification that quietly leaks a
 * prospect is worse than one that does not send.
 */
export function assertNoProspectContent(text) {
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(text)) {
    throw new Error('notification body contains an email address');
  }

  if (text.length > 600) {
    throw new Error('notification body is too long to be a count and a link');
  }

  return text;
}

/** Singular/plural without a dependency, and without "1 drafts". */
function draftCount(count) {
  return count === 1 ? '1 draft' : `${count} drafts`;
}

export function buildDraftsReadyEmail(count) {
  const link = `${appUrl()}/queue`;

  const textBody = assertNoProspectContent(
    [
      `${draftCount(count)} ready for your review.`,
      '',
      'Unique found and researched them overnight, and drafted each one in your voice.',
      'Nothing has been sent. Read each letter, edit anything you want, and send the',
      'ones you like.',
      '',
      `Review them here: ${link}`,
      '',
      '— Unique'
    ].join('\n')
  );

  return {
    subject: `${draftCount(count)} ready for review`,
    textBody
  };
}

/**
 * Notify one user that their daily drafts are waiting.
 *
 * Takes the count, never the leads — the signature is the guard. A function that
 * accepted the drafts could be changed to include them.
 */
export async function notifyDraftsReady(userEmail, count) {
  if (!userEmail || !Number.isInteger(count) || count < 1) {
    throw new Error('notifyDraftsReady requires a recipient and a positive count');
  }

  const { subject, textBody } = buildDraftsReadyEmail(count);

  return sendSystemEmail({ to: userEmail, subject, textBody, tag: 'drafts-ready' });
}
