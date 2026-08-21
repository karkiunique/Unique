import { describe, it, expect, vi, beforeEach } from 'vitest';

import { useSharedTestServer } from './helpers/testServer.js';

/**
 * POST /api/waitlist and GET /api/waitlist/count — the landing page's signup
 * (Decisions, 2026-08-15).
 *
 * The service is NOT mocked: the point of this file is the route's contract end to
 * end — who it lets in, what it stores, what it refuses, and above all what it is
 * allowed to SAY.
 *
 * PRIVACY is the load-bearing part. Every row in this table is an email address
 * belonging to someone who is not a user of anything yet. The address must never
 * reach a log line, an error message, or a response body, and the tests below
 * assert that against the literal address rather than against a redaction marker —
 * a redaction that stops running still passes a test that only looks for "[redacted]".
 *
 * THE NUMBERS are the other thing under test, and they are subtler than they look.
 * The page shows the count twice — "N already on the waitlist" and "You're No. N" —
 * and for a fresh joiner those MUST be the same number. Both are counted, never
 * read off the `seat` identity column. Three ways this has already been got wrong,
 * all regression-tested below:
 *   1. deriving the count from the submitter's own number (counts DOWN on a repeat);
 *   2. letting a repeat submit reach the upsert at all — ON CONFLICT DO NOTHING
 *      still burns an identity value even though it writes nothing;
 *   3. showing `seat` as the person's number — once the sequence has gapped it sits
 *      above the count, and the two numbers on the page disagree.
 */

const { supabaseFrom, sendWaitlistWelcome } = vi.hoisted(() => ({
  supabaseFrom: vi.fn(),
  sendWaitlistWelcome: vi.fn()
}));

/* Mocked here so this file stays about the route's contract and its numbers. The
   confirmation email has its own file; leaving the real one wired would have it
   running after the response, past the point supertest has already resolved. */
vi.mock('../src/services/waitlistWelcome.js', () => ({ sendWaitlistWelcome }));

vi.mock('../src/lib/supabase.js', () => ({
  getSupabaseAdmin: () => ({ from: supabaseFrom }),
  resetSupabaseAdmin: () => {}
}));

vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  sanitizeMeta: (meta) => meta
}));

const { createApp } = await import('../src/app.js');
const { logger } = await import('../src/lib/logger.js');

const EMAIL = 'sam@acme.com';

let upserts = [];
let selects = [];
/**
 * The write's answer. `data` is what `.select()` returns AFTER the upsert, which
 * on an `ignoreDuplicates` upsert is the row only when THIS statement inserted
 * it, and nothing when it conflicted. That is what tells the service whether it
 * is the one that created the row.
 */
let upsertAnswer = { data: undefined, error: null };

const JOINED = '2026-08-15T16:00:00.000Z';

/**
 * Answers for the membership lookup, consumed in order; the last one repeats. A
 * fresh signup is [miss, hit] — the lookup misses, the row is written, the
 * read-back finds it. A returning visitor is a single answer that always hits.
 */
let joinedAnswers = [{ data: { created_at: JOINED }, error: null }];

/** Rows at or before this person — the POSITION read (has an `lte` filter). */
let positionAnswer = { count: 1, error: null };

/** Rows in total — the COUNTER read (no filter). */
let totalAnswer = { count: 1, error: null };

function nextJoinedAnswer() {
  return joinedAnswers.length > 1 ? joinedAnswers.shift() : joinedAnswers[0];
}

function builderFor() {
  return {
    upsert(values, options) {
      upserts.push({ values, options });

      return {
        // The write's own RETURNING clause, not a query — so it is deliberately
        // not recorded in `selects`, which tracks reads.
        select: async () =>
          upsertAnswer.error
            ? { data: null, error: upsertAnswer.error }
            : { data: upsertAnswer.data ?? [{ created_at: JOINED }], error: null }
      };
    },
    select(columns, options) {
      const query = { columns, options, filters: {}, bounded: false };
      selects.push(query);

      const chain = {
        eq(column, value) {
          query.filters[column] = value;
          return chain;
        },
        lte(column, value) {
          query.filters[column] = value;
          query.bounded = true;
          return chain;
        },
        // The membership lookup singles out a row...
        maybeSingle: async () => nextJoinedAnswer(),
        // ...while a head+count read is awaited whole. Which count it is depends on
        // whether it was bounded to "at or before me".
        then: (resolve, reject) =>
          Promise.resolve(query.bounded ? positionAnswer : totalAnswer).then(resolve, reject)
      };

      return chain;
    }
  };
}

/** Every log line this request produced, flattened to one searchable string. */
function loggedText() {
  return [...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls]
    .map((call) => JSON.stringify(call))
    .join(' ');
}

// One server for the whole file. The join limiter is 10 requests / 15 min per IP and
// does NOT reset between tests, so this file makes exactly 10 POSTs — it is AT the
// limit. Add a test that posts and you must retire one, or the new test 429s.
const httpRequest = useSharedTestServer(createApp);

beforeEach(() => {
  upserts = [];
  selects = [];
  upsertAnswer = { data: undefined, error: null };
  joinedAnswers = [{ data: { created_at: JOINED }, error: null }];
  sendWaitlistWelcome.mockReset();
  sendWaitlistWelcome.mockResolvedValue({ sent: true });
  positionAnswer = { count: 1, error: null };
  totalAnswer = { count: 1, error: null };
  supabaseFrom.mockReset();
  supabaseFrom.mockImplementation(builderFor);
  logger.info.mockReset();
  logger.warn.mockReset();
  logger.error.mockReset();
});

describe('POST /api/waitlist', () => {
  /**
   * THE NUMBERS MUST AGREE. This is the property the page shows twice — "N already
   * on the waitlist" at the top and "You're No. N" on the confirmation — and it is
   * what broke when the number came from the identity sequence: the counter read 91
   * while the confirmation read 93, because two sequence values had been burned.
   *
   * A fresh joiner is the LAST row, so their position and the total are the same
   * count. Equal by construction, not by luck.
   */
  it('gives a new joiner a number equal to the counter, counted not sequenced', async () => {
    // Fresh signup: the lookup misses, then finds the row after the write. The row
    // carries seat 93 — what a sequence gapped by two burned values would have
    // handed it — so a version that reads the number off `seat` fails here.
    joinedAnswers = [
      { data: null, error: null },
      { data: { created_at: JOINED, seat: 93 }, error: null }
    ];
    // Three rows total, and this person is the third — so they are No. 3 of 3.
    // Since migration 010 the 88 baseline lives in the TABLE, not in a constant, so
    // the displayed number is simply the row count.
    positionAnswer = { count: 3, error: null };
    totalAnswer = { count: 3, error: null };

    const response = await httpRequest('post', '/api/waitlist').send({ email: EMAIL });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ seat: 3, count: 3 });
    expect(response.body.seat).toBe(response.body.count);
    expect(response.body.seat).not.toBe(93);
    // A public route: it must not have required a session to get here.
    expect(response.body.error).toBeUndefined();
  });

  it('never puts the address in the response body or in a log line', async () => {
    const response = await httpRequest('post', '/api/waitlist').send({ email: EMAIL });

    expect(response.status).toBe(201);
    expect(JSON.stringify(response.body)).not.toContain(EMAIL);
    expect(JSON.stringify(response.body)).not.toContain('acme.com');
    expect(loggedText()).not.toContain(EMAIL);
    expect(loggedText()).not.toContain('acme.com');
    // It did log — the assertion above is meaningless if nothing was written.
    expect(logger.info).toHaveBeenCalledWith('waitlist_joined', { count: 1 });
  });

  it('lowercases and trims before writing, so one person is one number', async () => {
    joinedAnswers = [
      { data: null, error: null },
      { data: { created_at: JOINED }, error: null }
    ];

    await httpRequest('post', '/api/waitlist').send({ email: '  SAM@Acme.COM  ' });

    expect(upserts[0].values).toEqual({ email: EMAIL });
    // And every lookup is keyed by the same normalised value, not the raw input.
    const lookups = selects.filter((query) => 'email' in query.filters);
    expect(lookups.length).toBeGreaterThan(0);
    for (const lookup of lookups) expect(lookup.filters.email).toBe(EMAIL);
  });

  /**
   * THE SEAT-BURNING REGRESSION. `INSERT ... ON CONFLICT DO NOTHING` calls nextval
   * before it detects the conflict and a sequence does not roll back, so letting a
   * repeat submit reach the upsert spends a seat number no row will ever hold. The
   * counter then jumps by more than one for the next real signup.
   *
   * Asserting on the CALL, not the result: a version that upserts anyway returns an
   * identical body and is still wrong.
   */
  it('does not attempt a write at all when the address is already on the list', async () => {
    joinedAnswers = [{ data: { created_at: JOINED }, error: null }];
    positionAnswer = { count: 2, error: null };

    const response = await httpRequest('post', '/api/waitlist').send({ email: EMAIL });

    expect(response.status).toBe(201);
    expect(response.body.seat).toBe(2);
    // The whole point: no insert was attempted, so no identity value was spent.
    expect(upserts).toHaveLength(0);
  });

  it('writes exactly once for an address that is genuinely new', async () => {
    joinedAnswers = [
      { data: null, error: null },
      { data: { created_at: JOINED }, error: null }
    ];

    await httpRequest('post', '/api/waitlist').send({ email: EMAIL });

    expect(upserts).toHaveLength(1);
    expect(upserts[0].options).toMatchObject({ onConflict: 'email', ignoreDuplicates: true });
  });

  /**
   * A repeat submit adds nobody, so the count must not move — and in particular
   * must not fall back to the RE-SUBMITTER'S OWN number, which is the shape this
   * got wrong first: an early member re-submitting to a much longer list was
   * answered with their OWN position as the count, and the page counted itself down.
   *
   * Here the two numbers legitimately DIFFER, and that is correct: you are No. 90
   * on a list that has since grown to 137.
   */
  it('does not move the count when an existing member submits again', async () => {
    joinedAnswers = [{ data: { created_at: JOINED }, error: null }];
    positionAnswer = { count: 2, error: null }; // two rows at or before theirs
    totalAnswer = { count: 49, error: null }; // forty-nine rows in all

    const response = await httpRequest('post', '/api/waitlist').send({ email: EMAIL });

    expect(response.status).toBe(201);
    // Their own number is their position, unchanged...
    expect(response.body.seat).toBe(2);
    // ...and the list is 49. Not 2, and not 50.
    expect(response.body.count).toBe(49);
  });

  it('refuses a malformed address without echoing what was submitted', async () => {
    const submitted = 'not-an-email-at-all';

    const response = await httpRequest('post', '/api/waitlist').send({ email: submitted });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Enter a valid email address');
    expect(JSON.stringify(response.body)).not.toContain(submitted);
    // Nothing was read or written on the way to refusing it.
    expect(upserts).toHaveLength(0);
    expect(selects).toHaveLength(0);
  });

  it('answers 500 without leaking the address when the write fails', async () => {
    joinedAnswers = [{ data: null, error: null }];
    upsertAnswer = { error: { message: `duplicate key value ... ${EMAIL}` } };

    const response = await httpRequest('post', '/api/waitlist').send({ email: EMAIL });

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Could not join the waitlist');
    // The driver's own message carried the address. It must not be forwarded.
    expect(JSON.stringify(response.body)).not.toContain(EMAIL);
    expect(loggedText()).not.toContain(EMAIL);
  });

  it('answers 500 when the row cannot be read back rather than inventing a seat', async () => {
    joinedAnswers = [{ data: null, error: null }];
    // The upsert conflicted, so it returned no row, and the read-back finds
    // nothing either — there is no created_at to be had from either source.
    upsertAnswer = { data: [], error: null };

    const response = await httpRequest('post', '/api/waitlist').send({ email: EMAIL });

    expect(response.status).toBe(500);
    expect(response.body.seat).toBeUndefined();
  });
});

describe('GET /api/waitlist/count', () => {
  it('counts the rows rather than reading the highest seat', async () => {
    totalAnswer = { count: 49, error: null };

    const response = await httpRequest('get', '/api/waitlist/count');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ count: 49 });

    // head:true so the addresses are never fetched just to be counted.
    expect(selects[0].options).toMatchObject({ count: 'exact', head: true });
  });

  // Since 010 an empty table means an empty list: the 88 baseline is 88 ROWS, so a
  // table without them genuinely has nobody on it.
  it('shows zero on a genuinely empty table', async () => {
    totalAnswer = { count: 0, error: null };

    const response = await httpRequest('get', '/api/waitlist/count');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ count: 0 });
  });

  it('never reports a negative count when the driver returns null', async () => {
    totalAnswer = { count: null, error: null };

    const response = await httpRequest('get', '/api/waitlist/count');

    expect(response.body).toEqual({ count: 0 });
  });

  it('answers 500 on a read failure without exposing the driver message', async () => {
    totalAnswer = { count: null, error: { message: 'relation "waitlist" does not exist' } };

    const response = await httpRequest('get', '/api/waitlist/count');

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Could not read the waitlist');
    expect(JSON.stringify(response.body)).not.toContain('relation');
  });
});

/**
 * THE SEEDED BASELINE (migration 010).
 *
 * The 88 is 88 real rows now, marked `seeded = true`. The display count includes
 * them — that is the whole point — but ANYTHING THAT SENDS MAIL MUST NOT. Those are
 * fabricated addresses at RFC 2606 reserved domains, and the go-live invite mailing
 * 88 of them from a new Postmark sender is how a transactional domain gets throttled
 * on day one.
 */
describe('realSignupCount — who may actually be contacted', () => {
  it('excludes the seeded baseline', async () => {
    totalAnswer = { count: 6, error: null };

    const { realSignupCount } = await import('../src/services/waitlist.js');
    await realSignupCount();

    const filtered = selects.find((query) => 'seeded' in query.filters);
    expect(filtered).toBeDefined();
    expect(filtered.filters.seeded).toBe(false);
  });

  it('is a DIFFERENT function from the display count, deliberately', async () => {
    const mod = await import('../src/services/waitlist.js');

    // Conflating "what the page shows" with "who we may email" is precisely the
    // mistake the seeded flag exists to prevent.
    expect(mod.realSignupCount).not.toBe(mod.getWaitlistCount);
  });
});
