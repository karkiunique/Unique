# The daily draft job — running it

Find → research → draft → notify. **The send is not in this job and never will be.** Everything it
produces lands in the review queue as `generated` and reaches a prospect only when the user approves
it, one letter at a time.

See CLAUDE.md, Decisions 2026-08-16 for the eight gates and the ceiling-not-quota rule.

## Running it by hand

```bash
cd server && node src/workers/runDailyDrafts.js
```

Safe to run whenever you like. `daily_runs` carries a unique `(user_id, run_date)` and claiming it is
the first thing each user's run does, so a second invocation on the same day claims nothing, does
nothing, and exits 0. Verified against the live database: a double-fired schedule logs
`daily_run_already_claimed` and `0_users_ran`.

## Railway

**A scheduled job, not an in-process timer.** A `node-cron` inside the API dies silently on redeploy,
mid-run, and nobody finds out until a user asks where their drafts went.

    Service → Settings → Cron Schedule
    Command:   node src/workers/runDailyDrafts.js
    Schedule:  0 6 * * *

06:00 UTC. Timezones are deferred — § 4 already says UTC for now — so a user in California gets their
drafts around 22:00 the previous evening. Fine for a review queue; revisit if it ever drives a send.

The job needs the same environment as the API, plus Postmark:

| Variable | Without it |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | job cannot start |
| `ANTHROPIC_API_KEY` | candidates screen but nothing drafts |
| `TOKEN_ENC_KEY` | exemplars cannot be decrypted; drafts lose their few-shot anchors |
| `POSTMARK_API_TOKEN`, `POSTMARK_FROM_EMAIL` | drafts are produced, nobody is told |
| `APP_URL` | the review link in the notification points at localhost |

A missing Postmark token is deliberately **not** fatal: `sendSystemEmail` resolves rather than throws,
so an unconfigured provider cannot waste a run that already produced good letters. The run stays
retryable for the notification alone, because `notified_at` is written separately from `status`.

## Reading a run

Every line is counts and ids — never an address, never a letter.

| Event | Means |
|---|---|
| `daily_job_start` | how many active targets were found |
| `daily_run_already_claimed` | a second invocation. Correct, not an error |
| `lead_source_unconfigured` | **Stage B is not built.** Expected today |
| `daily_screened` | candidates seen, and which gates rejected the rest |
| `daily_draft_below_floor` | a draft scored under 80 and was dropped, not queued |
| `daily_run_complete` with `reason: empty` | **a success.** Nothing cleared the bar |
| `daily_job_finished` | letters delivered across all users |

`reason` on `daily_screened` is the gate tally — the fastest read on whether an ICP is too narrow or
the research step is underperforming.

## What it does today

**Nothing, on purpose.** `services/leadSource.js` returns `[]` because Stage B is blocked on a
licence, not on engineering — see the Apollo §2/§3/§5(i) findings in the Decisions log. Every run
therefore completes as `empty`.

Everything above the source is built and exercised: the claim, the gates, drafting, the fidelity
floor, the queue, the notification. When a licensed source lands, `findCandidates` is the only
function that changes.

To exercise the full pipeline before then, inject candidates directly:

```js
import { runForUser } from './src/workers/dailyDraftJob.js';

await runForUser(target, {
  draftLead,
  findLeads: async () => [
    {
      email: 'dana@example.org',
      title: 'Director of Technology',
      verification: { status: 'deliverable' },
      research: { hooks: ['They rolled out 1:1 Chromebooks across twelve schools last September.'] }
    }
  ]
});
```

A candidate missing `verification.status === 'deliverable'` or a hook of real substance will be
rejected by the gates, which is the point — see `tests/leadGates.test.js` for the shapes that fail.
