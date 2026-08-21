import { apiFetch } from './api.js';

/**
 * The landing page's waitlist calls (Decisions, 2026-08-15).
 *
 * Both routes are public: `auth: false`, because a visitor has no session and
 * asking for one would defeat the point of the page.
 */

/**
 * NULL until the server answers. There is no placeholder number, deliberately.
 *
 * A hardcoded starting value announces itself: the page paints 88, the request
 * lands, and the number jumps to 94 in front of the reader. That flash is a clearer
 * tell that the figure is fabricated than any wrong number would be, because it
 * shows the page had an opinion before it had data.
 *
 * So the counter renders a neutral placeholder until it knows, and if it never
 * finds out it stays neutral rather than inventing something.
 */

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
    // only thing that actually knows. Null means "no answer", never a guess.
    return Number.isFinite(count) && count >= 0 ? count : null;
  } catch {
    return null;
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
    // A join that succeeded but answered oddly still happened: fall back to null so
    // the counter stays neutral rather than displaying a number nobody computed.
    seat: Number.isFinite(seat) ? seat : null,
    count: Number.isFinite(count) ? count : null
  };
}
