import { describe, it, expect } from 'vitest';

import { normaliseSubject, withReplyPrefix } from '../src/lib/subject.js';

/**
 * The subject shaping that has to happen BEFORE the confirmation dialog renders.
 *
 * These are the same rules the server applies on the way out to Gmail, and they
 * are duplicated here on purpose: /web cannot import from /server. The tests
 * below therefore pin the shared semantics — idempotency regardless of case, and
 * an empty subject left empty rather than turned into a bare "Re:".
 */

const SUBJECT = 'about the launch';

describe('normaliseSubject', () => {
  it('trims the subject the user typed', () => {
    expect(normaliseSubject('   about the launch  ')).toBe(SUBJECT);
  });

  it('leaves an already-clean subject byte-for-byte alone', () => {
    expect(normaliseSubject(SUBJECT)).toBe(SUBJECT);
  });

  it('treats whitespace-only and non-strings as no subject at all', () => {
    expect(normaliseSubject('   ')).toBe('');
    expect(normaliseSubject(undefined)).toBe('');
    expect(normaliseSubject(null)).toBe('');
    expect(normaliseSubject(42)).toBe('');
  });
});

describe('withReplyPrefix', () => {
  it('prefixes a plain thread subject once', () => {
    expect(withReplyPrefix(SUBJECT)).toBe(`Re: ${SUBJECT}`);
  });

  it('trims before prefixing, so the result carries no stray whitespace', () => {
    expect(withReplyPrefix('  about the launch \n')).toBe(`Re: ${SUBJECT}`);
  });

  /** The case that would otherwise stack "Re: Re: Re:" down a long thread. */
  it('leaves an already-prefixed subject alone, whatever its casing', () => {
    expect(withReplyPrefix('Re: about the launch')).toBe('Re: about the launch');
    expect(withReplyPrefix('RE: about the launch')).toBe('RE: about the launch');
    expect(withReplyPrefix('re:about the launch')).toBe('re:about the launch');
    expect(withReplyPrefix('Re : about the launch')).toBe('Re : about the launch');
  });

  it('is idempotent — applying it twice changes nothing', () => {
    expect(withReplyPrefix(withReplyPrefix(SUBJECT))).toBe(withReplyPrefix(SUBJECT));
  });

  /** "Re" has to be the whole word before the colon, or "Reply: x" gets eaten. */
  it('does not mistake a word starting with "re" for the prefix', () => {
    expect(withReplyPrefix('Reply: about the launch')).toBe('Re: Reply: about the launch');
    expect(withReplyPrefix('Reminder about the launch')).toBe('Re: Reminder about the launch');
  });

  it('never invents a bare "Re:" out of an empty subject', () => {
    expect(withReplyPrefix('')).toBe('');
    expect(withReplyPrefix('   ')).toBe('');
    expect(withReplyPrefix(undefined)).toBe('');
  });
});
