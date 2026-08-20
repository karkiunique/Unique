-- VoiceReach — migration 008: the daily draft queue
--
-- WHY THIS EXISTS: a daily job finds up to ~2 solid leads per user against a standing ICP, researches
-- them, drafts a letter in the user's voice, and notifies the USER that drafts are ready. The user
-- reviews and sends each one. See CLAUDE.md, Decisions 2026-08-16 for the eight gates, the
-- ceiling-not-quota rule, and why this is a cron rather than a queue.
--
-- Append-only: 001-007 are not touched.
-- Idempotent: safe to paste into the Supabase SQL Editor more than once.

-- ---------------------------------------------------------------------------
-- lead_targets — ONE standing ICP per user
-- ---------------------------------------------------------------------------

create table if not exists public.lead_targets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,

  -- Structured criteria: these drive the vendor query, so they are columns rather than free text.
  titles text[],
  seniority text[],
  industries text[],
  company_size text,
  geos text[],

  -- Negative criteria. Part of the target, not an afterthought — excluding competitors and existing
  -- customers removes a whole class of obviously-wrong lead before a credit is ever spent.
  exclude_domains text[],
  exclude_industries text[],

  -- Free text, in the user's own words, about what makes a good fit. Goes to the MODEL for the
  -- hook-quality judgement (gate 7), not to the vendor query. This is user-authored content about
  -- their own business: same handling as campaigns.brief — never logged, never in an error message.
  fit_notes text,

  -- The CEILING, not a quota (Decisions 2026-08-16). Capped at 5: this product is not a blaster, and
  -- a user who wants 50 a day wants a different product.
  daily_target int default 2 check (daily_target between 1 and 5),

  active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),

  -- One standing target per user. Deliberate: "set it once and the job hunts against it" is the whole
  -- model. If multiple targets are ever wanted, that is a schema change and a product decision, not
  -- something to leave a door open for by accident.
  unique(user_id)
);

create index if not exists lead_targets_active_idx on public.lead_targets (active) where active;

-- ---------------------------------------------------------------------------
-- daily_runs — the idempotency key
-- ---------------------------------------------------------------------------
--
-- A cron has no broker to dedupe for it. This row is what stops a crashed-and-retried run
-- double-drafting or double-notifying, so it is INSERTED BEFORE ANY WORK STARTS and the unique
-- constraint is the guard — not a SELECT-then-INSERT, which races with itself.

create table if not exists public.daily_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  run_date date not null,

  -- 'empty' is a SUCCESS, not a failure: no candidate cleared the eight gates, which is a valid and
  -- expected outcome of a ceiling-not-quota design. Only 'failed' means something went wrong.
  status text default 'running' check (status in ('running','delivered','empty','failed')),

  candidates_screened int default 0,
  leads_delivered int default 0,

  -- Separate from status so a run that delivered drafts but failed to send the notification can be
  -- retried for the NOTIFICATION ONLY, without re-drafting anything.
  notified_at timestamptz,

  created_at timestamptz default now(),

  unique(user_id, run_date)
);

create index if not exists daily_runs_pending_notify_idx
  on public.daily_runs (run_date)
  where notified_at is null;

-- ---------------------------------------------------------------------------
-- lead_rejections — why a lead was turned down
-- ---------------------------------------------------------------------------
--
-- The highest-signal, cheapest feedback available when the user only sees two leads a day.
--
-- THIS IS A THIRD LEARNING LOOP AND MUST NOT BE MERGED WITH THE OTHER TWO.
--   profile_json.learned_corrections  learns how the user WRITES        (from their edits)
--   the adaptation loop (2026-08-12)  learns what GETS REPLIES          (from outcomes)
--   this                              learns WHO TO APPROACH            (from rejections)
-- Three different questions. 2026-08-12 already forbids merging the first two.

create table if not exists public.lead_rejections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,

  -- A closed set, because free text cannot be aggregated into a targeting signal.
  reason text not null check (reason in ('wrong_role','wrong_company','bad_timing','weak_hook','other')),

  -- Optional elaboration. User-authored: same handling as fit_notes.
  note text,

  created_at timestamptz default now()
);

create index if not exists lead_rejections_user_idx on public.lead_rejections (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- RLS — the standard posture for these three: they have an owner, so they get the owner policy.
-- (Unlike `waitlist` in 007, whose rows have no owner and are therefore deny-all.)
-- The server uses the service-role key and bypasses all of this; these policies exist so that a
-- leaked anon key cannot read one user's targeting or another's rejected leads.
-- ---------------------------------------------------------------------------

alter table public.lead_targets enable row level security;
alter table public.daily_runs enable row level security;
alter table public.lead_rejections enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'lead_targets' and policyname = 'own_lead_targets') then
    create policy own_lead_targets on public.lead_targets
      for all using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;

  if not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'daily_runs' and policyname = 'own_daily_runs') then
    create policy own_daily_runs on public.daily_runs
      for all using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;

  if not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'lead_rejections' and policyname = 'own_lead_rejections') then
    create policy own_lead_rejections on public.lead_rejections
      for all using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- verification — commented out on purpose so pasting this file applies the migration only.
-- ---------------------------------------------------------------------------

-- -- 1. the three tables exist
-- select table_name from information_schema.tables
-- where table_schema = 'public' and table_name in ('lead_targets','daily_runs','lead_rejections');

-- -- 2. RLS on, one policy each (expect three rows, rls_enabled = true)
-- select c.relname, c.relrowsecurity as rls_enabled,
--        (select count(*) from pg_policies p where p.schemaname='public' and p.tablename=c.relname) as policies
-- from pg_class c join pg_namespace n on n.oid = c.relnamespace
-- where n.nspname='public' and c.relname in ('lead_targets','daily_runs','lead_rejections');

-- -- 3. the idempotency guard is real: this must raise a unique violation on the second run
-- -- insert into public.daily_runs (user_id, run_date) values ('<a-user-id>', current_date);
