-- VoiceReach — migration 004: what the campaign is actually about
--
-- WHY THIS EXISTS: generation had no goal to work from. `campaignGoal()` fell back to the campaign
-- NAME, so a campaign called "First test" produced six letters about running a first test — subjects
-- came out as "First test", one body ended "Just testing to make sure things are working on my end."
-- CLAUDE.md § 3 had always listed "the user's campaign goal" as a prompt input. No column held one.
--
-- `brief`          the user's own in-depth description of the email, written in the campaign builder.
--                  This, not the name, is the generation goal.
-- `clarifications` [{question, answer}] from the clarify pass. `answer` may be null — a skipped
--                  question is a first-class outcome and never blocks drafting.
--
-- BOTH ARE USER-AUTHORED CONTENT ABOUT THEIR OWN BUSINESS. Treat them exactly like `template_body`
-- under CLAUDE.md § Privacy: never logged, never in an error message, never in a log line's fields.
--
-- Append-only: 001, 002 and 003 are not touched. 001 already enables row level security on campaigns
-- and defines its policies, so this migration adds NO policies, grants or roles.
--
-- Idempotent: safe to paste into the Supabase SQL Editor more than once.

-- ---------------------------------------------------------------------------
-- columns
-- ---------------------------------------------------------------------------

alter table public.campaigns add column if not exists brief text;
alter table public.campaigns add column if not exists clarifications jsonb;

-- ---------------------------------------------------------------------------
-- verification — commented out on purpose so pasting this file applies the migration only.
-- Run this by hand afterwards; expect exactly two rows.
-- ---------------------------------------------------------------------------

-- select column_name, data_type, is_nullable
-- from information_schema.columns
-- where table_schema = 'public'
--   and table_name = 'campaigns'
--   and column_name in ('brief', 'clarifications')
-- order by column_name;
