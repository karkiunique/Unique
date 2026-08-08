import Papa from 'papaparse';

/**
 * CSV decoding, parsing and column mapping — pure functions, no React, no
 * network. Real uploaded lists are messy: they come out of Excel in a legacy
 * encoding, carry a byte-order mark, name the same column six different ways and
 * arrive with the columns in whatever order the CRM felt like. Every one of those
 * is handled here so the page stays a thin shell over it.
 *
 * Nothing in this module logs. A lead row is third-party personal data.
 */

/** The lead columns the server accepts. Order here is the preview's order. */
export const LEAD_FIELDS = [
  { key: 'email', label: 'Email', required: true },
  { key: 'first_name', label: 'First name', required: false },
  { key: 'last_name', label: 'Last name', required: false },
  { key: 'company', label: 'Company', required: false },
  { key: 'title', label: 'Title', required: false },
  { key: 'linkedin_url', label: 'LinkedIn URL', required: false }
];

export const CSV_ERROR = {
  EMPTY_FILE: 'empty_file',
  NO_ROWS: 'no_rows',
  MALFORMED_ROW: 'malformed_row'
};

/** Papaparse's own codes, in prose a user can act on. */
const PARSE_MESSAGE = {
  TooFewFields: 'This row has fewer columns than the heading row.',
  TooManyFields: 'This row has more columns than the heading row.',
  MissingQuotes: 'This row has a quote that is never closed.',
  InvalidQuotes: 'This row has a misplaced quote.',
  UndetectableDelimiter: 'The column separator could not be worked out.'
};

/**
 * Names the same column is given in the wild, in canonical (normalised) form.
 * Earlier entries win, so a file carrying both `email` and `work email` maps the
 * plain one — regardless of which column comes first.
 */
const HEADER_ALIASES = {
  email: ['email', 'email address', 'e mail', 'e mail address', 'mail', 'work email', 'contact email'],
  first_name: ['first name', 'firstname', 'given name', 'forename', 'fname', 'first'],
  last_name: ['last name', 'lastname', 'surname', 'family name', 'lname', 'last'],
  company: ['company', 'company name', 'organisation', 'organization', 'employer', 'account', 'org'],
  title: ['title', 'job title', 'jobtitle', 'position', 'role'],
  linkedin_url: ['linkedin url', 'linkedin', 'linkedin profile', 'linkedin link', 'li url']
};

const UTF8_BOM = [0xef, 0xbb, 0xbf];
// U+FEFF, built from its code point rather than typed: the literal character is
// invisible in a source file and an escape is easy to mangle in review.
const BOM_CHAR = String.fromCharCode(0xfeff);

function toBytes(source) {
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  }

  return new Uint8Array(source ?? 0);
}

function hasUtf8Bom(bytes) {
  return bytes.length >= UTF8_BOM.length && UTF8_BOM.every((byte, at) => bytes[at] === byte);
}

/**
 * File bytes -> text.
 *
 * THE BOM COMES OFF FIRST, at the byte level. An un-stripped `EF BB BF` lands on
 * the FIRST header name, which then matches nothing — and the failure reads as a
 * missing column rather than as an encoding problem, which is why it is worth
 * removing rather than tolerating. The UTF-8 decoder would drop it on its own;
 * the windows-1252 fallback below would not, and would turn it into `ï»¿`.
 *
 * THE HEURISTIC, and it stops here on purpose: decode as UTF-8 with `fatal:
 * true`, and if the bytes are not valid UTF-8 fall back to windows-1252. That is
 * Excel's default on Windows and a superset of latin-1, so the one fallback
 * covers both. We do not sniff further — a third guess trades a wrong character
 * for a wrong file, and windows-1252 decodes every byte sequence rather than
 * throwing, so there is nothing left to fall back to anyway.
 */
export function decodeCsvFile(buffer) {
  const bytes = toBytes(buffer);
  const body = hasUtf8Bom(bytes) ? bytes.subarray(UTF8_BOM.length) : bytes;

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return new TextDecoder('windows-1252').decode(body);
  }
}

function isPlainRow(row) {
  return Boolean(row) && typeof row === 'object' && !Array.isArray(row);
}

function toRowError(error) {
  const code = typeof error?.code === 'string' ? error.code : CSV_ERROR.MALFORMED_ROW;

  return {
    code,
    row: Number.isInteger(error?.row) ? error.row : null,
    message: PARSE_MESSAGE[code] ?? 'This row could not be read.'
  };
}

/**
 * Text -> `{ headers, rows, errors }`.
 *
 * Header names are returned exactly as papaparse produced them, because they are
 * also the keys of every row object — normalising one without the other would
 * quietly break every lookup. `normaliseHeader` is applied at match time instead.
 *
 * A malformed row is reported, never thrown: the rest of the file still parses.
 */
export function parseCsv(text) {
  const source = typeof text === 'string' ? text : '';

  if (source.trim() === '') {
    return {
      headers: [],
      rows: [],
      errors: [
        { code: CSV_ERROR.EMPTY_FILE, row: null, message: 'This file is empty — there is nothing to read.' }
      ]
    };
  }

  const parsed = Papa.parse(source, { header: true, skipEmptyLines: true });

  const headers = Array.isArray(parsed?.meta?.fields) ? parsed.meta.fields : [];
  const rows = (Array.isArray(parsed?.data) ? parsed.data : []).filter(isPlainRow);
  const errors = (Array.isArray(parsed?.errors) ? parsed.errors : []).map(toRowError);

  if (rows.length === 0) {
    errors.push({
      code: CSV_ERROR.NO_ROWS,
      row: null,
      message: 'This file has column headings but no rows under them.'
    });
  }

  return { headers, rows, errors };
}

/**
 * A header name reduced to something comparable: `First Name`, `first_name`,
 * `FIRST-NAME` and ` First   Name ` all become `first name`.
 *
 * The BOM is stripped here too, belt and braces — `decodeCsvFile` is the layer
 * that should have removed it, but a header that arrived by some other route
 * must not fail to match over an invisible character.
 */
export function normaliseHeader(name) {
  const withoutBom = String(name ?? '').split(BOM_CHAR).join('');

  return withoutBom
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ')
    .trim();
}

/**
 * Best-effort column mapping, BY NAME AND NEVER BY POSITION — a file with its
 * columns shuffled maps identically. Returns `{ field: rawHeaderName }` for the
 * fields it recognised and simply omits the rest.
 */
export function guessMapping(headers) {
  const columns = (Array.isArray(headers) ? headers : []).map((name) => ({
    raw: name,
    key: normaliseHeader(name)
  }));

  const mapping = {};
  // One column cannot fill two fields: `last` must not be claimed by both
  // last_name and something else further down the list.
  const claimed = new Set();

  for (const field of LEAD_FIELDS) {
    for (const alias of HEADER_ALIASES[field.key]) {
      const match = columns.find((column) => column.key === alias && !claimed.has(column.raw));
      if (!match) continue;

      mapping[field.key] = match.raw;
      claimed.add(match.raw);
      break;
    }
  }

  return mapping;
}

function cellText(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);

  return '';
}

/**
 * Parsed rows + a mapping -> the array posted to the server.
 *
 * Only the six mapped fields are produced, so the 40 other columns a CRM export
 * carries never leave the browser. Values are trimmed here as well as on the
 * server: whitespace padding is the single commonest thing wrong with a CSV.
 */
export function toRows(rows, mapping) {
  const source = Array.isArray(rows) ? rows : [];
  const columns = mapping && typeof mapping === 'object' ? mapping : {};

  return source.map((row) => {
    const lead = {};

    for (const field of LEAD_FIELDS) {
      const header = columns[field.key];
      if (typeof header !== 'string' || header === '') continue;

      const value = cellText(row?.[header]);
      if (value !== '') lead[field.key] = value;
    }

    return lead;
  });
}

/**
 * Rows with an address, and rows without — separated rather than dropped, so the
 * count of what is being left behind can be shown before anything is uploaded.
 */
export function partitionRows(rows) {
  const ready = [];
  const missingEmail = [];

  (Array.isArray(rows) ? rows : []).forEach((row, index) => {
    const email = typeof row?.email === 'string' ? row.email.trim() : '';

    if (email === '') missingEmail.push({ index, row });
    else ready.push(row);
  });

  return { ready, missingEmail };
}
