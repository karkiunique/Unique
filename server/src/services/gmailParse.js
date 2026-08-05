/**
 * Pure text helpers for Gmail ingestion. No network, no DB, no logging — the
 * strings flowing through here are raw email bodies and must stay in memory only
 * (CLAUDE.md, Security). Kept in their own module so they are trivially testable.
 */

const MAX_SIGNATURE_LINES = 4;
// A closing is a closing, not a sentence.
const MAX_CLOSING_LINE_CHARS = 40;
// How far back from the end we look for a closing line.
const CLOSING_SEARCH_WINDOW = 6;
// A signature block below a closing: few lines, each short. Anything larger is content.
const MAX_SIGNATURE_BLOCK_LINES = 4;
const MAX_SIGNATURE_BLOCK_LINE_CHARS = 45;
const MAX_SIGNATURE_BLOCK_LINE_TOKENS = 5;

// "On Mon, 3 Feb 2025 at 09:12, Sam Rivera <sam@x.com> wrote:" — may wrap over two lines.
const ON_WROTE = /^\s*On\s[\s\S]{0,300}?\bwrote:\s*$/;
const QUOTED_LINE = /^\s*>/;
const ORIGINAL_MESSAGE = /^\s*-{2,}\s*(original message|forwarded message)/i;
const SIGNATURE_DELIMITER = /^\s*-{2,}\s*$/;
// url, phone-ish digit run, or a bare @domain — the classic signature giveaways.
const SIGNATURE_HINT = /(https?:\/\/|www\.|\+?\d[\d\s().-]{6,}\d|@[a-z0-9-]+\.[a-z]{2,})/i;
// A scheme-less, www-less, @-less domain that is THE WHOLE LINE and nothing else:
// "witweb.org", "acme.io", "example.co.uk". Anchored on purpose — the bare-domain signal
// is far weaker than a scheme or an '@', so prose that merely CONTAINS a domain
// ("check out acme.io", "Details: witweb.org", "See acme.com") is the user's own writing
// and must survive. Every label is 2+ chars and the TLD is 2-6 LOWERCASE letters, which
// keeps "e.g.", "i.e.", "etc.", "U.S.", "friday.", "know.Thanks" and decimals like "3.5"
// from reading as a domain.
const STANDALONE_DOMAIN = /^(?:[A-Za-z0-9][A-Za-z0-9-]+\.)+[a-z]{2,6}(?:\/\S*)?$/;
// "P.S. deck attached", "PS: one more thing", "ps call me" — a postscript below a
// sign-off is real user prose, and cold emails use it constantly. Never signature.
const POSTSCRIPT = /^(?:p\.?\s*){1,2}s\.?\s*[:.—–-]?(?:\s|$)/i;
// "Founder, WitWeb", "VP Sales, Acme", "Head of Growth". Anchored at the start of the
// line so prose that merely mentions a role ("Ask the founder") is not a signal.
const TITLE_MODIFIER =
  '(?:senior|sr|junior|jr|global|regional|deputy|interim|managing|general|group)\\.?\\s+';
const TITLE_ROLE =
  '(?:co-?)?(?:founder|ceo|cto|coo|cfo|cmo|cro|chief|president|vice\\s+president|vp|head\\s+of' +
  '|director|manager|partner|principal|owner|engineer|designer|consultant|analyst|associate' +
  '|specialist|advis[eo]r|architect|recruiter|account\\s+executive|attorney|realtor|broker)';
const TITLE_LINE = new RegExp(`^(?:${TITLE_MODIFIER})?${TITLE_ROLE}\\b`, 'i');

// Closing words, matched case-insensitively at the start of a short trailing line.
const CLOSING_WORD =
  /^(?:best regards|all the best|talk soon|thank you|sincerely|regards|cheers|warmly|thanks|best)\b/i;
// What may follow a closing word: punctuation, then optionally a NAME — capitalised, at
// most three words. Requiring capitals is what stops "Thanks for the intro" reading as a
// closing and silently truncating everything the user wrote after it.
const CLOSING_TAIL = /^[\s,.!—–-]*(?:\p{Lu}[\p{L}'’.-]*(?:\s+\p{Lu}[\p{L}'’.-]*){0,2}[,.!]?)?$/u;
// Names, titles and companies start with a capital (or a digit, for street/suite lines).
const SIGNATURE_BLOCK_START = /^[\p{Lu}\d]/u;

const HTML_ENTITIES = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'"
};

function normalizeNewlines(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function trimBlankEdges(text) {
  return text.replace(/^\n+/, '').replace(/\s+$/, '');
}

/** base64url is what the Gmail API returns for part bodies. */
export function decodeBase64Url(data) {
  if (typeof data !== 'string' || data === '') return '';
  return Buffer.from(data, 'base64url').toString('utf8');
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;/g, (entity) => HTML_ENTITIES[entity] ?? entity)
    .replace(/\n{3,}/g, '\n\n');
}

function findPartData(node, mimeType) {
  if (!node || typeof node !== 'object') return null;
  // Skip attachments: only inline message parts carry the body we want.
  if (typeof node.filename === 'string' && node.filename.length > 0) return null;

  const type = typeof node.mimeType === 'string' ? node.mimeType.toLowerCase() : '';
  const data = node.body?.data;
  if (type.startsWith(mimeType) && typeof data === 'string' && data.length > 0) return data;

  const parts = Array.isArray(node.parts) ? node.parts : [];
  for (const part of parts) {
    const found = findPartData(part, mimeType);
    if (found) return found;
  }

  return null;
}

/** Walk a Gmail MIME payload and return the plain-text body (html is a fallback). */
export function extractPlainTextBody(payload) {
  if (!payload || typeof payload !== 'object') return '';

  const plain = findPartData(payload, 'text/plain');
  if (plain) return normalizeNewlines(decodeBase64Url(plain));

  const html = findPartData(payload, 'text/html');
  if (html) return normalizeNewlines(stripHtml(decodeBase64Url(html)));

  return '';
}

/** Drop lines starting with '>' and everything from an "On ... wrote:" line onward. */
export function stripQuotedReplies(text) {
  const lines = normalizeNewlines(text).split('\n');
  const kept = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const wrapped = i + 1 < lines.length ? `${line} ${lines[i + 1].trim()}` : line;

    if (ON_WROTE.test(line) || ON_WROTE.test(wrapped)) break;
    if (ORIGINAL_MESSAGE.test(line)) break;
    if (QUOTED_LINE.test(line)) continue;

    kept.push(line);
  }

  return trimBlankEdges(kept.join('\n'));
}

function tokenCount(trimmed) {
  return trimmed.split(/\s+/).length;
}

/**
 * A trailing line that reads as signature material: phone / url / @address, or a line
 * that is a bare domain AND NOTHING ELSE. A domain sitting inside a sentence does not
 * count — that sentence is prose the user wrote.
 */
function looksLikeSignatureLine(line) {
  const trimmed = line.trim();
  if (trimmed === '' || POSTSCRIPT.test(trimmed)) return false;
  return SIGNATURE_HINT.test(trimmed) || STANDALONE_DOMAIN.test(trimmed);
}

/**
 * The only thing that separates a signature block from short declarative prose: a real
 * signature token — url, phone, @address, standalone bare domain, or a role/company line.
 * Shortness and capitalisation are NECESSARY BUT NEVER SUFFICIENT, because "Docs are
 * attached." has exactly the shape of a name or title line.
 */
function hasStrongSignatureSignal(line) {
  const trimmed = line.trim();
  if (looksLikeSignatureLine(trimmed)) return true;
  // Sentences end in terminal punctuation; job titles do not.
  if (trimmed === '' || /[.!?]$/.test(trimmed)) return false;
  return TITLE_LINE.test(trimmed);
}

/** "Best,", "Thanks!", "Thank you Ken,", "Best, Unique Karki", "Cheers - Ana". */
function isClosingLine(line) {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.length > MAX_CLOSING_LINE_CHARS) return false;

  const head = CLOSING_WORD.exec(trimmed);
  if (!head) return false;

  return CLOSING_TAIL.test(trimmed.slice(head[0].length));
}

/**
 * Necessary-but-not-sufficient shape test: short enough to be a name / title / company /
 * url line. On its own this matches short punchy prose too, which is why every cut also
 * requires hasStrongSignatureSignal somewhere in the block.
 */
function isSignatureBlockLine(line) {
  const trimmed = line.trim();
  if (trimmed === '') return false;
  if (trimmed.length > MAX_SIGNATURE_BLOCK_LINE_CHARS) return false;
  if (tokenCount(trimmed) > MAX_SIGNATURE_BLOCK_LINE_TOKENS) return false;

  return SIGNATURE_BLOCK_START.test(trimmed) || looksLikeSignatureLine(trimmed);
}

/**
 * The structural signature signal: a closing line near the end followed by a short
 * trailing block. Returns the slice end that KEEPS the closing line ("Best," is genuine
 * voice and feeds signoff_styles) and drops the name/title/company/url block under it,
 * or -1 when nothing is safe to cut.
 */
function findSignatureBlockCut(lines) {
  const nonEmpty = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== '') nonEmpty.push(i);
  }
  if (nonEmpty.length < 2) return -1;

  const searchWindow = Math.min(CLOSING_SEARCH_WINDOW, nonEmpty.length);
  // Scan outwards from the end so the NEAREST closing wins. Otherwise a "Thanks Sam"
  // higher up the body would swallow every real sentence written below it.
  for (let offset = 2; offset <= searchWindow; offset += 1) {
    const position = nonEmpty.length - offset;
    const trailing = nonEmpty.slice(position + 1);

    if (trailing.length > MAX_SIGNATURE_BLOCK_LINES) break;
    // A postscript under the closing is prose. The cut takes every trailing line, so it
    // would eat the P.S. too — and widening the window only pulls it back in. Give up.
    if (trailing.some((index) => POSTSCRIPT.test(lines[index].trim()))) return -1;
    if (!isClosingLine(lines[nonEmpty[position]])) continue;
    if (!trailing.every((index) => isSignatureBlockLine(lines[index]))) continue;
    // Shape alone is not evidence: require one real signature token in the block.
    if (!trailing.some((index) => hasStrongSignatureSignal(lines[index]))) continue;

    return nonEmpty[position] + 1;
  }

  return -1;
}

/**
 * Drop everything after a '--' delimiter line. Without one, drop the signature block
 * hanging below a closing line. Failing that, drop up to the last 4 lines while they
 * look like signature material (phone / url / @address / standalone bare domain).
 */
function stripSignatureLines(normalized) {
  const lines = normalized.split('\n');

  const delimiter = lines.findIndex((line) => SIGNATURE_DELIMITER.test(line));
  if (delimiter !== -1) return trimBlankEdges(lines.slice(0, delimiter).join('\n'));

  const blockCut = findSignatureBlockCut(lines);
  if (blockCut !== -1) return trimBlankEdges(lines.slice(0, blockCut).join('\n'));

  const kept = lines.slice();
  let removed = 0;
  while (kept.length > 0 && removed < MAX_SIGNATURE_LINES) {
    const last = kept[kept.length - 1];
    if (last.trim() === '') {
      kept.pop();
      continue;
    }
    if (!looksLikeSignatureLine(last)) break;
    kept.pop();
    removed += 1;
  }

  return trimBlankEdges(kept.join('\n'));
}

/**
 * Signature stripping with a hard floor: it may never delete an entire email.
 * fetchSentEmails drops messages whose cleaned body is empty, so an over-strip that
 * empties the body removes that email from the voice corpus with no trace. A surviving
 * signature is noise in the profile; a lost email is silent data loss, so when a path
 * would consume everything we keep the body untouched instead.
 */
export function stripSignature(text) {
  const normalized = normalizeNewlines(text);
  const stripped = stripSignatureLines(normalized);

  if (stripped === '' && normalized.trim() !== '') return trimBlankEdges(normalized);
  return stripped;
}

/** Quoted replies first, then the signature that sat above them. */
export function cleanEmailBody(text) {
  const cleaned = stripSignature(stripQuotedReplies(normalizeNewlines(text)));
  return trimBlankEdges(cleaned.replace(/\n{3,}/g, '\n\n'));
}

/**
 * Stage-by-stage view of cleanEmailBody, for the dev ingest-preview route.
 * Reuses the exported strip functions rather than restating them, so what it
 * reports can never drift from what the real ingestion pipeline does.
 * Pure and in-memory like the rest of this module — nothing here is persisted.
 */
export function inspectCleaning(rawText) {
  const raw = normalizeNewlines(rawText);
  const afterQuotedReplies = stripQuotedReplies(raw);
  const afterSignature = stripSignature(afterQuotedReplies);

  return { raw, afterQuotedReplies, afterSignature, cleaned: cleanEmailBody(raw) };
}
