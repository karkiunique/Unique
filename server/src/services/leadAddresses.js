import {
  verifyRecipient,
  ROLE_LOCAL_PARTS,
  VERIFY_REASON,
  VERIFY_STATUS
} from './recipientCheck.js';

/**
 * Deliverability verdicts for a whole uploaded list.
 *
 * ADVISORY, NEVER BLOCKING (CLAUDE.md Decisions, 2026-08-05). MX proves a domain
 * can receive mail, never that a mailbox exists, so nothing here refuses a row —
 * it hands back a verdict the UI can show and the user can overrule. A DNS
 * failure resolves to 'unknown' and stays 'unknown': a slow resolver must never
 * mark a good address bad.
 *
 * Split out of leads.js to keep both files inside the size limit. Nothing here
 * logs or persists; an address leaves this process only as the DNS query for its
 * domain, which is what recipientCheck.js already does.
 */

// A long list resolved one domain at a time would take minutes.
const DOMAIN_LOOKUP_CONCURRENCY = 10;

function addressOf(lead) {
  return typeof lead?.email === 'string' ? lead.email.trim() : '';
}

function domainOf(email) {
  const separator = email.lastIndexOf('@');

  return separator === -1 ? '' : email.slice(separator + 1).toLowerCase();
}

/**
 * Role inboxes are a property of the ADDRESS, not the domain, so this is decided
 * per row from recipientCheck's own list rather than inherited from whichever
 * address happened to be its domain's representative.
 */
function isRoleAddress(email) {
  const separator = email.lastIndexOf('@');
  if (separator === -1) return false;

  return ROLE_LOCAL_PARTS.has(email.slice(0, separator).toLowerCase().split('+')[0]);
}

/** Same precedence verifyRecipient uses: bounce beats unknown beats quality. */
function statusFor(reasons) {
  if (reasons.includes(VERIFY_REASON.NO_MX)) return VERIFY_STATUS.INVALID;
  if (reasons.includes(VERIFY_REASON.DNS_TIMEOUT) || reasons.includes(VERIFY_REASON.DNS_ERROR)) {
    return VERIFY_STATUS.UNKNOWN;
  }

  return reasons.length > 0 ? VERIFY_STATUS.WARN : VERIFY_STATUS.OK;
}

/** First address seen for each domain — the one the resolver is asked about. */
function representativesByDomain(leads) {
  const representatives = new Map();

  for (const lead of leads) {
    const email = addressOf(lead);
    const domain = domainOf(email);
    if (domain === '' || representatives.has(domain)) continue;

    representatives.set(domain, email);
  }

  return representatives;
}

async function lookupDomains(representatives, options) {
  const pairs = [...representatives.entries()];
  const reasonsByDomain = new Map();

  /**
   * Findings that belong to the DOMAIN rather than the address, so they carry to
   * every row sharing it. Role-inbox flagging is deliberately not on this list.
   *
   * Built HERE and not at module scope on purpose. A module-scope read of another
   * module's named exports runs at import time, which means anything that pulls
   * this file in — even transitively, even without ever calling it — breaks the
   * moment recipientCheck.js is not fully resolved. That turned three unrelated
   * suites red at import. Reading the constants at call time costs one Set per
   * upload and takes the tripwire out of every consumer's path.
   */
  const domainLevelReasons = new Set([
    VERIFY_REASON.NO_MX,
    VERIFY_REASON.DNS_TIMEOUT,
    VERIFY_REASON.DNS_ERROR,
    VERIFY_REASON.DISPOSABLE_DOMAIN
  ]);

  for (let start = 0; start < pairs.length; start += DOMAIN_LOOKUP_CONCURRENCY) {
    const batch = pairs.slice(start, start + DOMAIN_LOOKUP_CONCURRENCY);
    const verdicts = await Promise.all(
      batch.map(([, address]) => verifyRecipient(address, options))
    );

    batch.forEach(([domain], position) => {
      const reasons = Array.isArray(verdicts[position]?.reasons) ? verdicts[position].reasons : [];
      // The representative's own role flag says nothing about its neighbours.
      reasonsByDomain.set(
        domain,
        reasons.filter((reason) => domainLevelReasons.has(reason))
      );
    });
  }

  return reasonsByDomain;
}

/**
 * Attach a verdict to every row, at ONE lookup per unique domain: a 500-row file
 * spread over 20 domains costs 20 DNS queries, not 500.
 */
export async function checkLeadAddresses(rows, options = {}) {
  const leads = Array.isArray(rows) ? rows : [];
  const reasonsByDomain = await lookupDomains(representativesByDomain(leads), options);

  return leads.map((lead) => {
    const email = addressOf(lead);
    const reasons = [...(reasonsByDomain.get(domainOf(email)) ?? [])];

    if (isRoleAddress(email)) reasons.push(VERIFY_REASON.ROLE_ADDRESS);

    return {
      index: Number.isInteger(lead?.index) ? lead.index : null,
      email,
      status: statusFor(reasons),
      reasons
    };
  });
}
