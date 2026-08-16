import { apiFetch } from './api.js';

/**
 * The landing page's waitlist calls (Decisions, 2026-08-15).
 *
 * Both routes are public: `auth: false`, because a visitor has no session and
 * asking for one would defeat the point of the page.
 */

// Mirrors WAITLIST_BASE_COUNT on the server. Duplicated rather than fetched
// because it is the number the page shows when the server cannot be reached at
// all — a fallback that needs the server is not a fallback.
export const WAITLIST_BASE_COUNT = 88;

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

    return Number.isFinite(count) && count >= WAITLIST_BASE_COUNT ? count : WAITLIST_BASE_COUNT;
  } catch {
    return WAITLIST_BASE_COUNT;
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
    seat: Number.isFinite(seat) ? seat : WAITLIST_BASE_COUNT + 1,
    count: Number.isFinite(count) ? count : WAITLIST_BASE_COUNT + 1
  };
}
