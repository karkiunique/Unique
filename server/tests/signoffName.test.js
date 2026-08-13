import { describe, it, expect } from 'vitest';

import { findMissingSignoff, signoffNameForms } from '../src/services/signoff.js';

/**
 * THE SIGN-OFF NAME (CLAUDE.md, Decisions 2026-08-13).
 *
 * The gap this closes: findMissingSignoff() could only match a closing against
 * `signoff_styles`, so it returned "no violation" for a user who had none. A
 * brand-new user has none — and usually no exemplars either — so the guarantee
 * that every email signs off as its sender held for established accounts and
 * silently did not hold for first-time senders. An unsigned letter went out under
 * their own name with nothing recorded.
 *
 * `profiles.full_name` is now the floor and applies to EVERY user. Style matching
 * stays on top of it, unchanged (signoff.test.js pins that half).
 *
 * Pure: no model, no database, no clock.
 */

const NAME = 'Unique Karki';
const FIRST_NAME = 'Unique';
const SURNAME = 'Karki';

/** The day-one user: the profile row exists and says nothing about anyone. */
const NEW_USER_PROFILE = {};
const ESTABLISHED_PROFILE = { signoff_styles: ['thanks,', 'cheers —'] };

const UNSIGNED = { subject: 'about the launch', body: 'hey Sam\n\nworth 15 minutes next week?' };

function body(text) {
  return { subject: 'about the launch', body: text };
}

describe('the new-user gap: a sign-off is enforced with no signoff_styles at all', () => {
  /**
   * THE ASSERTION THIS FILE EXISTS FOR. No styles, no exemplars, no closing —
   * and this must be a violation, because today it was silently not one.
   */
  it('flags an unsigned draft from a brand-new user with no styles and no exemplars', () => {
    const violations = findMissingSignoff(UNSIGNED, NEW_USER_PROFILE, NAME);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/name/i);
  });

  it('raises no violation when that same new user signs the draft', () => {
    const signed = body(`hey Sam\n\nworth 15 minutes next week?\n\nthanks,\n${FIRST_NAME}`);

    expect(findMissingSignoff(signed, NEW_USER_PROFILE, NAME)).toEqual([]);
  });

  it('flags a new user\'s draft that closes but signs nobody', () => {
    // The exact failure the stripped signature blocks invite, now caught for a
    // user whose profile cannot say what their closing looks like.
    expect(findMissingSignoff(body('hey Sam\n\nworth 15?\n\nthanks,'), {}, NAME)).toHaveLength(1);
  });

  it('flags a draft signed with somebody else\'s name, even when the closing matches', () => {
    const wrongSignature = body('hey Sam\n\nworth 15?\n\nthanks,\nSam');
    const violations = findMissingSignoff(wrongSignature, ESTABLISHED_PROFILE, NAME);

    // The closing IS one of theirs, so style matching alone passed this draft.
    expect(findMissingSignoff(wrongSignature, ESTABLISHED_PROFILE)).toEqual([]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/name/i);
  });

  it('reports the name and the style separately when a draft misses both', () => {
    const violations = findMissingSignoff(UNSIGNED, ESTABLISHED_PROFILE, NAME);

    expect(violations).toHaveLength(2);
  });
});

/**
 * The rule: the WHOLE name, or the FIRST name on its own, as a whole word in the
 * sign-off region. People sign cold email with their first name, so demanding the
 * full name would flag the most ordinary sign-off there is; accepting any token
 * of it would let almost any tail pass.
 */
describe('what counts as signing with your own name', () => {
  const accepted = [
    ['the first name alone, as most people sign', `thanks,\n${FIRST_NAME}`],
    ['the full name', `thanks,\n${NAME}`],
    ['closing and name on one line', `thanks, ${FIRST_NAME}`],
    ['a dash before the name', `worth a look?\n\n— ${FIRST_NAME}`],
    ['a different case from the profile', `THANKS,\n${FIRST_NAME.toUpperCase()}`]
  ];

  for (const [label, tail] of accepted) {
    it(`accepts ${label}`, () => {
      expect(findMissingSignoff(body(`hey Sam\n\nworth 15?\n\n${tail}`), {}, NAME)).toEqual([]);
    });
  }

  it('does not accept the surname on its own', () => {
    expect(findMissingSignoff(body(`hey Sam\n\nworth 15?\n\nthanks,\n${SURNAME}`), {}, NAME))
      .toHaveLength(1);
  });

  it('does not accept the name buried inside a longer word', () => {
    // "uniquely" contains "unique"; a substring match would have passed this.
    expect(findMissingSignoff(body('hey Sam\n\nworth 15?\n\nuniquely yours'), {}, NAME))
      .toHaveLength(1);
  });

  it('reads only the sign-off region, not the whole letter', () => {
    const nameFarAbove = [
      `hey Sam, ${FIRST_NAME} here.`,
      'line two',
      'line three',
      'line four',
      'line five',
      'worth 15 minutes next week?'
    ].join('\n\n');

    expect(findMissingSignoff(body(nameFarAbove), {}, NAME)).toHaveLength(1);
  });

  it('offers the whole name and the first name as the forms it will match', () => {
    expect(signoffNameForms(NAME)).toEqual([NAME, FIRST_NAME]);
    expect(signoffNameForms('Prince')).toEqual(['Prince']);
    // A single initial matches too much ordinary prose to stand as a signature.
    expect(signoffNameForms('A Karki')).toEqual(['A Karki']);
  });
});

describe('a null name never throws and never blocks', () => {
  const ABSENT = [undefined, null, '', '   ', 42, {}, []];

  /**
   * A pre-006 account has no name and cannot be given one retroactively. Until
   * they answer the login prompt they get exactly today's behaviour — which is
   * safe, because an established account is the one that HAS signoff_styles.
   */
  it('falls back to style matching for an account with no name', () => {
    for (const senderName of ABSENT) {
      expect(() => findMissingSignoff(UNSIGNED, ESTABLISHED_PROFILE, senderName)).not.toThrow();
      // Exactly one violation: the style one. Never a name violation it cannot make.
      expect(findMissingSignoff(UNSIGNED, ESTABLISHED_PROFILE, senderName)).toEqual(
        findMissingSignoff(UNSIGNED, ESTABLISHED_PROFILE)
      );
      expect(findMissingSignoff(UNSIGNED, ESTABLISHED_PROFILE, senderName)).toHaveLength(1);
    }
  });

  it('blocks nothing at all when there is neither a name nor a style', () => {
    for (const senderName of ABSENT) {
      expect(findMissingSignoff(UNSIGNED, {}, senderName)).toEqual([]);
      expect(findMissingSignoff(UNSIGNED, null, senderName)).toEqual([]);
    }

    expect(signoffNameForms(undefined)).toEqual([]);
    expect(signoffNameForms(null)).toEqual([]);
    expect(signoffNameForms(7)).toEqual([]);
  });

  it('never throws on a malformed draft, whatever the name is', () => {
    for (const draft of [undefined, null, {}, { body: 42 }, { body: '   ' }]) {
      expect(() => findMissingSignoff(draft, {}, NAME)).not.toThrow();
      expect(findMissingSignoff(draft, {}, NAME)).toEqual([]);
    }
  });

  it('survives a name made of regular-expression characters', () => {
    const awkward = 'A.*(Name)';

    expect(() => findMissingSignoff(UNSIGNED, {}, awkward)).not.toThrow();
    // Escaped, not compiled: ".*" must not match the whole tail.
    expect(findMissingSignoff(UNSIGNED, {}, awkward)).toHaveLength(1);
    expect(findMissingSignoff(body(`worth 15?\n\nthanks,\n${awkward}`), {}, awkward)).toEqual([]);
  });
});

describe('the violation carries no personal data', () => {
  it('names neither the sender, the recipient nor anything from the letter', () => {
    const [violation] = findMissingSignoff(UNSIGNED, {}, NAME);

    expect(violation).not.toContain(NAME);
    expect(violation).not.toContain(FIRST_NAME);
    expect(violation).not.toContain('Sam');
    expect(violation).not.toContain('worth 15');
  });
});
