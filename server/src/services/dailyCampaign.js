import { getSupabaseAdmin } from '../lib/supabase.js';
import { httpError } from '../lib/httpError.js';
import { logger } from '../lib/logger.js';

/**
 * The standing per-user "Daily" campaign (CLAUDE.md, Decisions 2026-08-16).
 *
 * WHY A CAMPAIGN AT ALL: `leads.campaign_id` is nullable in the schema, but
 * `services/leads.js` always sets it and the review screen, the register and the
 * generation path all group by it. Inventing a null-campaign code path would mean
 * touching working code for no gain — the smallest correct change is to give the
 * daily leads a real campaign to belong to.
 *
 * It is in 'sending' rather than 'draft' because its leads are drafted and
 * reviewed continuously, not generated in one batch and then closed. Nothing about
 * this campaign is ever sent automatically: the send path still requires per-lead
 * approval (2026-08-08), and this changes none of that.
 */

const DAILY_CAMPAIGN_NAME = 'Daily';

const CAMPAIGN_COLUMNS = 'id, user_id, name, mode, brief, status, created_at';

function campaignsTable() {
  return getSupabaseAdmin().from('campaigns');
}

/**
 * Find this user's Daily campaign, or make it.
 *
 * Get-or-create rather than create-if-missing: two invocations on the same day
 * cannot both create one, because the daily run is claimed first and only the
 * winner ever reaches this. The lookup-then-insert is therefore safe here in a way
 * it would not be on the run record itself.
 */
export async function getOrCreateDailyCampaign(userId, fitNotes = null) {
  if (!userId) throw httpError(400, 'A user id is required');

  const { data: existing, error: readError } = await campaignsTable()
    .select(CAMPAIGN_COLUMNS)
    .eq('user_id', userId)
    .eq('name', DAILY_CAMPAIGN_NAME)
    .maybeSingle();

  if (readError) throw httpError(500, 'Could not read the daily campaign');
  if (existing) return existing;

  const { data, error } = await campaignsTable()
    .insert({
      user_id: userId,
      name: DAILY_CAMPAIGN_NAME,
      mode: 'voice',
      // The brief IS the user's fit notes: it is what they said this outreach is
      // about, and § 3 wants a real goal rather than a fallback to the name. The
      // 2026-08-09 decision exists because that fallback once produced six letters
      // about running a first test.
      brief: fitNotes,
      status: 'sending'
    })
    .select(CAMPAIGN_COLUMNS)
    .single();

  if (error) throw httpError(500, 'Could not create the daily campaign');

  logger.info('daily_campaign_created', { userId, campaignId: data?.id });

  return data;
}

export { DAILY_CAMPAIGN_NAME };
