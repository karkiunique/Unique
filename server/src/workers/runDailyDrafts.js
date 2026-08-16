import 'dotenv/config';

import { logger } from '../lib/logger.js';
import { runDailyDrafts } from './dailyDraftJob.js';
import { createDailyDrafter } from '../services/dailyDraft.js';
import { getOrCreateDailyCampaign } from '../services/dailyCampaign.js';

/**
 * The entrypoint a SCHEDULED INVOCATION calls. Runs once, exits.
 *
 * Deliberately not an in-process `node-cron` timer inside the API (CLAUDE.md,
 * Decisions 2026-08-16): a timer dies silently on redeploy, mid-run, and nobody
 * finds out until a user asks where their drafts went. A separate invocation
 * either ran or did not, and says so in its exit code.
 *
 *   Railway -> the service -> Settings -> Cron Schedule
 *   Command:  node src/workers/runDailyDrafts.js
 *   Schedule: 0 6 * * *      (06:00 UTC; timezones are a later problem, per § 4)
 *
 * Idempotent by construction: `daily_runs` has a unique (user_id, run_date) and
 * the claim is the first thing each user's run does, so a double-fired schedule
 * or a manual re-run costs nothing. Safe to run by hand.
 */

/**
 * The per-user drafter, built lazily.
 *
 * The job hands `draftLead` a userId and campaignId per candidate, but the voice
 * profile and sign-off name cannot change mid-run — so they are loaded once per
 * user and reused, rather than three extra queries per letter.
 */
function makeDraftLead() {
  const drafters = new Map();

  return async function draftLead(userId, campaignId, candidate) {
    if (!drafters.has(userId)) {
      const campaign = await getOrCreateDailyCampaign(userId);
      drafters.set(userId, await createDailyDrafter(userId, campaign));
    }

    return drafters.get(userId)(candidate);
  };
}

async function main() {
  const started = Date.now();

  try {
    const results = await runDailyDrafts({ draftLead: makeDraftLead() });

    const ran = results.filter((result) => result.ran).length;
    const delivered = results.reduce((total, result) => total + (result.delivered ?? 0), 0);

    logger.info('daily_job_finished', {
      count: delivered,
      durationMs: Date.now() - started,
      reason: `${ran}_users_ran`
    });

    process.exit(0);
  } catch (err) {
    // Never the message: it can quote vendor payloads or model output.
    logger.error('daily_job_crashed', { status: 500, name: err?.name || 'unknown' });
    process.exit(1);
  }
}

main();
