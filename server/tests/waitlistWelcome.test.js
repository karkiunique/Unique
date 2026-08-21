import { describe, it, expect, vi, beforeEach } from 'vitest';

import { useSharedTestServer } from './helpers/testServer.js';

/**
 * The waitlist confirmation: the note that goes out on signup with the joiner's
 * number.
 *
 * THREE PROPERTIES CARRY THE WEIGHT, and none of them is the copy:
 *
 * 1. IT IS SENT ONCE, ON A GENUINE FIRST INSERT. `POST /waitlist` is public,
 *    unauthenticated, and treats a resubmit as a success. A confirmation wired to
 *    every submit would let anyone put a stranger's address in the box on repeat
 *    and mail them through our Postmark reputation.
 * 2. IT NEVER FAILS THE SIGNUP. The row is written and the number shown before
 *    this runs, so a missing token, a rejection or a timeout is a note that did
 *    not arrive — not a lost signup.
 * 3. THE NUMBER IS THE ONE THE PAGE SHOWED. `seat` is handed to the sender, never
 *    recomputed, so a signup landing in between cannot make the inbox disagree
 *    with the screen. That is the bug class the 2026-08-15 entry fought three
 *    times over.
 */

const { sendSystemEmail } = vi.hoisted(() => ({ sendSystemEmail: vi.fn() }));

vi.mock('../src/lib/postmark.js', () => ({
  sendSystemEmail,
  isPostmarkConfigured: () => true
}));

vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  sanitizeMeta: (meta) => meta
}));

const { supabaseFrom } = vi.hoisted(() => ({ supabaseFrom: vi.fn() }));

vi.mock('../src/lib/supabase.js', () => ({
  getSupabaseAdmin: () => ({ from: supabaseFrom }),
  resetSupabaseAdmin: () => {}
}));

const { buildWaitlistWelcomeEmail, sendWaitlistWelcome, assertNoAddressInBody } = await import(
  '../src/services/waitlistWelcome.js'
);
const { createApp } = await import('../src/app.js');
const { logger } = await import('../src/lib/logger.js');

const EMAIL = 'sam@acme.com';
const JOINED = '2026-08-15T16:00:00.000Z';

/** Whether the upsert reports that IT inserted the row. */
let upsertReturnedRow = true;
let joinedAnswers = [];

function nextJoinedAnswer() {
  return joinedAnswers.length > 1 ? joinedAnswers.shift() : joinedAnswers[0];
}

function builderFor() {
  return {
    upsert: () => ({
      select: async () => ({ data: upsertReturnedRow ? [{ created_at: JOINED }] : [], error: null })
    }),
    select() {
      const query = { bounded: false };
      const chain = {
        eq: () => chain,
        lte: () => {
          query.bounded = true;
          return chain;
        },
        maybeSingle: async () => nextJoinedAnswer(),
        then: (resolve, reject) => Promise.resolve({ count: 7, error: null }).then(resolve, reject)
      };

      return chain;
    }
  };
}

const httpRequest = useSharedTestServer(createApp);

beforeEach(() => {
  sendSystemEmail.mockReset();
  sendSystemEmail.mockResolvedValue({ sent: true });
  supabaseFrom.mockReset();
  supabaseFrom.mockImplementation(builderFor);
  logger.warn.mockReset();
  logger.error.mockReset();
  upsertReturnedRow = true;
  joinedAnswers = [{ data: null, error: null }];
});

describe('buildWaitlistWelcomeEmail', () => {
  it('leads with the number, in the subject and in both bodies', () => {
    const { subject, textBody, htmlBody } = buildWaitlistWelcomeEmail(94);

    expect(subject).toBe("You're No. 94 on the Unique waitlist");
    expect(textBody).toContain("You're No. 94.");
    expect(textBody).toContain('Thank you');
    expect(htmlBody).toContain('No.&nbsp;94');
  });

  it('carries the paper, ink and editorial red rather than a default email look', () => {
    const { htmlBody } = buildWaitlistWelcomeEmail(94);

    expect(htmlBody).toContain('#f1e9d6');
    expect(htmlBody).toContain('#211c13');
    expect(htmlBody).toContain('#cc3a1c');
    // Georgia, because Newsreader is self-hosted and Gmail strips @font-face.
    expect(htmlBody).toContain('Georgia');
    // Asking clients not to force-invert a design about the colour of paper.
    expect(htmlBody).toContain('color-scheme');
  });

  /**
   * REGRESSION: the shell was a fixed `width="600"`, which does not shrink, so on
   * a phone the letter ran off the right edge — and a phone is where most of
   * these are opened. There is no media query to fall back on, because Gmail's
   * app strips <style> for non-Google accounts, so the width has to be fluid.
   */
  it('is fluid up to 600px rather than pinned to it', () => {
    const { htmlBody } = buildWaitlistWelcomeEmail(1247);

    expect(htmlBody).toContain('width:100%;max-width:600px');
    // Lookbehind, because 'max-width:600px' contains 'width:600px' — a plain
    // substring check here asserts against itself and can never pass.
    expect(htmlBody).not.toMatch(/(?<!max-)width:600px/);
    expect(htmlBody).not.toContain('width="600"');
  });

  /**
   * Postmark requires a text alternative and so does every spam filter worth the
   * name, but the real point is that the number has to survive a client that
   * refuses HTML entirely.
   */
  it('is readable with no HTML at all', () => {
    const { textBody } = buildWaitlistWelcomeEmail(7);

    expect(textBody).not.toContain('<');
    expect(textBody).toContain("You're No. 7.");
  });

  it('refuses a seat that is not a counted position', () => {
    expect(() => buildWaitlistWelcomeEmail(0)).toThrow(/positive integer/);
    expect(() => buildWaitlistWelcomeEmail(-1)).toThrow(/positive integer/);
    expect(() => buildWaitlistWelcomeEmail(1.5)).toThrow(/positive integer/);
    expect(() => buildWaitlistWelcomeEmail(undefined)).toThrow(/positive integer/);
  });

  it('has no email address anywhere in the body, and fails loud if one is added', () => {
    const { textBody, htmlBody } = buildWaitlistWelcomeEmail(94);

    expect(textBody).not.toMatch(/[^\s@]+@[^\s@]+\.[^\s@]+/);
    expect(htmlBody).not.toContain('@');
    // The guard is what stops a later "personalise it with their address".
    expect(() => assertNoAddressInBody('hello sam@acme.com')).toThrow(/email address/);
  });
});

describe('sendWaitlistWelcome', () => {
  it('sends to the joiner, tagged, with both bodies', async () => {
    await sendWaitlistWelcome({ to: EMAIL, seat: 94 });

    expect(sendSystemEmail).toHaveBeenCalledTimes(1);
    expect(sendSystemEmail.mock.calls[0][0]).toMatchObject({
      to: EMAIL,
      subject: "You're No. 94 on the Unique waitlist",
      tag: 'waitlist-welcome'
    });
    expect(sendSystemEmail.mock.calls[0][0].htmlBody).toContain('No.&nbsp;94');
  });

  it('resolves rather than throwing when the provider rejects it', async () => {
    sendSystemEmail.mockResolvedValue({ sent: false, reason: 'rejected' });

    await expect(sendWaitlistWelcome({ to: EMAIL, seat: 94 })).resolves.toMatchObject({
      sent: false
    });
    expect(logger.warn).toHaveBeenCalledWith('waitlist_welcome_not_sent', { reason: 'rejected' });
  });

  it('resolves rather than throwing when the provider throws, and logs no address', async () => {
    sendSystemEmail.mockRejectedValue(new Error(`connect ECONNREFUSED for ${EMAIL}`));

    await expect(sendWaitlistWelcome({ to: EMAIL, seat: 94 })).resolves.toMatchObject({
      sent: false
    });

    const logged = JSON.stringify(logger.error.mock.calls);
    expect(logged).not.toContain(EMAIL);
    expect(logged).not.toContain('acme.com');
  });
});

describe('POST /api/waitlist sends it once, and only to a new joiner', () => {
  it('sends to someone genuinely new, with the number the page showed them', async () => {
    const response = await httpRequest('post', '/api/waitlist').send({ email: EMAIL });

    expect(response.status).toBe(201);
    expect(sendSystemEmail).toHaveBeenCalledTimes(1);

    const sent = sendSystemEmail.mock.calls[0][0];
    expect(sent.to).toBe(EMAIL);
    // THE SAME NUMBER, not a recomputed one.
    expect(sent.subject).toContain(`No. ${response.body.seat}`);
    expect(sent.textBody).toContain(`You're No. ${response.body.seat}.`);
  });

  /**
   * THE ABUSE CASE. A resubmit is a deliberate success that returns the existing
   * seat, so without this the endpoint is a mailer: put someone else's address in
   * the box, submit repeatedly, and every one lands in their inbox from us.
   *
   * Asserting on the CALL, not the response — the response is identical either
   * way, by design, so only the absence of a send proves it.
   */
  it('sends nothing at all when the address is already on the list', async () => {
    joinedAnswers = [{ data: { created_at: JOINED }, error: null }];

    const response = await httpRequest('post', '/api/waitlist').send({ email: EMAIL });

    expect(response.status).toBe(201);
    expect(sendSystemEmail).not.toHaveBeenCalled();
    // And the response gives nothing away about which case this was.
    expect(response.body).toEqual({ seat: expect.any(Number), count: expect.any(Number) });
  });

  /**
   * Two submits of the same NEW address racing: both read a miss, both reach the
   * upsert, one inserts and one conflicts. The one that conflicted returns no row
   * and must not also send — one signup, one note.
   */
  it('sends nothing when another request won the race to insert', async () => {
    upsertReturnedRow = false;
    joinedAnswers = [
      { data: null, error: null },
      { data: { created_at: JOINED }, error: null }
    ];

    const response = await httpRequest('post', '/api/waitlist').send({ email: EMAIL });

    expect(response.status).toBe(201);
    expect(sendSystemEmail).not.toHaveBeenCalled();
  });
});
