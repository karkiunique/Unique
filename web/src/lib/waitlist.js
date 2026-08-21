import { apiFetch } from './api.js';

/**
 * The landing page's waitlist calls (Decisions, 2026-08-15).
 *
 * Both routes are public: `auth: false`, because a visitor has no session and
 * asking for one would defeat the point of the page.
 */

/**
 * What the counter shows when the server cannot be reached AT ALL.
 *
 * A fallback, NOT a floor. It used to be both, back when the server added the same
 * 88 as an offset and so could never answer with less — then migration 010 moved
 * the baseline into the table, the server started returning the raw row count, and
 * a `count >= 88` guard here silently threw away every real answer below it. The
 * page showed 88 while the API was plainly returning 6.
 *
 * Anything finite and non-negative from the server is the truth. This value is only
 * for the case where there is no answer.
 */
export const WAITLIST_FALLBACK_COUNT = 88;

/**
 * The live count, or the base if anything goes wrong.
 *
 * Deliberately swallows the error: this is the marketing page, and a visitor who
 * came to read about the product should never see a failed request. The counter
 * is decoration on the way to the form; the form is what matters, and it works
 * whether or not this call did.
 */
export async function fetchWaitlistCount() {
  try {
    const payload = await apiFetch('/waitlist/count', { auth: false });
    const count = Number(payload?.count);

    // Trust any real number. A floor here would override the server, which is the
    // only thing that actually knows.
    return Number.isFinite(count) && count >= 0 ? count : WAITLIST_FALLBACK_COUNT;
  } catch {
    return WAITLIST_FALLBACK_COUNT;
  }
}

/**
 * Join, and get back the seat.
 *
 * This one does NOT swallow its error — the visitor pressed a button and is owed
 * an answer. The server's message is shown as-is; it is written by us and never
 * contains the address (see routes/waitlist.js).
 */
export async function joinWaitlist(email) {
  const payload = await apiFetch('/waitlist', {
    method: 'POST',
    body: { email },
    auth: false
  });

  const seat = Number(payload?.seat);
  const count = Number(payload?.count);

  return {
    seat: Number.isFinite(seat) ? seat : WAITLIST_FALLBACK_COUNT + 1,
    count: Number.isFinite(count) ? count : WAITLIST_FALLBACK_COUNT + 1
  };
}
