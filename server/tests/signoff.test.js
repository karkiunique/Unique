import { describe, it, expect } from 'vitest';

import { signoffStyles, findMissingSignoff } from '../src/services/signoff.js';

/**
 * The sign-off guardrail. A cold email that arrives unsigned, or signed with a
 * closing the user never uses, is not in their voice — and it goes out under
 * their own name.
 */

const PROFILE = { signoff_styles: ['thanks,', 'cheers —'] };
const UNSUBSCRIBE =
  "\n\nDon't want emails from me? [Unsubscribe](http://localhost:5173/u/abc.def)";

function body(text) {
  return { subject: 'about the launch', body: text };
}

describe('signoffStyles', () => {
  it('returns the user\'s own closings', () => {
    expect(signoffStyles(PROFILE)).toEqual(['thanks,', 'cheers —']);
  });

  it('survives a missing, empty or malformed list without throwing', () => {
    const malformed = [
      undefined,
      null,
      'a string',
      42,
      {},
      { signoff_styles: null },
      { signoff_styles: 'thanks,' },
      { signoff_styles: [] },
      { signoff_styles: [null, 7, {}, '', '   '] }
    ];

    for (const profileJson of malformed) {
      expect(() => signoffStyles(profileJson)).not.toThrow();
      expect(signoffStyles(profileJson)).toEqual([]);
    }
  });

  it('drops blanks but keeps the usable entries', () => {
    expect(signoffStyles({ signoff_styles: ['', '  thanks,  ', 9, 'best,'] })).toEqual([
      'thanks,',
      'best,'
    ]);
  });
});

describe('findMissingSignoff', () => {
  it('passes a body that closes and signs with a name', () => {
    expect(findMissingSignoff(body('hey Sam\n\nworth 15 minutes?\n\nthanks,\nAna'), PROFILE)).toEqual(
      []
    );
  });

  it('passes a closing and name written on one line', () => {
    expect(findMissingSignoff(body('hey Sam\n\nworth 15?\n\nthanks, Ana'), PROFILE)).toEqual([]);
  });

  it('flags a body that just stops, with no closing at all', () => {
    const hits = findMissingSignoff(body('hey Sam\n\nworth 15 minutes next week?'), PROFILE);

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/name/i);
  });

  it('flags a bare closing with no name under it', () => {
    // The exact failure the stripped signature blocks invite: "thanks," alone.
    expect(findMissingSignoff(body('hey Sam\n\nworth 15?\n\nthanks,'), PROFILE)).toHaveLength(1);
    expect(findMissingSignoff(body('hey Sam\n\nworth 15?\n\ncheers —'), PROFILE)).toHaveLength(1);
  });

  it('ignores the appended unsubscribe line when reading the tail', () => {
    const signed = `hey Sam\n\nworth 15?\n\nthanks,\nAna${UNSUBSCRIBE}`;
    const unsigned = `hey Sam\n\nworth 15 minutes next week?${UNSUBSCRIBE}`;

    // The system's own line is not the writer's sign-off, in either direction:
    // it must not satisfy the check, and it must not hide a real one.
    expect(findMissingSignoff(body(signed), PROFILE)).toEqual([]);
    expect(findMissingSignoff(body(unsigned), PROFILE)).toHaveLength(1);
  });

  it('does not block when there is nothing to match against', () => {
    const unsigned = body('hey Sam\n\nworth 15 minutes next week?');

    for (const profileJson of [undefined, null, {}, { signoff_styles: [] }, 'nope']) {
      expect(findMissingSignoff(unsigned, profileJson)).toEqual([]);
    }
  });

  it('does not block on a malformed draft', () => {
    for (const draft of [undefined, null, {}, { body: 42 }, { body: '   ' }]) {
      expect(() => findMissingSignoff(draft, PROFILE)).not.toThrow();
      expect(findMissingSignoff(draft, PROFILE)).toEqual([]);
    }
  });

  it('accepts a closing that already carries the name', () => {
    const profileJson = { signoff_styles: ['thanks,\nAna'] };

    expect(findMissingSignoff(body('hey Sam\n\nworth 15?\n\nthanks,\nAna'), profileJson)).toEqual(
      []
    );
  });

  it('accepts a one-word closing that stands on its own', () => {
    const profileJson = { signoff_styles: ['cheers'] };

    expect(findMissingSignoff(body('hey Sam\n\nworth 15?\n\ncheers'), profileJson)).toEqual([]);
  });

  it('matches case-insensitively', () => {
    expect(findMissingSignoff(body('hey Sam\n\nworth 15?\n\nThanks,\nAna'), PROFILE)).toEqual([]);
  });

  it('carries no email content in the violation it returns', () => {
    const hits = findMissingSignoff(body('hey Sam\n\nworth 15 minutes next week?'), PROFILE);

    expect(hits[0]).not.toContain('Sam');
    expect(hits[0]).not.toContain('worth 15');
  });
});
