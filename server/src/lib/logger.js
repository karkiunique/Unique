/**
 * Structured logger with a strict field allowlist.
 *
 * Security rule (CLAUDE.md): raw email bodies and tokens never reach logs. We do not
 * log arbitrary objects — anything not on the allowlist is dropped, and allowlisted
 * string values are scanned for token-shaped content and truncated.
 */

const ALLOWED_FIELDS = new Set([
  'userId',
  'campaignId',
  'leadId',
  'jobId',
  'route',
  'method',
  'status',
  'durationMs',
  'count',
  'port',
  'env',
  'reason',
  'name',
  'version'
]);

const REDACTED = '[redacted]';
const MAX_VALUE_LENGTH = 200;

// JWTs, bearer headers, and long opaque secrets.
const TOKEN_LIKE = /(^|\s)(bearer\s+\S+|ey[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}|[a-z0-9_-]{40,})/i;

function safeValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'string') return REDACTED;
  if (TOKEN_LIKE.test(value)) return REDACTED;
  return value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}…` : value;
}

/** Drop every field that is not explicitly allowlisted. Exported for tests. */
export function sanitizeMeta(meta) {
  const out = {};
  if (!meta || typeof meta !== 'object') return out;
  for (const [key, value] of Object.entries(meta)) {
    if (!ALLOWED_FIELDS.has(key)) continue;
    out[key] = safeValue(value);
  }
  return out;
}

function write(level, event, meta) {
  const line = JSON.stringify({
    level,
    event: typeof event === 'string' ? event.slice(0, 80) : 'unknown_event',
    time: new Date().toISOString(),
    ...sanitizeMeta(meta)
  });
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  info: (event, meta) => write('info', event, meta),
  warn: (event, meta) => write('warn', event, meta),
  error: (event, meta) => write('error', event, meta)
};
