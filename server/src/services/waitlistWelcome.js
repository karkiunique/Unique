import { sendSystemEmail } from '../lib/postmark.js';
import { logger } from '../lib/logger.js';

/**
 * The note that goes out the moment someone joins the waitlist: their number,
 * and a thank you.
 *
 * SENT ONCE, ON A GENUINE FIRST INSERT. `POST /waitlist` is public,
 * unauthenticated and treats a resubmit as a success, so a confirmation wired to
 * every submit would let anyone mail a stranger on repeat through our Postmark
 * reputation. `joinWaitlist` reports `created` for exactly this.
 *
 * NO UNSUBSCRIBE FOOTER, and that is the 2026-08-06 decision applied rather than
 * ignored. That entry removed the footer from 1:1 mail because it reads as
 * machine-generated and undercuts the premise, and named reply-to-opt-out as the
 * convention for a single message. This is 1:1 and transactional — a person asked
 * for it seconds ago. The real unsubscribe belongs on the go-live BULK invite,
 * which `waitlist.invited_at` exists to make resumable.
 *
 * PRIVACY: the address is passed to Postmark as the recipient and appears nowhere
 * else — not in the body, not in a log line, not in the return value.
 */

// Straight from :root in web/src/styles.css. Email cannot read a stylesheet, so
// the palette is repeated here; it is four hex values and it is the only way.
const PAPER = '#f1e9d6';
const INK = '#211c13';
const INK_2 = '#544b3a';
const FAINT = '#8f8570';
const RULE = '#d3c7a9';
const RED = '#cc3a1c';

/**
 * Newsreader and Space Mono are self-hosted for the web app, and Gmail strips
 * @font-face, so neither will load here. Georgia is already the declared fallback
 * in --font-serif and is present on effectively every client — the letter degrades
 * to the same warm serif it was designed around rather than to a sans-serif.
 */
const SERIF = "Georgia, 'Times New Roman', serif";
const MONO = "'Courier New', Courier, monospace";

/**
 * Refuse to send anything with an email address in the body.
 *
 * The body is a number and a thank you; it has no reason to contain an address.
 * The guard is here so that a later "let's personalise it with their address"
 * fails loudly instead of quietly putting PII somewhere it can be echoed.
 */
export function assertNoAddressInBody(text) {
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(text)) {
    throw new Error('waitlist welcome body contains an email address');
  }

  return text;
}

/** A seat is a counted position, so anything else is a bug worth failing on. */
function assertSeat(seat) {
  if (!Number.isInteger(seat) || seat < 1) {
    throw new Error('waitlist welcome requires a positive integer seat');
  }

  return seat;
}

function textVersion(seat) {
  return assertNoAddressInBody(
    [
      `You're No. ${seat}.`,
      '',
      'Thank you for putting your name down. That number is your place in the',
      'line, and it is yours.',
      '',
      'Unique learns how you actually write, finds the people worth writing to,',
      'and drafts every letter in your own hand. You read each one and send it',
      'yourself. Nothing goes out under your name that you have not read.',
      '',
      "We'll write once more, when your seat opens. That's the only other letter",
      "you'll get from us. If you'd rather we didn't, reply to this and say so.",
      '',
      '— Unique',
      'Outbound, in your own hand'
    ].join('\n')
  );
}

/**
 * Table layout and inlined styles throughout: email clients have no flexbox, no
 * grid, and no <style> block worth relying on. `color-scheme: light` asks clients
 * not to force-invert a design whose whole subject is the colour of paper.
 *
 * THE SHELL IS FLUID — `width:100%` capped by `max-width:600px`, never a fixed
 * `width="600"`. A fixed width does not shrink, so on a phone the letter simply
 * runs off the right edge, which is where most of these will be opened. There is
 * no media query to fall back on: Gmail's app strips <style> for non-Google
 * accounts, so the layout has to be correct without one.
 */
function htmlVersion(seat) {
  const rule = (color, height) =>
    `<tr><td style="line-height:0;font-size:0;height:${height}px;background:${color};">&nbsp;</td></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>You're No. ${seat}</title>
</head>
<body style="margin:0;padding:0;background:${PAPER};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAPER};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">

  <tr><td style="font-family:${SERIF};font-size:26px;color:${INK};padding-bottom:14px;">
    Unique<span style="color:${RED};">.</span>
  </td></tr>
  ${rule(INK, 2)}

  <tr><td style="font-family:${MONO};font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${FAINT};padding:8px 0;">
    No. 001 &middot; The voice issue
  </td></tr>
  ${rule(RULE, 1)}

  <tr><td align="center" style="padding:44px 0 12px;font-family:${MONO};font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${RED};">
    Your place in the line
  </td></tr>
  <tr><td align="center" style="font-family:${SERIF};font-size:76px;line-height:1;color:${INK};padding-bottom:8px;">
    No.&nbsp;${seat}
  </td></tr>
  <tr><td align="center" style="font-family:${SERIF};font-style:italic;font-size:19px;color:${RED};padding-bottom:40px;">
    Thank you.
  </td></tr>

  ${rule(RULE, 1)}
  <tr><td style="font-family:${SERIF};font-size:17px;line-height:1.6;color:${INK_2};padding:26px 0 0;">
    <p style="margin:0 0 16px;">
      Thank you for putting your name down. That number is your place in the line,
      and it is yours.
    </p>
    <p style="margin:0 0 16px;">
      Unique learns how you actually write, finds the people worth writing to, and
      drafts every letter in your own hand. You read each one and send it yourself.
      Nothing goes out under your name that you have not read.
    </p>
    <p style="margin:0 0 26px;">
      We&rsquo;ll write once more, when your seat opens. That&rsquo;s the only other
      letter you&rsquo;ll get from us &mdash; and if you&rsquo;d rather we
      didn&rsquo;t, reply to this one and say so.
    </p>
  </td></tr>

  ${rule(INK, 2)}
  <tr><td style="font-family:${MONO};font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${FAINT};padding:12px 0 0;">
    Unique &middot; Outbound in your own hand
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

/** Subject, text and HTML for one joiner. Exported so tests read what ships. */
export function buildWaitlistWelcomeEmail(seat) {
  assertSeat(seat);

  return {
    subject: `You're No. ${seat} on the Unique waitlist`,
    textBody: textVersion(seat),
    htmlBody: htmlVersion(seat)
  };
}

/**
 * Send it, and never let it break a signup that already succeeded.
 *
 * The row is written and the visitor has their number before this runs. A missing
 * Postmark token, a rejection or a timeout is a note that did not arrive, not a
 * failed signup, so every outcome resolves — this never rejects and never throws.
 */
export async function sendWaitlistWelcome({ to, seat }) {
  try {
    const { subject, textBody, htmlBody } = buildWaitlistWelcomeEmail(seat);
    const result = await sendSystemEmail({
      to,
      subject,
      textBody,
      htmlBody,
      tag: 'waitlist-welcome'
    });

    if (!result.sent) logger.warn('waitlist_welcome_not_sent', { reason: result.reason });

    return result;
  } catch (err) {
    // Never the address, never the body: the name of the failure only.
    logger.error('waitlist_welcome_failed', { name: err?.name || 'unknown' });

    return { sent: false, reason: 'error' };
  }
}
