import { resolveMx } from 'node:dns/promises';

/**
 * Recipient verification — a risk signal, never a verdict.
 * (CLAUDE.md Decisions, 2026-08-05.)
 *
 * We send from the user's OWN Gmail account, so a bounce costs them personally:
 * it damages their real sender reputation and can get their real mailbox
 * rate-limited. An MX lookup plus role/disposable flagging is the cheap check
 * that runs BEFORE a send; bounce detection (Phase 4) is the authoritative one
 * that arrives after.
 *
 * Its ceiling is known and accepted: MX proves a domain can receive mail, never
 * that a mailbox exists. It cannot see a departed employee at a live domain, and
 * catch-all domains accept everything by design. Hence "advisory" — and hence a
 * DNS failure resolves to 'unknown', never 'invalid'.
 *
 * Deliberately NOT here: SMTP `RCPT TO` probing. Rejected, not deferred — port
 * 25 is blocked on our host, Gmail/M365 answer ambiguously by design, and
 * probing from an unwarmed IP invites blocklisting.
 *
 * Privacy: the address never leaves this process except as the DNS query for its
 * domain. Nothing here logs, persists, or throws with an address in it, and the
 * cache is keyed by domain alone for exactly that reason.
 */

// The same address shape send.js enforces. Duplicated rather than imported so a
// tweak made for verification can never loosen what the send path accepts.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// RFC 5321 caps a forward path at 254 characters. Past that it is malformed, and
// there is no reason to hand it to a resolver.
const MAX_EMAIL_LENGTH = 254;

/** How long a single MX lookup may take before it is abandoned as 'unknown'. */
export const DNS_TIMEOUT_MS = 3000;

const MX_CACHE_TTL_MS = 10 * 60 * 1000;
const MX_CACHE_MAX_ENTRIES = 500;

export const VERIFY_STATUS = {
  OK: 'ok',
  WARN: 'warn',
  INVALID: 'invalid',
  UNKNOWN: 'unknown'
};

/** Stable machine codes. The UI owns the prose; these must not drift. */
export const VERIFY_REASON = {
  SYNTAX: 'syntax',
  NO_MX: 'no_mx',
  ROLE_ADDRESS: 'role_address',
  DISPOSABLE_DOMAIN: 'disposable_domain',
  DNS_TIMEOUT: 'dns_timeout',
  DNS_ERROR: 'dns_error'
};

/**
 * Shared inboxes. Deliverable, but read by a rota rather than a person: they
 * rarely reply and are quick to report cold mail as spam, which lands on the
 * user's own sending reputation.
 */
export const ROLE_LOCAL_PARTS = new Set([
  'info',
  'admin',
  'administrator',
  'support',
  'noreply',
  'no-reply',
  'donotreply',
  'sales',
  'contact',
  'hello',
  'team',
  'billing',
  'help',
  'office',
  'marketing',
  'webmaster',
  'postmaster',
  'abuse',
  'enquiries',
  'inquiries'
]);

/** Modest and deliberately extendable — one list, one place to add a domain. */
export const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com',
  'guerrillamail.com',
  '10minutemail.com',
  'tempmail.com',
  'temp-mail.org',
  'yopmail.com',
  'throwawaymail.com',
  'trashmail.com',
  'sharklasers.com',
  'getnada.com',
  'dispostable.com',
  'maildrop.cc',
  'fakeinbox.com'
]);

const MX_RESULT = {
  PRESENT: 'present',
  ABSENT: 'absent',
  TIMEOUT: 'timeout',
  ERROR: 'error'
};

/**
 * Domain -> { outcome, expiresAt }. Process memory only: a cache, not
 * persistence — nothing here touches the DB or disk. Keyed by DOMAIN and never
 * by address, so no recipient is retained anywhere.
 */
const mxCache = new Map();

/** Test seam: drops the whole cache so cases cannot bleed into each other. */
export function resetMxCache() {
  mxCache.clear();
}

function readCache(domain) {
  const entry = mxCache.get(domain);
  if (!entry) return null;

  if (entry.expiresAt <= Date.now()) {
    mxCache.delete(domain);
    return null;
  }

  return entry.outcome;
}

function writeCache(domain, outcome) {
  // Only definitive answers are cached. Pinning a transient failure for the full
  // TTL would keep punishing an address that was never the problem.
  if (outcome !== MX_RESULT.PRESENT && outcome !== MX_RESULT.ABSENT) return;

  // Bounded: re-inserting moves the key to the newest slot, and the oldest is
  // evicted at the ceiling, so the map cannot grow without limit.
  mxCache.delete(domain);
  if (mxCache.size >= MX_CACHE_MAX_ENTRIES) {
    const oldest = mxCache.keys().next();
    if (!oldest.done) mxCache.delete(oldest.value);
  }

  mxCache.set(domain, { outcome, expiresAt: Date.now() + MX_CACHE_TTL_MS });
}

/** Identity-compared sentinel, so it can never collide with a DNS result. */
const TIMED_OUT = Object.freeze({ dnsTimeout: true });

/**
 * `dns.promises` has no timeout of its own, and a slow resolver must never be
 * allowed to condemn a good address. Bounded race that resolves to TIMED_OUT,
 * with the timer always cleared so a pending check cannot keep the process alive.
 */
function withTimeout(promise, timeoutMs) {
  let timer = null;

  const expiry = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    if (typeof timer?.unref === 'function') timer.unref();
  });

  return Promise.race([promise, expiry]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * ENOTFOUND / NXDOMAIN is the resolver answering "no such domain" — a real
 * answer about the address. Every other code is a problem on our side.
 */
function isMissingDomain(err) {
  const code = typeof err?.code === 'string' ? err.code.toUpperCase() : '';

  return code === 'ENOTFOUND' || code === 'NXDOMAIN';
}

/** A lone '.' exchange is RFC 7505's null MX: "this domain accepts no mail". */
function hasUsableExchange(records) {
  if (!Array.isArray(records)) return false;

  return records.some((record) => {
    const exchange = typeof record?.exchange === 'string' ? record.exchange.trim() : '';
    return exchange !== '' && exchange !== '.';
  });
}

async function lookupMx(domain, timeoutMs) {
  const cached = readCache(domain);
  if (cached) return cached;

  let outcome;
  try {
    const records = await withTimeout(resolveMx(domain), timeoutMs);
    if (records === TIMED_OUT) {
      outcome = MX_RESULT.TIMEOUT;
    } else if (!Array.isArray(records)) {
      // Not a record list is not an answer about the domain. Node's resolveMx
      // always resolves to an array or rejects, so this is unreachable today —
      // but reading it as ABSENT would mean 'invalid', cached for the full TTL,
      // off the back of a resolver that told us nothing. Failures are 'unknown'.
      outcome = MX_RESULT.ERROR;
    } else {
      outcome = hasUsableExchange(records) ? MX_RESULT.PRESENT : MX_RESULT.ABSENT;
    }
  } catch (err) {
    // The error object is inspected for its code and then dropped: resolver
    // messages quote the hostname, and nothing here may carry that onward.
    outcome = isMissingDomain(err) ? MX_RESULT.ABSENT : MX_RESULT.ERROR;
  }

  writeCache(domain, outcome);

  return outcome;
}

/** Flags derived from the address alone — no DNS involved. */
function qualityReasons(localPart, domain) {
  const reasons = [];
  const base = localPart.split('+')[0];

  if (ROLE_LOCAL_PARTS.has(base)) reasons.push(VERIFY_REASON.ROLE_ADDRESS);
  if (DISPOSABLE_DOMAINS.has(domain)) reasons.push(VERIFY_REASON.DISPOSABLE_DOMAIN);

  return reasons;
}

function verdict(status, reasons, hasMx) {
  return { status, reasons, hasMx };
}

function resolveTimeout(value) {
  return Number.isFinite(value) && value > 0 ? value : DNS_TIMEOUT_MS;
}

/**
 * Check one address and return `{ status, reasons, hasMx }`.
 *
 * Never throws for a bad address — a malformed one is a result ('invalid' +
 * 'syntax'), not an exception, because the caller is a UI hint and not a gate.
 *
 * `options.timeoutMs` exists so the timeout branch is testable without fake
 * timers; production callers use the default.
 */
export async function verifyRecipient(email, options = {}) {
  const address = typeof email === 'string' ? email.trim() : '';

  if (address === '' || address.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(address)) {
    // Nothing resolvable here, so the resolver is never asked.
    return verdict(VERIFY_STATUS.INVALID, [VERIFY_REASON.SYNTAX], false);
  }

  const separator = address.lastIndexOf('@');
  const localPart = address.slice(0, separator).toLowerCase();
  const domain = address.slice(separator + 1).toLowerCase();

  const mx = await lookupMx(domain, resolveTimeout(options.timeoutMs));
  const quality = qualityReasons(localPart, domain);

  if (mx === MX_RESULT.ABSENT) {
    return verdict(VERIFY_STATUS.INVALID, [VERIFY_REASON.NO_MX, ...quality], false);
  }
  if (mx === MX_RESULT.TIMEOUT) {
    return verdict(VERIFY_STATUS.UNKNOWN, [VERIFY_REASON.DNS_TIMEOUT, ...quality], false);
  }
  if (mx === MX_RESULT.ERROR) {
    return verdict(VERIFY_STATUS.UNKNOWN, [VERIFY_REASON.DNS_ERROR, ...quality], false);
  }

  return quality.length > 0
    ? verdict(VERIFY_STATUS.WARN, quality, true)
    : verdict(VERIFY_STATUS.OK, [], true);
}
