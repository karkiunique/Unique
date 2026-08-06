import { fetchSentMessages, MAX_SENT_EMAILS } from './gmail.js';
import { inspectCleaning } from './gmailParse.js';
import { MAX_PROFILE_INPUT_CHARS } from './voice.js';

/**
 * Production-safe corpus summary — COUNTS ONLY.
 *
 * The onboarding screen needs to tell the user how much sent mail a profile
 * would be built from, and how much of it looks like the cleaner struggled.
 * Those numbers also exist on the dev ingest-preview route, but that route
 * returns email bodies and is therefore gated to dev environments and must stay
 * that way. This module is the shippable half: it runs the very same fetch +
 * clean pipeline the voice builder uses, then throws every string away and
 * returns integers.
 *
 * Nothing here returns, logs or persists body text, subjects or recipients —
 * not even truncated. If you are tempted to add an excerpt, add it to
 * devInspect.js instead, behind the dev gate.
 */

// The same thresholds the review UI applies, so the count it shows and the count
// this returns can never describe different things.
const LONG_EMAIL_CHARS = 400;
const WHOLE_THREAD_CHARS = 3000;

// Quoted-printable that was never decoded.
const QUOTED_PRINTABLE = /=20|=E2=|=C2=/;
// A '<' followed by a letter (tag markup) or a leftover entity.
const HTML_RESIDUE = /<[a-zA-Z]|&nbsp;|&amp;/;

/** True when this email deserves a human look before it feeds the profile. */
function looksSuspect(stages) {
  const rawChars = stages.raw.length;
  const cleanedChars = stages.cleaned.length;
  const strippedChars = Math.max(rawChars - cleanedChars, 0);
  // Trimmed comparison: losing trailing blank lines is not a "removal".
  const quotedReplyRemoved = stages.afterQuotedReplies.trim().length < stages.raw.trim().length;

  if (!quotedReplyRemoved) return true;
  if (strippedChars === 0 && Math.max(rawChars, cleanedChars) > LONG_EMAIL_CHARS) return true;
  if (cleanedChars > WHOLE_THREAD_CHARS) return true;
  if (QUOTED_PRINTABLE.test(stages.cleaned)) return true;

  return HTML_RESIDUE.test(stages.cleaned);
}

/**
 * Counts describing the corpus a voice profile would be built from right now.
 * Bodies live in memory for the length of this call and are never returned.
 */
export async function summarizeCorpus(userId) {
  const messages = await fetchSentMessages(userId);

  let messageCount = 0;
  let totalCleanedChars = 0;
  let suspectCount = 0;

  for (const message of messages) {
    // The same filter fetchSentEmails applies, so messageCount is exactly the
    // number of bodies the voice builder would be handed.
    if (!message.cleaned) continue;

    const stages = inspectCleaning(message.raw);

    messageCount += 1;
    totalCleanedChars += stages.cleaned.length;
    if (looksSuspect(stages)) suspectCount += 1;
  }

  return {
    messageCount,
    totalCleanedChars,
    suspectCount,
    overCharBudget: totalCleanedChars > MAX_PROFILE_INPUT_CHARS,
    cappedAt: MAX_SENT_EMAILS
  };
}
