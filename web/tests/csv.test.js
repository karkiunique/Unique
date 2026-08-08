import { describe, it, expect } from 'vitest';

import {
  LEAD_FIELDS,
  decodeCsvFile,
  guessMapping,
  normaliseHeader,
  parseCsv,
  partitionRows,
  toRows
} from '../src/lib/csv.js';

/**
 * The parsing layer, against the files people actually upload.
 *
 * A suite that only exercises a tidy comma-separated file proves nothing: the
 * interesting cases are a byte-order mark that silently corrupts the first
 * column, an Excel export in windows-1252, columns in a different order under
 * different names, and rows that do not agree with the heading row. Each of
 * those has its own test below.
 */

const BOM_BYTES = [0xef, 0xbb, 0xbf];
const BOM_CHAR = String.fromCharCode(0xfeff);

function utf8Bytes(text) {
  return new TextEncoder().encode(text);
}

/** windows-1252 / latin-1: one byte per character, code point as-is. */
function latin1Bytes(text) {
  const bytes = new Uint8Array(text.length);
  for (let at = 0; at < text.length; at += 1) bytes[at] = text.charCodeAt(at) & 0xff;

  return bytes;
}

function prefixBom(bytes) {
  const out = new Uint8Array(bytes.length + BOM_BYTES.length);
  out.set(BOM_BYTES, 0);
  out.set(bytes, BOM_BYTES.length);

  return out;
}

/** Parse and map in one go, the way the page does. */
function leadsFrom(text) {
  const parsed = parseCsv(text);

  return toRows(parsed.rows, guessMapping(parsed.headers));
}

describe('decodeCsvFile — the byte-order mark', () => {
  it('takes the mark off at the BYTE level, so it is gone whichever decoder then runs', () => {
    // Two files carrying the same leading EF BB BF, one body valid UTF-8 and one
    // windows-1252. The strip has to happen before the encoding is chosen,
    // because only one of the two decoders would have dealt with it: the
    // windows-1252 fallback renders those three bytes as three visible
    // characters and hangs them on the first header name.
    const files = [
      prefixBom(utf8Bytes('Email,First Name\nsam@corp.com,Sam\n')),
      prefixBom(latin1Bytes('Email,First Name\nsam@corp.com,René\n'))
    ];

    for (const bytes of files) {
      const decoded = decodeCsvFile(bytes);
      const parsed = parseCsv(decoded);

      expect(decoded.startsWith(BOM_CHAR)).toBe(false);
      expect(decoded.startsWith('Email')).toBe(true);
      expect(parsed.headers[0]).toBe('Email');
      expect(parsed.rows[0].Email).toBe('sam@corp.com');
      expect(guessMapping(parsed.headers).email).toBe('Email');
    }

    // The negative control belongs on the fallback path and ONLY there. On the
    // UTF-8 path nothing above would notice the strip going missing: TextDecoder
    // has ignoreBOM=false and removes U+FEFF itself, and papaparse strips a
    // leading U+FEFF from a string too. The second file is what makes this test
    // bite — decoded as windows-1252 with the bytes left on, its first header is
    // mojibake and matches no column.
    const unstripped = new TextDecoder('windows-1252').decode(files[1]);

    expect(unstripped.startsWith('ï»¿')).toBe(true);
    expect(parseCsv(unstripped).headers[0]).not.toBe('Email');
  });

  it('takes the BOM off before the windows-1252 fallback, where it would become mojibake', () => {
    // A file marked UTF-8 but written in a legacy encoding is a real Excel
    // export, not a contrivance: the fallback decoder renders EF BB BF as three
    // visible characters, so the strip has to happen at the byte level first.
    const csv = 'Email,First Name\nsam@corp.com,René\n';
    const bytes = prefixBom(latin1Bytes(csv));

    const parsed = parseCsv(decodeCsvFile(bytes));

    expect(parsed.headers[0]).toBe('Email');
    expect(guessMapping(parsed.headers).email).toBe('Email');
    expect(parsed.rows[0]['First Name']).toBe('René');

    const broken = parseCsv(new TextDecoder('windows-1252').decode(bytes));

    expect(broken.headers[0]).not.toBe('Email');
    expect(guessMapping(broken.headers).email).toBeUndefined();
  });
});

describe('decodeCsvFile — encoding', () => {
  it('decodes a windows-1252 file to the right characters rather than mojibake', () => {
    const csv = 'Email,First Name,Company\nsam@corp.com,Renée,Côté & Frères\n';

    const decoded = decodeCsvFile(latin1Bytes(csv));

    expect(decoded).toBe(csv);
    expect(leadsFrom(decoded)[0]).toEqual({
      email: 'sam@corp.com',
      first_name: 'Renée',
      company: 'Côté & Frères'
    });
  });

  it('does not mistake valid multi-byte UTF-8 for latin-1', () => {
    const csv = 'Email,First Name,Company\nsam@corp.com,Renée,Fünf 東京 — GmbH\n';

    const decoded = decodeCsvFile(utf8Bytes(csv));

    expect(decoded).toBe(csv);
    // The tell-tale of a UTF-8 file read as latin-1.
    expect(decoded).not.toContain('Ã');
    expect(leadsFrom(decoded)[0].company).toBe('Fünf 東京 — GmbH');
  });

  it('accepts an ArrayBuffer as well as a byte view, and an empty file as empty text', () => {
    const bytes = utf8Bytes('Email\nsam@corp.com\n');

    expect(decodeCsvFile(bytes.slice().buffer)).toBe('Email\nsam@corp.com\n');
    expect(decodeCsvFile(new Uint8Array(0))).toBe('');
  });
});

describe('normaliseHeader', () => {
  it('reduces one column name written every which way to a single key', () => {
    for (const name of ['First Name', 'first_name', 'FIRST-NAME', '  first   name  ', 'First-Name']) {
      expect(normaliseHeader(name)).toBe('first name');
    }

    expect(normaliseHeader(' Email ')).toBe('email');
    expect(normaliseHeader(`${BOM_CHAR}Email`)).toBe('email');
    expect(normaliseHeader(null)).toBe('');
    expect(normaliseHeader(undefined)).toBe('');
  });
});

describe('guessMapping', () => {
  it('maps by name, so the column order makes no difference', () => {
    const inOneOrder = 'Email,First Name,Company\nsam@corp.com,Sam,Corp\n';
    const inAnother = 'Company,Email,First Name\nCorp,sam@corp.com,Sam\n';

    expect(leadsFrom(inAnother)).toEqual(leadsFrom(inOneOrder));
    expect(leadsFrom(inOneOrder)).toEqual([
      { email: 'sam@corp.com', first_name: 'Sam', company: 'Corp' }
    ]);
  });

  it('recognises the names the same columns are given in the wild', () => {
    // Deliberately NOT in LEAD_FIELDS order. Listed in that order, mapping by
    // name and mapping by column position would agree and the test would prove
    // neither; shuffled, only name-matching gets this right.
    const csv =
      'Job Title,LAST-NAME,LinkedIn,E-mail,Company Name,first name\n' +
      'Head of Ops,Rivera,https://linkedin.com/in/sam,sam@corp.com,Corp Ltd,Sam\n';

    const { headers } = parseCsv(csv);

    expect(guessMapping(headers)).toEqual({
      email: 'E-mail',
      first_name: 'first name',
      last_name: 'LAST-NAME',
      company: 'Company Name',
      title: 'Job Title',
      linkedin_url: 'LinkedIn'
    });
  });

  it('maps a header padded with spaces', () => {
    const csv = ' Email , First Name \nsam@corp.com,Sam\n';
    const { headers } = parseCsv(csv);

    // The raw name is kept as the key, because it is also the row's key.
    expect(guessMapping(headers)).toEqual({ email: ' Email ', first_name: ' First Name ' });
    expect(leadsFrom(csv)).toEqual([{ email: 'sam@corp.com', first_name: 'Sam' }]);
  });

  it('reports no email column when the file simply has not got one', () => {
    const csv = 'Name,Company,Notes\nSam,Corp,called twice\n';
    const parsed = parseCsv(csv);
    const mapping = guessMapping(parsed.headers);

    expect(mapping.email).toBeUndefined();

    // Nothing is uploadable, and the rows are still counted rather than vanished.
    const { ready, missingEmail } = partitionRows(toRows(parsed.rows, mapping));
    expect(ready).toEqual([]);
    expect(missingEmail).toHaveLength(1);
  });

  it('never gives one column to two fields', () => {
    const { headers } = parseCsv('Email,Last\nsam@corp.com,Rivera\n');
    const mapping = guessMapping(headers);
    const claimed = LEAD_FIELDS.map((field) => mapping[field.key]).filter(Boolean);

    expect(new Set(claimed).size).toBe(claimed.length);
  });
});

describe('toRows', () => {
  it('ignores the columns nobody mapped', () => {
    const csv =
      'Email,Salary,Notes,Company\nsam@corp.com,120000,called twice keen,Corp\n';

    const rows = leadsFrom(csv);

    expect(rows).toEqual([{ email: 'sam@corp.com', company: 'Corp' }]);
    expect(Object.keys(rows[0])).not.toContain('Salary');
    expect(JSON.stringify(rows)).not.toContain('120000');
    expect(JSON.stringify(rows)).not.toContain('called twice');
  });

  it('trims every value it takes', () => {
    const csv = 'Email,First Name,Company\n  sam@corp.com  ,  Sam  ,  Corp Ltd  \n';

    expect(leadsFrom(csv)).toEqual([
      { email: 'sam@corp.com', first_name: 'Sam', company: 'Corp Ltd' }
    ]);
  });

  it('follows a column re-mapped by hand rather than the guess', () => {
    const parsed = parseCsv('Contact,Company\nsam@corp.com,Corp\n');

    expect(guessMapping(parsed.headers).email).toBeUndefined();
    expect(toRows(parsed.rows, { email: 'Contact' })).toEqual([{ email: 'sam@corp.com' }]);
  });
});

describe('parseCsv — rows that do not agree with the heading row', () => {
  it('reports a row with too few fields and still keeps the rest of the file', () => {
    const csv = 'Email,First Name,Company\nsam@corp.com,Sam,Corp\nlee@corp.com\n';
    const parsed = parseCsv(csv);

    expect(parsed.errors.map((issue) => issue.code)).toContain('TooFewFields');
    expect(parsed.rows).toHaveLength(2);
    expect(leadsFrom(csv)).toEqual([
      { email: 'sam@corp.com', first_name: 'Sam', company: 'Corp' },
      { email: 'lee@corp.com' }
    ]);
  });

  it('reports a row with too many fields and drops only the overflow', () => {
    const csv = 'Email,First Name\nsam@corp.com,Sam,stray,columns\n';
    const parsed = parseCsv(csv);

    expect(parsed.errors.map((issue) => issue.code)).toContain('TooManyFields');
    expect(leadsFrom(csv)).toEqual([{ email: 'sam@corp.com', first_name: 'Sam' }]);
    expect(JSON.stringify(leadsFrom(csv))).not.toContain('stray');
  });

  it('reports an unbalanced quote instead of throwing on it', () => {
    const csv = 'Email,Company\nsam@corp.com,"Corp Ltd\nlee@corp.com,Other\n';
    const parsed = parseCsv(csv);

    const quoteIssue = parsed.errors.find((issue) => issue.code === 'MissingQuotes');
    expect(quoteIssue?.message).toBe('This row has a quote that is never closed.');
    // Whatever could be read was still read: the file is not lost wholesale.
    expect(parsed.rows[0].Email).toBe('sam@corp.com');
  });

  it('keeps commas and newlines that live inside a quoted field', () => {
    const csv =
      'Email,Company,Title\nsam@corp.com,"Corp, Ltd","Head of Ops,\nEurope"\nlee@corp.com,Other,Analyst\n';
    const parsed = parseCsv(csv);

    expect(parsed.errors).toEqual([]);
    expect(leadsFrom(csv)).toEqual([
      { email: 'sam@corp.com', company: 'Corp, Ltd', title: 'Head of Ops,\nEurope' },
      { email: 'lee@corp.com', company: 'Other', title: 'Analyst' }
    ]);
  });
});

describe('parseCsv — files with nothing in them', () => {
  it('says an empty file is empty', () => {
    for (const text of ['', '   ', '\n\n', null, undefined]) {
      const parsed = parseCsv(text);

      expect(parsed.headers).toEqual([]);
      expect(parsed.rows).toEqual([]);
      expect(parsed.errors).toEqual([
        {
          code: 'empty_file',
          row: null,
          message: 'This file is empty — there is nothing to read.'
        }
      ]);
    }
  });

  it('says a headings-only file has no rows, which is a different problem', () => {
    const parsed = parseCsv('Email,First Name,Company\n');

    expect(parsed.headers).toEqual(['Email', 'First Name', 'Company']);
    expect(parsed.rows).toEqual([]);

    const noRows = parsed.errors.find((issue) => issue.code === 'no_rows');
    expect(noRows?.message).toBe('This file has column headings but no rows under them.');
  });
});

describe('partitionRows', () => {
  it('separates the rows with no email rather than dropping them', () => {
    const csv = 'Email,First Name\nsam@corp.com,Sam\n,Lee\n   ,Nur\nlee@corp.com,Lee\n';
    const rows = leadsFrom(csv);
    const { ready, missingEmail } = partitionRows(rows);

    // Four rows in, four rows accounted for.
    expect(rows).toHaveLength(4);
    expect(ready).toEqual([
      { email: 'sam@corp.com', first_name: 'Sam' },
      { email: 'lee@corp.com', first_name: 'Lee' }
    ]);
    expect(missingEmail.map((entry) => entry.index)).toEqual([1, 2]);
  });

  it('copes with nothing at all', () => {
    expect(partitionRows(null)).toEqual({ ready: [], missingEmail: [] });
    expect(partitionRows([])).toEqual({ ready: [], missingEmail: [] });
  });
});
