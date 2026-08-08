import { getSupabaseAdmin } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { httpError } from '../lib/httpError.js';

/**
 * Campaigns — create, list, read, edit.
 *
 * WHY EVERY FUNCTION HERE TAKES A userId: the server talks to Postgres with the
 * service-role key, which BYPASSES row level security. The `user_id` filter on
 * each query below is therefore not a convenience — it is the only control
 * standing between one user's campaigns and another's. A read or a write that
 * forgets it is a data leak, not a listing bug. Treat it as load-bearing.
 *
 * Names, subjects and template bodies never reach a log line: a template body is
 * user-authored email content and is covered by CLAUDE.md § Privacy exactly like
 * a generated body. Log lines here carry ids and counts only.
 */

export const CAMPAIGN_MODES = ['voice', 'template'];
export const PERSONALIZED_MARKER = '{{personalized}}';

const MAX_NAME_LENGTH = 120;
const MAX_SUBJECT_LENGTH = 200;
const MAX_TEMPLATE_LENGTH = 20000;

const SENT_STATUS = 'sent';
const REPLIED_STATUS = 'replied';

const CAMPAIGN_COLUMNS =
  'id, user_id, name, mode, template_body, subject_template, status, created_at';

// Identity and progress only. Generated and edited bodies belong to the review
// screen, which is where a letter has a reason to leave the database.
const LEAD_COLUMNS =
  'id, campaign_id, email, first_name, last_name, company, title, status, fidelity_score, created_at';

function campaignsTable() {
  return getSupabaseAdmin().from('campaigns');
}

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

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validateName(value) {
  const name = trimmed(value);

  if (name === '') throw httpError(400, 'A campaign name is required');
  if (name.length > MAX_NAME_LENGTH) {
    throw httpError(400, `A campaign name must be ${MAX_NAME_LENGTH} characters or fewer`);
  }

  return name;
}

/** The DB has a CHECK constraint; validating here turns a 500 into a clean 400. */
function validateMode(value) {
  const mode = trimmed(value);

  if (!CAMPAIGN_MODES.includes(mode)) {
    throw httpError(400, "Mode must be either 'voice' or 'template'");
  }

  return mode;
}

function validateSubjectTemplate(value) {
  const subject = trimmed(value);

  if (subject === '') return null;
  if (subject.length > MAX_SUBJECT_LENGTH) {
    throw httpError(400, `A subject template must be ${MAX_SUBJECT_LENGTH} characters or fewer`);
  }

  return subject;
}

/**
 * A template with no {{personalized}} section is a mail merge: every recipient
 * gets the same letter bar their first name, which is the thing this product
 * exists not to send. Enforced here as well as in the builder, because the UI is
 * not the authority.
 *
 * The body is stored as written — whitespace is layout in an email template.
 */
function validateTemplateBody(value) {
  const body = typeof value === 'string' ? value : '';

  if (body.trim() === '') throw httpError(400, 'A template body is required in template mode');
  if (body.length > MAX_TEMPLATE_LENGTH) {
    throw httpError(400, `A template body must be ${MAX_TEMPLATE_LENGTH} characters or fewer`);
  }
  if (!body.includes(PERSONALIZED_MARKER)) {
    throw httpError(400, `A template must contain at least one ${PERSONALIZED_MARKER} section`);
  }

  return body;
}

function countByStatus(leads, status) {
  return leads.filter((lead) => lead?.status === status).length;
}

/** Replace the embedded lead rows with the two counts the campaigns list shows. */
function withCounts(row) {
  const { leads, ...campaign } = row ?? {};
  const statuses = Array.isArray(leads) ? leads : [];

  return {
    ...campaign,
    sentCount: countByStatus(statuses, SENT_STATUS),
    repliedCount: countByStatus(statuses, REPLIED_STATUS)
  };
}

/** One campaign, owner-scoped. 404 — not 403 — when it is not this user's. */
async function findCampaign(userId, campaignId) {
  const { data, error } = await campaignsTable()
    .select(CAMPAIGN_COLUMNS)
    .eq('id', campaignId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw httpError(500, 'Could not load the campaign');
  if (!data) throw httpError(404, 'Campaign not found');

  return data;
}

/** Create a campaign in 'draft'. Status is ours to move, never the client's. */
export async function createCampaign(userId, input = {}) {
  requireUserId(userId);

  const payload = input && typeof input === 'object' ? input : {};
  const name = validateName(payload.name);
  const mode = validateMode(payload.mode);
  // Voice mode has no template at all: store null rather than an empty string,
  // so nothing downstream mistakes "" for a template the user wrote.
  const templateBody = mode === 'template' ? validateTemplateBody(payload.templateBody) : null;
  const subjectTemplate = validateSubjectTemplate(payload.subjectTemplate);

  const { data, error } = await campaignsTable()
    .insert({
      user_id: userId,
      name,
      mode,
      template_body: templateBody,
      subject_template: subjectTemplate,
      status: 'draft'
    })
    .select(CAMPAIGN_COLUMNS)
    .single();

  if (error) throw httpError(500, 'Could not create the campaign');

  logger.info('campaign_created', { userId, campaignId: data?.id });

  return data;
}

/**
 * The user's campaigns, newest first, each with its sent and replied counts.
 *
 * ONE round trip: `leads(status)` is an embedded select (a join), so the counts
 * do not cost a query per campaign. Only the status column is read back — no
 * addresses, no generated bodies.
 */
export async function listCampaigns(userId) {
  requireUserId(userId);

  const { data, error } = await campaignsTable()
    .select(`${CAMPAIGN_COLUMNS}, leads(status)`)
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) throw httpError(500, 'Could not load your campaigns');

  const campaigns = (Array.isArray(data) ? data : []).map(withCounts);

  logger.info('campaigns_listed', { userId, count: campaigns.length });

  return campaigns;
}

/** One campaign plus its leads, or 404 if it is not this user's. */
export async function getCampaign(userId, campaignId) {
  requireUserId(userId);
  const id = requireCampaignId(campaignId);

  const campaign = await findCampaign(userId, id);

  const { data, error } = await getSupabaseAdmin()
    .from('leads')
    .select(LEAD_COLUMNS)
    .eq('campaign_id', id)
    // Redundant only if the campaign lookup above is correct. It is the same
    // filter that makes that lookup safe, and a lead read is not the place to
    // start trusting a join.
    .eq('user_id', userId)
    .order('created_at', { ascending: true });

  if (error) throw httpError(500, 'Could not load the campaign leads');

  const leads = Array.isArray(data) ? data : [];

  logger.info('campaign_read', { userId, campaignId: id, count: leads.length });

  return {
    ...campaign,
    sentCount: countByStatus(leads, SENT_STATUS),
    repliedCount: countByStatus(leads, REPLIED_STATUS),
    leads
  };
}

/**
 * Name, template body and subject template only.
 *
 * `status` is deliberately absent: it is moved by generation and sending, and a
 * client that could set it could mark a campaign 'sending' with nothing queued.
 * `user_id` is absent for the blunter reason — an editable owner column is a way
 * to hand your rows to somebody else. `mode` is absent because switching mode
 * would strand a template body or leave a voice campaign without one.
 */
function buildUpdates(campaign, patch) {
  const updates = {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return updates;

  if ('name' in patch) updates.name = validateName(patch.name);
  if ('subjectTemplate' in patch) {
    updates.subject_template = validateSubjectTemplate(patch.subjectTemplate);
  }
  if ('templateBody' in patch) {
    if (campaign.mode !== 'template') {
      throw httpError(400, 'A voice-mode campaign has no template body');
    }
    updates.template_body = validateTemplateBody(patch.templateBody);
  }

  return updates;
}

/** Edit an existing campaign. 404 first, so a stranger learns nothing about it. */
export async function updateCampaign(userId, campaignId, patch = {}) {
  requireUserId(userId);
  const id = requireCampaignId(campaignId);

  const campaign = await findCampaign(userId, id);
  const updates = buildUpdates(campaign, patch);

  if (Object.keys(updates).length === 0) throw httpError(400, 'Nothing to update');

  const { data, error } = await campaignsTable()
    .update(updates)
    .eq('id', id)
    .eq('user_id', userId)
    .select(CAMPAIGN_COLUMNS)
    .single();

  if (error) throw httpError(500, 'Could not update the campaign');

  logger.info('campaign_updated', { userId, campaignId: id });

  return data;
}
