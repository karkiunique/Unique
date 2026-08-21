import { getSupabaseAdmin } from '../lib/supabase.js';
import { httpError } from '../lib/httpError.js';

/**
 * The landing-page waitlist (CLAUDE.md Decisions, 2026-08-15).
 *
 * PRIVACY: every row in this table is an email address belonging to someone who
 * is not yet a user. Nothing here logs an address, returns one, or puts one in an
 * error message — the route's whole vocabulary is `{seat, count}`. The caller
 * already knows the address they just typed; nobody else is entitled to it.
 *
 * The seat number is issued by Postgres (identity column, migration 007), never
 * computed here. Two people submitting at the same instant is the ordinary case
 * on a launch day, and a count read then written cannot survive it.
 */

/**
 * ZERO since migration 010, and that is not a removal of the baseline.
 *
 * The 88 used to be a display offset added in code. It is now 88 real rows in the
 * table, marked `seeded = true` and backdated before the first genuine signup — so
 * the count is simply the row count and a person's number is simply their position.
 *
 * Leaving this at 88 after 010 would display 88 + 94 = 182.
 *
 * THE SEEDED ROWS MUST NEVER BE MAILED. They are fabricated addresses at RFC 2606
 * reserved domains, and every query that sends to the waitlist has to filter
 * `seeded = false` — see realSignupCount() below and the note in migration 010.
 */
export const WAITLIST_BASE_COUNT = 0;

// Generous: real addresses are far shorter, and RFC 5321's limit is 254. This is
// here to bound the write, not to judge the address.
const MAX_EMAIL_LENGTH = 254;

/**
 * Deliberately loose. This is a marketing page, not the send path — a visitor who
 * mistypes their address gets a "we'll write to you" that never arrives, which is
 * their own to correct, whereas a clever regex that rejects a valid unusual
 * address loses a signup we cannot recover. Structure only: one @, something
 * either side, no whitespace.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trimmed and lowercased, so `Sam@Acme.com` and `sam@acme.com` are one seat. */
export function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** Throws a 400 with a message safe to show; never echoes what was submitted. */
export function assertValidEmail(email) {
  if (email === '' || email.length > MAX_EMAIL_LENGTH || !EMAIL_SHAPE.test(email)) {
    throw httpError(400, 'Enter a valid email address');
  }
}

/**
 * The number the live counter shows: the people on the list, seeded rows included.
 *
 * This is `88 + count(*)`, NOT `max(seat)`. The two agree while seats are dense,
 * and max(seat) was the earlier choice because it reads without a count — but it
 * drifts upward and cannot be brought back:
 *
 * - `INSERT ... ON CONFLICT DO NOTHING` calls nextval BEFORE it detects the
 *   conflict, and sequences are non-transactional, so every repeat submit burns a
 *   seat number. Under max(seat) the counter would then jump by more than one for
 *   a single new signup.
 * - A deleted row leaves its seat spent forever, so max(seat) keeps counting
 *   someone who is no longer on the list.
 *
 * Counting rows answers the question the page actually asks — how many people are
 * waiting — and is immune to both. `head: true` fetches no rows, just the count.
 */
export async function getWaitlistCount() {
  const { count, error } = await getSupabaseAdmin()
    .from('waitlist')
    .select('*', { count: 'exact', head: true });

  if (error) throw httpError(500, 'Could not read the waitlist');

  return WAITLIST_BASE_COUNT + Math.max(0, Number(count) || 0);
}

/** When this address joined, or null if it is not on the list yet. */
async function joinedAt(email) {
  const { data, error } = await getSupabaseAdmin()
    .from('waitlist')
    .select('created_at')
    .eq('email', email)
    .maybeSingle();

  if (error) throw httpError(500, 'Could not join the waitlist');

  return data?.created_at ?? null;
}

/**
 * The number this person is told they are: their POSITION in the list, base 88.
 *
 * NOT `seat`. The identity column is a sequence, and a sequence gaps — a repeat
 * submit that reached the upsert spent a number, and any rolled-back insert or
 * deleted row spends one too. Once it has gapped, `seat` is permanently above the
 * count and the two numbers on the page disagree: "91 already on the waitlist"
 * next to "You're No. 93".
 *
 * Position is counted, so it cannot gap. For the newest joiner it is exactly
 * `88 + count(*)` — the same read as the counter — so at the moment of signup the
 * two numbers are equal by construction, which is the property that kept breaking.
 *
 * The tradeoff, stated: if an earlier row is ever deleted, everyone behind it
 * shifts down by one. That is the honest answer to "what number am I on this
 * list", and it is preferable to a number that is stable but visibly wrong.
 */
async function positionOf(createdAt) {
  const { count, error } = await getSupabaseAdmin()
    .from('waitlist')
    .select('*', { count: 'exact', head: true })
    .lte('created_at', createdAt);

  if (error) throw httpError(500, 'Could not join the waitlist');

  return WAITLIST_BASE_COUNT + Math.max(1, Number(count) || 1);
}

/**
 * Add an address, or hand back the number it already holds.
 *
 * A repeat submit is a SUCCESS (Decisions, 2026-08-15): telling someone "you're
 * already on the list" while they are trying to give you their email is a bad
 * answer to a good action, and a response that distinguishes new from repeat is an
 * oracle for whether any given address is on the list.
 *
 * Returns `{seat, count}` where BOTH are counted, never sequence-derived, so a
 * fresh joiner's number and the counter are the same value.
 */
export async function joinWaitlist(rawEmail) {
  const email = normalizeEmail(rawEmail);
  assertValidEmail(email);

  // LOOK BEFORE INSERTING. Going straight to the upsert is tidier and quietly
  // corrupts the numbering: ON CONFLICT DO NOTHING still calls nextval on the
  // identity before it finds the conflict, and a sequence does not roll back, so
  // every repeat submit spends a seat number that no row will ever hold. Checking
  // first means a returning visitor costs nothing.
  let joined = await joinedAt(email);

  if (joined === null) {
    const { error: insertError } = await getSupabaseAdmin()
      .from('waitlist')
      .upsert({ email }, { onConflict: 'email', ignoreDuplicates: true });

    if (insertError) throw httpError(500, 'Could not join the waitlist');

    // Read back rather than trusting the write: under a genuine race between two
    // submits of the same NEW address, one of them inserts nothing and this is
    // what tells it which row won.
    joined = await joinedAt(email);
  }

  if (joined === null) throw httpError(500, 'Could not join the waitlist');

  // Position first, then the total. In that order a concurrent signup landing
  // between the two reads can only make `count` larger than `seat`, which reads
  // correctly ("you're No. 91, there are 92 of us"). The reverse order could
  // report a position above the total, which reads as broken.
  const seat = await positionOf(joined);
  const count = await getWaitlistCount();

  return { seat, count: Math.max(count, seat) };
}


/**
 * How many REAL people are on the waitlist, excluding the seeded baseline.
 *
 * This is the count that matters for anything with consequences — the go-live invite
 * send above all, which must never mail a fabricated address. It is deliberately a
 * separate function from `getWaitlistCount`, which is the display number: conflating
 * "what the page shows" with "who we may contact" is exactly the mistake the `seeded`
 * flag exists to prevent.
 */
export async function realSignupCount() {
  const { count, error } = await getSupabaseAdmin()
    .from('waitlist')
    .select('*', { count: 'exact', head: true })
    .eq('seeded', false);

  if (error) throw httpError(500, 'Could not read the waitlist');

  return Math.max(0, Number(count) || 0);
}
