import { getSupabaseAdmin } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { httpError } from '../lib/httpError.js';
import { recordEditCorrections } from './editLearning.js';

/**
 * The review screen's data layer — read one letter, edit it, approve it.
 *
 * THIS IS THE BATCH APPROVAL GATE. Once sending is autonomous, `approved` is the
 * last thing standing between a model's draft and somebody's inbox under the
 * user's own name. Two rules follow, and both are enforced HERE rather than in
 * the UI, because a UI gate is bypassable — this repo has already shipped a route
 * variant that sent mail with no confirmation past a fully green suite:
 *
 *  1. A lead reaches `approved` only through an explicit, per-lead approval, and
 *     only from a status that means "a draft exists and a human can read it".
 *     There is no bulk path to `approved` — see selectSendableLeads() below.
 *  2. Only `approved` leads are ever sendable. selectSendableLeads() is the only
 *     supported way to ask what may go out, and it filters on `approved` twice.
 *
 * OWNER SCOPING: the server holds the service-role key and bypasses row level
 * security, so the `user_id` filter on every query below IS the access control.
 * A lead belonging to somebody else is a 404 — not a 403 — so a stranger learns
 * nothing about whether it exists.
 *
 * PRIVACY: a generated body, an edited body and a lead's name, employer and
 * address are all covered by CLAUDE.md § Privacy exactly like a raw email body.
 * Log lines here carry ids and counts only, and nothing from a letter or a lead
 * ever reaches an error message.
 */

export const LEAD_REVIEW_COLUMNS =
  'id, campaign_id, user_id, email, first_name, last_name, company, title, status, ' +
  'fidelity_score, generated_subject, generated_body, edited_body, sent_at, created_at';

const PENDING = 'pending';
const GENERATED = 'generated';
const APPROVED = 'approved';

/**
 * The legal transitions, stated as data rather than scattered through ifs.
 *
 * `pending` is absent from both sets on purpose: a lead nobody has drafted for
 * has nothing a human could have read, so it can neither be edited nor approved.
 * `queued`, `sent`, `replied`, `bounced` and `unsubscribed` are absent for the
 * blunter reason — that letter has already left, or is about to.
 */
const APPROVABLE_FROM = new Set([GENERATED, APPROVED]);
const EDITABLE_FROM = new Set([GENERATED, APPROVED]);

const MAX_SUBJECT_LENGTH = 200;
const MAX_BODY_LENGTH = 20000;

function leadsTable() {
  return getSupabaseAdmin().from('leads');
}

function requireUserId(userId) {
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw httpError(400, 'A userId is required');
  }

  return userId;
}

function requireLeadId(leadId) {
  if (typeof leadId !== 'string' || leadId.trim() === '') {
    throw httpError(400, 'A recipient id is required');
  }

  return leadId.trim();
}

function requireCampaignId(campaignId) {
  if (typeof campaignId !== 'string' || campaignId.trim() === '') {
    throw httpError(400, 'A campaign id is required');
  }

  return campaignId.trim();
}

/** 404 — not 403 — when the lead is not this user's. */
async function findOwnedLead(userId, leadId) {
  const { data, error } = await leadsTable()
    .select(LEAD_REVIEW_COLUMNS)
    .eq('id', leadId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw httpError(500, 'Could not load the recipient');
  if (!data) throw httpError(404, 'Recipient not found');

  return data;
}

/**
 * What would actually be sent for this lead: the user's edit wins over the
 * model's draft, which is the entire reason `edited_body` is a separate column —
 * `generated_body` stays intact so the edit-learning diff remains possible.
 *
 * There is one subject column in the schema (CLAUDE.md is the contract), so an
 * edited subject overwrites `generated_subject`; only the body keeps both.
 */
export function outgoingLetter(lead) {
  const edited = typeof lead?.edited_body === 'string' ? lead.edited_body : '';
  const generated = typeof lead?.generated_body === 'string' ? lead.generated_body : '';
  const subject = typeof lead?.generated_subject === 'string' ? lead.generated_subject : '';

  return { subject, body: edited.trim() === '' ? generated : edited };
}

/**
 * Stored EXACTLY as the client sent it, length-checked but never rewritten.
 *
 * The compose flow learned this the hard way: a value quietly modified after the
 * human read it means the thing they approved is not the thing that ships. The
 * user reads this field back from the response, so a silent trim here would put
 * an unread subject in front of the approval button.
 */
function validateSubject(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw httpError(400, 'A subject is required');
  }
  if (value.length > MAX_SUBJECT_LENGTH) {
    throw httpError(400, `A subject must be ${MAX_SUBJECT_LENGTH} characters or fewer`);
  }

  return value;
}

/** Whitespace is layout in a letter, so the body is stored as written. */
function validateBody(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw httpError(400, 'A letter body is required');
  }
  if (value.length > MAX_BODY_LENGTH) {
    throw httpError(400, `A letter must be ${MAX_BODY_LENGTH} characters or fewer`);
  }

  return value;
}

function requireApproveFlag(patch) {
  if (!('approve' in patch)) return false;
  if (typeof patch.approve !== 'boolean') {
    throw httpError(400, 'approve must be true or false');
  }

  return patch.approve === true;
}

/** Nothing empty is ever approvable: an approved blank letter is still a send. */
function requireLetterPresent(lead, updates) {
  const merged = { ...lead, ...updates };
  const letter = outgoingLetter(merged);

  if (letter.subject.trim() === '' || letter.body.trim() === '') {
    throw httpError(400, 'This recipient has no letter to approve yet');
  }
}

/**
 * The patch, assembled key by key from an allowlist.
 *
 * `status` is deliberately absent as an input: it is set here and only here, and
 * only to `approved` after an explicit per-lead approval clears the transition
 * check. `user_id`, `campaign_id`, `fidelity_score` and `generated_body` are
 * absent too — an editable owner column hands your rows to somebody else, and a
 * settable fidelity score would let a client dress a bad draft up as a good one.
 */
function buildLeadUpdates(lead, patch) {
  const updates = {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return updates;

  const editing = 'subject' in patch || 'body' in patch;
  const approving = requireApproveFlag(patch);

  if (editing) {
    if (!EDITABLE_FROM.has(lead.status)) {
      throw httpError(400, `A ${lead.status} recipient can no longer be edited`);
    }
    if ('subject' in patch) updates.generated_subject = validateSubject(patch.subject);
    if ('body' in patch) updates.edited_body = validateBody(patch.body);
  }

  if (approving) {
    if (!APPROVABLE_FROM.has(lead.status)) {
      throw httpError(
        400,
        lead.status === PENDING
          ? 'This recipient has no draft yet — generate one before approving it'
          : `A ${lead.status} recipient cannot be approved`
      );
    }
    requireLetterPresent(lead, updates);
    updates.status = APPROVED;
  } else if (editing && lead.status === APPROVED) {
    // The approval was for the old words. Changing them withdraws it, so the
    // human approves the letter that will actually go out, not an earlier one.
    updates.status = GENERATED;
  }

  return updates;
}

/** One lead in full, letter included. Owner-scoped; 404 if it is not theirs. */
export async function getLead(userId, leadId) {
  requireUserId(userId);
  const id = requireLeadId(leadId);

  const lead = await findOwnedLead(userId, id);

  logger.info('lead_read', { userId, leadId: id, campaignId: lead.campaign_id });

  return lead;
}

/**
 * Edit and/or approve one lead. Approval is per-lead and explicit: there is no
 * request shape here that approves anything the caller did not name by id.
 */
export async function updateLead(userId, leadId, patch = {}) {
  requireUserId(userId);
  const id = requireLeadId(leadId);

  const lead = await findOwnedLead(userId, id);
  const updates = buildLeadUpdates(lead, patch);

  if (Object.keys(updates).length === 0) throw httpError(400, 'Nothing to update');

  const { data, error } = await leadsTable()
    .update(updates)
    .eq('id', id)
    .eq('user_id', userId)
    .select(LEAD_REVIEW_COLUMNS)
    .single();

  if (error) throw httpError(500, 'Could not update the recipient');

  if (typeof updates.edited_body === 'string') {
    try {
      await recordEditCorrections(userId, lead.generated_body, updates.edited_body);
    } catch {
      // The edit-learning loop is a bonus on top of the edit, never a condition
      // of it: a correction we failed to record must not cost the user their
      // words. Swallowed rather than logged — a driver message can quote the row.
    }
  }

  logger.info(updates.status === APPROVED ? 'lead_approved' : 'lead_edited', {
    userId,
    leadId: id,
    campaignId: lead.campaign_id
  });

  return data;
}

/**
 * THE SEND GATE. Every letter a campaign may put in somebody's inbox, and no
 * others — Phase 4's send route and worker read the queue from here rather than
 * querying `leads` themselves.
 *
 * `approved` is filtered twice, in the query and again in memory. That is not
 * belt-and-braces for its own sake: the query filter is the fast path, and the
 * in-memory check is the one that still holds if a future edit loosens it.
 */
export async function selectSendableLeads(userId, campaignId) {
  requireUserId(userId);
  const id = requireCampaignId(campaignId);

  const { data, error } = await leadsTable()
    .select(LEAD_REVIEW_COLUMNS)
    .eq('campaign_id', id)
    .eq('user_id', userId)
    .eq('status', APPROVED)
    .order('created_at', { ascending: true });

  if (error) throw httpError(500, 'Could not load the approved recipients');

  const rows = Array.isArray(data) ? data : [];
  const sendable = rows
    .filter((lead) => lead?.status === APPROVED && lead?.user_id === userId)
    .map((lead) => ({ id: lead.id, email: lead.email, ...outgoingLetter(lead) }))
    .filter((letter) => letter.subject.trim() !== '' && letter.body.trim() !== '');

  logger.info('sendable_leads_selected', { userId, campaignId: id, count: sendable.length });

  return sendable;
}
