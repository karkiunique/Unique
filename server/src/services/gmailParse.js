/**
 * Pure text helpers for Gmail ingestion. No network, no DB, no logging — the
 * strings flowing through here are raw email bodies and must stay in memory only
 * (CLAUDE.md, Security). Kept in their own module so they are trivially testable.
 */

const MAX_SIGNATURE_LINES = 4;

// "On Mon, 3 Feb 2025 at 09:12, Sam Rivera <sam@x.com> wrote:" — may wrap over two lines.
const ON_WROTE = /^\s*On\s[\s\S]{0,300}?\bwrote:\s*$/;
const QUOTED_LINE = /^\s*>/;
const ORIGINAL_MESSAGE = /^\s*-{2,}\s*(original message|forwarded message)/i;
const SIGNATURE_DELIMITER = /^\s*-{2,}\s*$/;
// url, phone-ish digit run, or a bare @domain — the classic signature giveaways.
const SIGNATURE_HINT = /(https?:\/\/|www\.|\+?\d[\d\s().-]{6,}\d|@[a-z0-9-]+\.[a-z]{2,})/i;

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

/**
 * Drop everything after a '--' delimiter line. Without one, drop up to the last
 * 4 lines while they look like signature material (phone / url / @domain).
 */
export function stripSignature(text) {
  const lines = normalizeNewlines(text).split('\n');

  const delimiter = lines.findIndex((line) => SIGNATURE_DELIMITER.test(line));
  if (delimiter !== -1) return trimBlankEdges(lines.slice(0, delimiter).join('\n'));

  const kept = lines.slice();
  let removed = 0;
  while (kept.length > 0 && removed < MAX_SIGNATURE_LINES) {
    const last = kept[kept.length - 1];
    if (last.trim() === '') {
      kept.pop();
      continue;
    }
    if (!SIGNATURE_HINT.test(last)) break;
    kept.pop();
    removed += 1;
  }

  return trimBlankEdges(kept.join('\n'));
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
