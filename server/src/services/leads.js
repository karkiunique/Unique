import { getSupabaseAdmin } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { httpError } from '../lib/httpError.js';
import { checkLeadAddresses } from './leadAddresses.js';
import { VERIFY_STATUS } from './recipientCheck.js';

/**
 * Recipients — bulk add from an uploaded list.
 *
 * OWNER SCOPING: the server holds the service-role key and bypasses row level
 * security, so the `user_id` filter on the campaign lookup below IS the access
 * control. The campaign is resolved by (id, user_id) BEFORE a single row is read
 * from the request, and every inserted row carries `user_id` from the verified
 * token — never from the payload. A missing filter here would let one user write
 * rows into another user's campaign.
 *
 * PRIVACY: a lead row is third-party personal data — an address, a name, an
 * employer. It is covered by CLAUDE.md § Privacy exactly like an email body, so
 * nothing from a row reaches a log line or an error message. Log lines here
 * carry ids and counts only.
 */

/** Deliverability verdicts live in leadAddresses.js; re-exported as the contract. */
export { checkLeadAddresses };

/** One request's worth of rows. The client sends a long file in batches. */
export const MAX_LEADS_PER_REQUEST = 1000;

// RFC 5321 caps a forward path at 254 characters.
const MAX_EMAIL_LENGTH = 254;
// The same shape recipientCheck.js and the send path enforce.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The only keys ever read off a submitted row. A CSV carries whatever columns
 * the user's CRM exported; reading an allowlist rather than spreading the row is
 * what keeps `status`, `user_id`, `campaign_id` and the other 40 columns out of
 * the insert structurally, rather than by remembering to strip them.
 */
const OPTIONAL_FIELDS = ['first_name', 'last_name', 'company', 'title', 'linkedin_url'];

/** Stable machine codes. The UI owns the prose; these must not drift. */
export const LEAD_REJECT_REASON = {
  NOT_A_ROW: 'not_a_row',
  MISSING_EMAIL: 'missing_email',
  INVALID_EMAIL: 'invalid_email',
  EMAIL_TOO_LONG: 'email_too_long'
};

/** A duplicate is a no-op, not an error — hence skipped rather than rejected. */
export const LEAD_SKIP_REASON = {
  DUPLICATE_IN_FILE: 'duplicate_in_file',
  DUPLICATE_IN_CAMPAIGN: 'duplicate_in_campaign'
};

function requireUserId(userId) {
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw httpError(400, 'A userId is required');
  }

  return userId;
}

function requireCampaignId(campaignId) {
  if (typeof campaignId !== 'string' || campaignId.trim() === '') {
    throw httpError(400, 'A campaign id is required');
  }

  return campaignId.trim();
}

/** Validating the envelope here turns a malformed upload into a 400, not a 500. */
function requireRows(rows) {
  if (!Array.isArray(rows)) throw httpError(400, 'rows must be an array of recipients');
  if (rows.length === 0) throw httpError(400, 'There are no recipients to add');
  if (rows.length > MAX_LEADS_PER_REQUEST) {
    throw httpError(
      400,
      `An upload may carry at most ${MAX_LEADS_PER_REQUEST} recipients — send the file in batches`
    );
  }

  return rows;
}

function cleanText(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);

  return '';
}

/** Dedupe key: trimmed and case-folded, because Sam@Corp.com is sam@corp.com. */
function dedupeKey(email) {
  return cleanText(email).toLowerCase();
}

/**
 * One submitted row -> either `{ lead }` or `{ reason }`.
 *
 * Never throws: one malformed row in a 500-row file is that row's problem, and
 * must not cost the user the other 499.
 */
function readRow(row, index) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return { index, email: '', reason: LEAD_REJECT_REASON.NOT_A_ROW };
  }

  const email = cleanText(row.email);

  if (email === '') return { index, email: '', reason: LEAD_REJECT_REASON.MISSING_EMAIL };
  if (email.length > MAX_EMAIL_LENGTH) {
    return { index, email, reason: LEAD_REJECT_REASON.EMAIL_TOO_LONG };
  }
  if (!EMAIL_PATTERN.test(email)) {
    return { index, email, reason: LEAD_REJECT_REASON.INVALID_EMAIL };
  }

  const lead = { index, email };
  for (const field of OPTIONAL_FIELDS) {
    const value = cleanText(row[field]);
    lead[field] = value === '' ? null : value;
  }

  return { index, email, lead };
}

/** 404 — not 403 — when the campaign is not this user's: a stranger learns nothing. */
async function findOwnedCampaign(userId, campaignId) {
  const { data, error } = await getSupabaseAdmin()
    .from('campaigns')
    .select('id')
    .eq('id', campaignId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw httpError(500, 'Could not load the campaign');
  if (!data) throw httpError(404, 'Campaign not found');

  return data;
}

/** Addresses already on this campaign, folded for comparison. */
async function existingEmails(userId, campaignId) {
  const { data, error } = await getSupabaseAdmin()
    .from('leads')
    .select('email')
    .eq('campaign_id', campaignId)
    .eq('user_id', userId);

  if (error) throw httpError(500, 'Could not read the current recipients');

  const rows = Array.isArray(data) ? data : [];

  return new Set(rows.map((row) => dedupeKey(row?.email)).filter((key) => key !== ''));
}

async function flagRiskyAddresses(leads) {
  if (leads.length === 0) return [];

  try {
    const results = await checkLeadAddresses(leads);

    return results.filter((result) => result.status !== VERIFY_STATUS.OK);
  } catch {
    // Advisory means advisory: a check that fell over costs the user a hint, not
    // their upload. The error is dropped rather than logged — resolver messages
    // quote the hostname they were asked about.
    return [];
  }
}

async function insertLeads(userId, campaignId, leads) {
  if (leads.length === 0) return 0;

  // Built key by key from the verified token and the allowlisted fields, so no
  // row can smuggle in a user_id, a campaign_id or a status.
  const payload = leads.map((lead) => ({
    user_id: userId,
    campaign_id: campaignId,
    email: lead.email,
    first_name: lead.first_name,
    last_name: lead.last_name,
    company: lead.company,
    title: lead.title,
    linkedin_url: lead.linkedin_url,
    status: 'pending'
  }));

  const { data, error } = await getSupabaseAdmin().from('leads').insert(payload).select('id');

  if (error) throw httpError(500, 'Could not add the recipients');

  return Array.isArray(data) ? data.length : payload.length;
}

function byIndex(entries) {
  return [...entries].sort((left, right) => left.index - right.index);
}

/** Split the submitted rows into insertable leads, in-file duplicates and rejects. */
function sortSubmitted(rows) {
  const rejected = [];
  const skipped = [];
  const candidates = [];
  const seen = new Set();

  rows.forEach((row, index) => {
    const read = readRow(row, index);

    if (!read.lead) {
      rejected.push({ index, email: read.email, reason: read.reason });
      return;
    }

    const key = dedupeKey(read.email);
    if (seen.has(key)) {
      skipped.push({ index, email: read.email, reason: LEAD_SKIP_REASON.DUPLICATE_IN_FILE });
      return;
    }

    seen.add(key);
    candidates.push(read.lead);
  });

  return { rejected, skipped, candidates };
}

/**
 * Add recipients to a campaign.
 *
 * Returns `{ inserted, skipped, rejected, flagged }` — a count and three per-row
 * lists carrying `{ index, email, reason }` so the uploader can fix their own
 * file. That is the uploader's own data coming back to them over an
 * owner-scoped route; it is never written to a log.
 */
export async function addLeads(userId, campaignId, rows) {
  requireUserId(userId);
  const id = requireCampaignId(campaignId);
  const submitted = requireRows(rows);

  // Ownership first: nothing is read or written on a campaign that is not theirs.
  await findOwnedCampaign(userId, id);

  const { rejected, skipped, candidates } = sortSubmitted(submitted);

  const already = await existingEmails(userId, id);
  const fresh = candidates.filter((lead) => {
    if (!already.has(dedupeKey(lead.email))) return true;

    skipped.push({
      index: lead.index,
      email: lead.email,
      reason: LEAD_SKIP_REASON.DUPLICATE_IN_CAMPAIGN
    });

    return false;
  });

  const flagged = await flagRiskyAddresses(fresh);
  const inserted = await insertLeads(userId, id, fresh);

  logger.info('leads_added', { userId, campaignId: id, count: inserted });

  return { inserted, skipped: byIndex(skipped), rejected, flagged };
}
