-- VoiceReach — migration 009: a rejected lead is not a failed one
--
-- WHY THIS EXISTS: `POST /leads/:id/reject` needs a status meaning "the human declined this letter".
-- The obvious candidate, 'failed', is already taken and means something else — GENERATION failed —
-- and `services/leadRegenerate.js` lists 'failed' in REDRAFTABLE_FROM. Reusing it would have made a
-- letter a person explicitly refused eligible for redrafting, which is the system overriding a human
-- decision. That is the same class of mistake as a UI-only gate: quiet, plausible, and wrong.
--
-- 'rejected' is in no redraftable set, is excluded from the review queue, and is distinguishable in
-- the register from a draft that broke.
--
-- Append-only: 001-008 are not touched. The check constraint is replaced in place because a check
-- constraint cannot be extended, only dropped and recreated. Every existing value is preserved in
-- the new list, so no row can be invalidated by this.
--
-- Idempotent: safe to paste into the Supabase SQL Editor more than once.

alter table public.leads drop constraint if exists leads_status_check;

alter table public.leads add constraint leads_status_check check (
  status in (
    'pending',
    'generated',
    'approved',
    'queued',
    'sent',
    'replied',
    'bounced',
    'unsubscribed',
    'failed',      -- generation broke
    'rejected'     -- a human said no. NOT redraftable.
  )
);

-- ---------------------------------------------------------------------------
-- verification — commented out on purpose so pasting this file applies the migration only.
-- ---------------------------------------------------------------------------

-- -- 1. the constraint now admits 'rejected' (expect the full list including it)
-- select pg_get_constraintdef(oid) from pg_constraint where conname = 'leads_status_check';

-- -- 2. nothing was invalidated (expect zero rows)
-- select status, count(*) from public.leads
-- where status not in ('pending','generated','approved','queued','sent','replied',
--                      'bounced','unsubscribed','failed','rejected')
-- group by status;
