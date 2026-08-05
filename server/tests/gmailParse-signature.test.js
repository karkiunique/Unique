import { describe, it, expect } from 'vitest';

// gmailParse.js is a pure module — no googleapis/supabase mocking needed here.
import { stripSignature, cleanEmailBody } from '../src/services/gmailParse.js';

const lines = (...parts) => parts.join('\n');

describe('stripSignature — signature block under a closing line', () => {
  // The real defect: this block survived ingestion and was captured verbatim as a
  // "sign-off style", which then went into every generation prompt.
  it('drops the name/title/company/url block but KEEPS the closing line', () => {
    const raw = lines(
      'Hi Sam,',
      '',
      'Great meeting you yesterday. I will send the deck over tonight.',
      '',
      'Best,',
      'Unique Karki',
      'Founder, WitWeb',
      'witweb.org'
    );

    const result = stripSignature(raw);

    expect(result).toBe(
      lines('Hi Sam,', '', 'Great meeting you yesterday. I will send the deck over tonight.', '', 'Best,')
    );
    // "Best," is genuine voice and feeds signoff_styles — it must survive.
    expect(result.endsWith('Best,')).toBe(true);
    expect(result).not.toContain('Unique Karki');
    expect(result).not.toContain('Founder, WitWeb');
    expect(result).not.toContain('witweb.org');
  });

  // Replaces the old "drops a bare name under a closing" expectation. A lone capitalised
  // short line is indistinguishable from short declarative prose ("Docs are attached."),
  // and the profile schema literally targets "short punchy 5-12 word sentences" — so
  // shape alone can never authorise a cut. A surviving name is noise; deleted prose is
  // silent data loss.
  it('does not cut a lone bare name under a closing — shape alone is not evidence', () => {
    const raw = lines('Hi Ken,', '', 'Sending the notes now.', '', 'Thanks,', 'Unique');

    expect(stripSignature(raw)).toBe(raw);
  });

  it('drops a block ending in a bare name when a title line sits above it', () => {
    const raw = lines(
      'Hi Ken,',
      '',
      'Sending the notes now.',
      '',
      'Thanks,',
      'Head of Growth, Acme',
      'Unique'
    );

    const result = stripSignature(raw);

    expect(result).toBe(lines('Hi Ken,', '', 'Sending the notes now.', '', 'Thanks,'));
    expect(result).not.toContain('Head of Growth');
    expect(result).not.toContain('Unique');
  });

  it('handles a multi-word closing plus a title and phone block', () => {
    const raw = lines(
      'Hi Sam,',
      '',
      'Deck attached.',
      '',
      'Best regards,',
      'Ana Silva',
      'Head of Growth',
      '+1 415 555 0132'
    );

    const result = stripSignature(raw);

    expect(result).toBe(lines('Hi Sam,', '', 'Deck attached.', '', 'Best regards,'));
    expect(result).not.toContain('555');
  });
});

describe('stripSignature — short prose under a closing is not a signature block', () => {
  it('keeps a short capitalised sentence under a one-word closing', () => {
    const raw = 'Hey Ana,\n\nThanks!\nDocs are attached.';

    const result = stripSignature(raw);

    expect(result).toBe(raw);
    expect(result).toContain('Docs are attached.');
  });

  it('keeps several short punchy sentences under a closing-shaped opener', () => {
    const raw = "Hi Sam,\n\nThanks Sam\nI'll review the doc tonight.\nCall you tomorrow.";

    const result = stripSignature(raw);

    expect(result).toBe(raw);
    expect(result).toContain("I'll review the doc tonight.");
    expect(result).toContain('Call you tomorrow.');
  });
});

describe('stripSignature — postscripts are prose, never signature', () => {
  it('keeps a P.S. sitting below the sign-off', () => {
    const raw = 'Hi Sam,\n\nCongrats on the raise.\n\nBest,\nUnique\n\nP.S. Deck attached.';

    const result = stripSignature(raw);

    expect(result).toBe(raw);
    expect(result).toContain('P.S. Deck attached.');
    expect(result).toContain('Unique');
  });

  it('refuses the cut entirely when a P.S. follows a real signature block', () => {
    // Cutting at the closing would take every trailing line, P.S. included. Keeping a
    // signature is cheap; deleting a postscript is not.
    const raw = lines(
      'Hi Sam,',
      '',
      'Deck attached.',
      '',
      'Best,',
      'Unique Karki',
      'witweb.org',
      '',
      'P.S. call me friday.'
    );

    const result = stripSignature(raw);

    expect(result).toBe(raw);
    expect(result).toContain('P.S. call me friday.');
  });

  it.each([['PS: one more thing'], ['PS one more thing'], ['p.s. one more thing']])(
    'keeps a trailing "%s" line',
    (postscript) => {
      const raw = lines('Hi Sam,', '', 'Deck attached.', '', 'Thanks,', postscript);

      expect(stripSignature(raw)).toBe(raw);
    }
  );
});

describe('stripSignature — bare domains', () => {
  it('treats a bare domain on its own line as signature material', () => {
    expect(stripSignature(lines('hey Sam', '', 'the deck is attached', '', 'witweb.org'))).toBe(
      lines('hey Sam', '', 'the deck is attached')
    );
  });

  it('treats a short bare-domain tld like .io as signature material', () => {
    expect(stripSignature(lines('hey Sam', '', 'lets talk friday', '', 'Ana Silva', 'acme.io'))).toBe(
      lines('hey Sam', '', 'lets talk friday', '', 'Ana Silva')
    );
  });

  it('handles a multi-part tld', () => {
    expect(stripSignature(lines('hey Sam', '', 'notes attached', '', 'example.co.uk'))).toBe(
      lines('hey Sam', '', 'notes attached')
    );
  });
});

describe('stripSignature — a domain inside prose is never a signature', () => {
  it('keeps a one-line body that mentions a domain', () => {
    expect(stripSignature('check out acme.io')).toBe('check out acme.io');
  });

  it('keeps a labelled domain line', () => {
    const raw = 'Hey Sam,\n\nDetails: witweb.org';

    const result = stripSignature(raw);

    expect(result).toBe(raw);
    expect(result).toContain('Details: witweb.org');
  });

  it('keeps a short sentence that ends in a domain', () => {
    const raw = 'hey Sam\n\nthe deck is ready\nSee acme.com';

    const result = stripSignature(raw);

    expect(result).toBe(raw);
    expect(result).toContain('See acme.com');
  });
});

describe('stripSignature — never deletes the whole body', () => {
  // fetchSentEmails drops messages whose cleaned body is empty, so an over-strip that
  // empties the body deletes the email from the voice corpus with no trace.
  it('keeps a body that is nothing but a bare domain', () => {
    expect(stripSignature('witweb.org')).toBe('witweb.org');
  });

  it('keeps a body that is nothing but signature-shaped lines', () => {
    const raw = lines('+1 415 555 0132', 'https://acme.com');

    expect(stripSignature(raw)).toBe(raw);
  });

  it("keeps a body that is nothing but a '--' delimiter block", () => {
    const raw = lines('--', 'Ana Silva', 'acme.com');

    expect(stripSignature(raw)).toBe(raw);
  });

  it('still returns an empty string for a blank body', () => {
    expect(stripSignature('')).toBe('');
    expect(stripSignature('   \n\n  ')).toBe('');
  });
});

describe('stripSignature — existing paths still work', () => {
  it("drops everything after a '--' delimiter line", () => {
    const raw = lines('hey Sam', '', 'lets talk friday', '', '--', 'Ana Silva', 'Head of Growth', 'Acme');

    expect(stripSignature(raw)).toBe(lines('hey Sam', '', 'lets talk friday'));
  });

  it("lets the '--' delimiter win over the closing-line path", () => {
    const raw = lines('hey Sam', '', 'Best,', '', '--', 'Ana Silva', 'acme.com');

    expect(stripSignature(raw)).toBe(lines('hey Sam', '', 'Best,'));
  });

  it('still drops trailing phone and schemed-url lines with no closing present', () => {
    const raw = lines('hey Sam', '', 'lets talk friday', '', 'Ana Silva', '+1 415 555 0132', 'https://acme.com');

    const result = stripSignature(raw);

    expect(result).toBe(lines('hey Sam', '', 'lets talk friday', '', 'Ana Silva'));
    expect(result).not.toContain('555');
    expect(result).not.toContain('acme.com');
  });

  it('keeps a body with no signature at all', () => {
    expect(stripSignature(lines('hey Sam', '', 'lets talk friday'))).toBe(
      lines('hey Sam', '', 'lets talk friday')
    );
    expect(stripSignature('quick note on the roadmap for next quarter')).toBe(
      'quick note on the roadmap for next quarter'
    );
  });
});

describe('stripSignature — over-strip guards (abbreviations and numbers)', () => {
  // Each token below is the ENTIRE trailing line, so the bare-domain regex is what
  // decides — no token-count gate can wave it through. Its guards are on trial here:
  // 2+ char labels, a lowercase 2-6 letter tld, and the whole line matched end to end.
  it.each([['etc.'], ['U.S.'], ['e.g.'], ['i.e.'], ['friday.'], ['know.Thanks'], ['10.5']])(
    'does not treat the standalone token "%s" as a bare domain',
    (token) => {
      const raw = lines('hey Sam', '', 'the deck is ready', token);

      expect(stripSignature(raw)).toBe(raw);
    }
  );

  it('does not treat prose abbreviations as a bare domain', () => {
    const raw = lines('hey Sam', '', 'we ship to the U.S. and canada,', 'etc.');

    expect(stripSignature(raw)).toBe(raw);
  });

  it.each([
    ['e.g. tuesday'],
    ['i.e. tomorrow'],
    ['etc. tuesday'],
    ['the U.S. team'],
    ['ok, e.g. friday']
  ])('leaves a short line containing %s alone', (tail) => {
    const raw = lines('hey Sam', '', tail);

    expect(stripSignature(raw)).toBe(raw);
  });

  it('does not treat a sentence-ending period as a bare domain', () => {
    expect(stripSignature(lines('hey Sam', '', 'lets talk friday.'))).toBe(
      lines('hey Sam', '', 'lets talk friday.')
    );
    expect(stripSignature(lines('hey Sam', '', 'lets talk. call me.'))).toBe(
      lines('hey Sam', '', 'lets talk. call me.')
    );
  });

  it('does not treat a decimal number as a bare domain', () => {
    expect(stripSignature(lines('hey Sam', '', 'about 3.5 hours'))).toBe(
      lines('hey Sam', '', 'about 3.5 hours')
    );
    expect(stripSignature(lines('hey Sam', '', 'version 10.5 ships'))).toBe(
      lines('hey Sam', '', 'version 10.5 ships')
    );
  });

  it('leaves a domain mentioned inside a prose sentence alone', () => {
    // Short lines on purpose: nothing here is saved by a length or token threshold, the
    // line has to fail the bare-domain test on its own merits.
    expect(stripSignature(lines('hey Sam', '', 'check out acme.com'))).toBe(
      lines('hey Sam', '', 'check out acme.com')
    );
    expect(stripSignature(lines('hey Sam', '', 'Details: witweb.org'))).toBe(
      lines('hey Sam', '', 'Details: witweb.org')
    );
  });
});

describe('stripSignature — over-strip guards (closing-word false positives)', () => {
  it('does not truncate when "Thanks" opens a sentence mid-body', () => {
    const raw = lines(
      'hey Sam',
      '',
      'Thanks for the intro.',
      '',
      'I read the deck.',
      '',
      'Grab twenty minutes Thursday?'
    );

    expect(stripSignature(raw)).toBe(raw);
  });

  it('does not truncate when a real closing is followed by real sentences', () => {
    // Deliberately SHORT lines — well inside the block shape limits — so the only thing
    // keeping them is the absence of a strong signature signal, not a length threshold.
    const raw = lines('Thanks Sam', '', 'I read the deck.', '', 'Can we grab twenty minutes?');

    expect(stripSignature(raw)).toBe(raw);
  });

  it('does not treat a closing word followed by lowercase prose as a closing', () => {
    const raw = lines('hey Sam', '', 'Thanks for the intro', 'here is the deck', 'let me know');

    expect(stripSignature(raw)).toBe(raw);
  });

  it('does not strip a trailing block longer than 4 lines', () => {
    const raw = lines(
      'hey Sam',
      '',
      'Best,',
      'Line one',
      'Line two',
      'Line three',
      'Line four',
      'Line five'
    );

    const result = stripSignature(raw);

    expect(result).toBe(raw);
    expect(result).toContain('Line five');
    expect(result).toContain('Best,');
  });

  it('never strips a closing that is the last line', () => {
    expect(stripSignature(lines('hey Sam', '', 'deck attached', '', 'Best,'))).toBe(
      lines('hey Sam', '', 'deck attached', '', 'Best,')
    );
  });
});

describe('cleanEmailBody — composition', () => {
  it('strips the quoted reply first, then the signature block under the closing', () => {
    const raw = lines(
      'Hi Sam,',
      '',
      'Great meeting you yesterday.',
      '',
      'Best,',
      'Unique Karki',
      'Founder, WitWeb',
      'witweb.org',
      '',
      'On Mon, 3 Feb 2025 at 09:12, Sam Rivera <sam@acme.com> wrote:',
      '> the original question'
    );

    const result = cleanEmailBody(raw);

    expect(result).toBe(lines('Hi Sam,', '', 'Great meeting you yesterday.', '', 'Best,'));
    expect(result).not.toContain('witweb.org');
    expect(result).not.toContain('the original question');
  });

  it('leaves an email with no signature unchanged', () => {
    expect(cleanEmailBody(lines('hey Sam', '', 'following up on the deck'))).toBe(
      lines('hey Sam', '', 'following up on the deck')
    );
  });
});
