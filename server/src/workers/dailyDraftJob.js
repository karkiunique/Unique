import pLimit from 'p-limit';

import { logger } from '../lib/logger.js';
import { claimRun, completeRun, markNotified, failRun, today } from '../services/dailyRun.js';
import { listActiveTargets } from '../services/leadTargets.js';
import { getOrCreateDailyCampaign } from '../services/dailyCampaign.js';
import { screenCandidate, passesFidelityGate, screeningBudget, GATE } from '../services/leadGates.js';
import { findCandidates } from '../services/leadSource.js';
import { notifyDraftsReady } from '../services/notify.js';
import { getSupabaseAdmin } from '../lib/supabase.js';

/**
 * The daily draft job (CLAUDE.md, Decisions 2026-08-16).
 *
 * Find → research → draft → notify. **The send is not here and never will be.**
 * Every lead this produces lands in the review queue as `generated`, and reaches a
 * prospect only when the user approves it one at a time (2026-08-08).
 *
 * A CRON, NOT A QUEUE. At two leads per user per day even a hundred users is two
 * hundred leads, and none of BullMQ's reasons for existing — 90-240s send spacing,
 * per-user daily limits, per-job retries — apply to drafting. What a queue would
 * have given us for free is deduplication, so that is bought explicitly with the
 * `daily_runs` claim below.
 *
 * THE CEILING RULE governs the whole file: `daily_target` is a maximum, never a
 * quota. If one candidate clears the gates, one draft is delivered. If none do,
 * the run ends `empty` and the user is not emailed at all. Nothing here may be
 * loosened to hit a number.
 */

// One user at a time across users, so a slow vendor cannot fan out into hundreds
// of concurrent calls. Within a user, drafting is already serialised by the gates.
const USER_CONCURRENCY = 3;

/** Addresses this user has already got, so the job never re-contacts anyone. */
async function knownAddresses(userId) {
  const db = getSupabaseAdmin();

  const [{ data: leads }, { data: unsubscribed }] = await Promise.all([
    db.from('leads').select('email').eq('user_id', userId),
    db.from('unsubscribes').select('email').eq('user_id', userId)
  ]);

  return {
    existingEmails: new Set((leads ?? []).map((row) => String(row.email).toLowerCase())),
    unsubscribedEmails: new Set((unsubscribed ?? []).map((row) => String(row.email).toLowerCase()))
  };
}

/**
 * Screen candidates until the ceiling is met or the pool runs out.
 *
 * Returns the survivors AND the tally of why the rest failed — which is what tells
 * you whether an ICP is too narrow or the research step is underperforming. That
 * tally is counts only; no address ever enters it.
 */
function screenAll(candidates, target, context, ceiling) {
  const accepted = [];
  const failures = {};

  for (const candidate of candidates) {
    if (accepted.length >= ceiling) break;

    const { passed, failedGate } = screenCandidate(candidate, target, context);

    if (passed) {
      accepted.push(candidate);
      // Within one run, a second candidate at the same address is a duplicate too.
      context.existingEmails.add(String(candidate.email).toLowerCase());
    } else {
      failures[failedGate] = (failures[failedGate] ?? 0) + 1;
    }
  }

  return { accepted, failures };
}

/**
 * Draft one letter and apply gate 8.
 *
 * `draftLead` is injected rather than imported so the job can be exercised without
 * an Anthropic key — Stage A runs end to end on seeded candidates before any
 * vendor exists (Decisions 2026-08-16, the Stage A/B split).
 */
async function draftAndGate(draftLead, userId, campaignId, candidate) {
  const draft = await draftLead(userId, campaignId, candidate);

  if (!passesFidelityGate(draft?.fidelityScore)) {
    // BLOCKS, unlike the batch review screen which flags. With two slots a day a
    // draft that does not sound like the user wastes half the day's value.
    logger.info('daily_draft_below_floor', { userId, score: draft?.fidelityScore ?? 0 });
    return null;
  }

  return draft;
}

/**
 * One user's day.
 *
 * Returns `{ ran: false }` when the day was already claimed — that is the normal
 * result of a retry and is never an error.
 */
export async function runForUser(target, deps, runDate = today()) {
  const { draftLead, notify = notifyDraftsReady, findLeads = findCandidates } = deps;
  const userId = target.user_id;

  // THE CLAIM COMES FIRST. Nothing above this line may touch a vendor, the model,
  // or the user's inbox, because everything above this line can run twice.
  const run = await claimRun(userId, runDate);
  if (!run) return { ran: false, reason: 'already_claimed' };

  try {
    const ceiling = target.daily_target ?? 2;
    const context = await knownAddresses(userId);

    const candidates = await findLeads(target, screeningBudget(ceiling));
    const { accepted, failures } = screenAll(candidates, target, context, ceiling);

    logger.info('daily_screened', {
      userId,
      count: candidates.length,
      reason: Object.keys(failures).join(',') || 'none'
    });

    let delivered = 0;

    if (accepted.length > 0) {
      const campaign = await getOrCreateDailyCampaign(userId, target.fit_notes);

      for (const candidate of accepted) {
        const draft = await draftAndGate(draftLead, userId, campaign.id, candidate);
        if (draft) delivered += 1;
      }
    }

    await completeRun(run.id, {
      candidatesScreened: candidates.length,
      leadsDelivered: delivered
    });

    // No drafts, no email. "0 drafts ready" is worse than silence, and the
    // ceiling-not-quota rule makes an empty day an ordinary outcome.
    if (delivered > 0) {
      const email = await userEmail(userId);
      if (email) {
        const result = await notify(email, delivered);
        // Only mark notified if it actually went. An unmarked run can be retried
        // for the notification alone, without re-drafting anything.
        if (result?.sent) await markNotified(run.id);
      }
    }

    return { ran: true, screened: candidates.length, delivered, failures };
  } catch (err) {
    await failRun(run.id, userId);
    throw err;
  }
}

/** The user's own address, for the notification. Never a prospect's. */
async function userEmail(userId) {
  const { data } = await getSupabaseAdmin()
    .from('profiles')
    .select('email')
    .eq('id', userId)
    .maybeSingle();

  return data?.email ?? null;
}

/**
 * The entrypoint a scheduled invocation calls.
 *
 * Runs as a Railway scheduled job, NOT an in-process `node-cron` timer: an
 * in-process timer dies silently on redeploy, mid-run, and the failure is
 * invisible until someone notices nobody got drafts.
 */
export async function runDailyDrafts(deps) {
  const targets = await listActiveTargets();
  const limit = pLimit(USER_CONCURRENCY);

  logger.info('daily_job_start', { count: targets.length });

  const results = await Promise.all(
    targets.map((target) =>
      limit(async () => {
        try {
          return await runForUser(target, deps);
        } catch {
          // One user's bad day must not end everyone else's. failRun has already
          // recorded it against that user's run row.
          return { ran: false, reason: 'failed' };
        }
      })
    )
  );

  const delivered = results.reduce((total, result) => total + (result.delivered ?? 0), 0);

  logger.info('daily_job_done', { count: delivered });

  return results;
}

export { GATE };
