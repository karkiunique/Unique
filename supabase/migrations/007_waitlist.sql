-- VoiceReach — migration 007: the landing-page waitlist
--
-- WHY THIS EXISTS: the public landing page (Decisions, 2026-08-15) captures waitlist signups and
-- shows a live count. The prototype faked both in localStorage, which is per-device and therefore
-- not a count of anything. This is the real, shared store behind it.
--
-- WHY IT LOOKS DIFFERENT FROM EVERY OTHER TABLE: a person on the waitlist is NOT a user. There is no
-- profiles row, no auth.users row, and no auth.uid() to scope them by, so the standard
-- `user_id = auth.uid()` policy is not expressible here. See the RLS block below for what replaces
-- it.
--
-- Append-only: 001-006 are not touched.
-- Idempotent: safe to paste into the Supabase SQL Editor more than once.

-- ---------------------------------------------------------------------------
-- table
-- ---------------------------------------------------------------------------

create table if not exists public.waitlist (
  id uuid primary key default gen_random_uuid(),

  -- Stored lowercased and trimmed by the server before it ever gets here. The unique constraint is
  -- what makes a re-submit idempotent rather than a duplicate row or an error the visitor has to
  -- read: the route upserts and hands back the seat already held.
  email text not null unique,

  -- The person's permanent number — the "You're No. N" on the confirmation.
  --
  -- WHY AN IDENTITY COLUMN: Postgres issues it atomically, so two concurrent signups cannot be
  -- handed the same number, and it is never re-used after a delete, so a withdrawn signup cannot
  -- silently renumber the people behind it.
  --
  -- NOT the counter. The displayed count is `88 + count(*)` (see services/waitlist.js): an identity
  -- value is spent by `ON CONFLICT DO NOTHING` even when no row is written, so max(seat) drifts
  -- above the number of people actually on the list. The server avoids burning values by looking an
  -- address up before inserting, but the counter must not depend on that holding forever.
  --
  -- Starts at 89 because the counter is offset by 88: the first real signup is No. 89.
  seat bigint generated always as identity (start with 89) unique,

  created_at timestamptz default now(),

  -- Null until the go-live onboarding mail goes out. Exists NOW, before that mail is built, so the
  -- send is resumable and can never mail the same person twice — a column that has to be added
  -- halfway through a one-shot bulk send is a column added too late.
  invited_at timestamptz
);

-- The counter reads max(seat) on every landing-page view. Postgres can answer that from the unique
-- index on seat alone, but only if it exists — and `unique` above creates it. No extra index needed.
-- created_at gets one because the go-live send will page through in signup order.
create index if not exists waitlist_created_at_idx on public.waitlist (created_at);

-- ---------------------------------------------------------------------------
-- RLS — deny-all, which is stricter than the rest of the schema and meant to be
-- ---------------------------------------------------------------------------
--
-- Every other table gets `user_id = auth.uid()`. That is not available here: these rows have no
-- owner. Enabling RLS with NO POLICY denies anon and authenticated outright — with RLS on, anything
-- without a matching policy is refused — while the service-role key the server uses bypasses RLS
-- entirely. So the list is reachable from /server and nowhere else.
--
-- This matters more than usual: every row in this table is an email address, and unlike `leads`
-- (which at least belongs to the user who uploaded it) there is no one who is legitimately entitled
-- to read this list through the API. The anon key ships in the browser; it must not be able to
-- enumerate the waitlist.

alter table public.waitlist enable row level security;

-- Belt and braces: revoke the table grants the anon/authenticated roles get by default, so the
-- deny-all does not rest on RLS alone. A future migration that adds a permissive policy by accident
-- still finds no grant underneath it.
revoke all on public.waitlist from anon, authenticated;

-- ---------------------------------------------------------------------------
-- verification — commented out on purpose so pasting this file applies the migration only.
-- ---------------------------------------------------------------------------

-- -- 1. the table exists with the expected columns
-- select column_name, data_type, is_nullable, is_identity from information_schema.columns
-- where table_schema = 'public' and table_name = 'waitlist' order by ordinal_position;

-- -- 2. RLS is on and there are NO policies (expect: rowsecurity = true, policy count = 0)
-- select c.relrowsecurity as rls_enabled,
--        (select count(*) from pg_policies p
--         where p.schemaname = 'public' and p.tablename = 'waitlist') as policy_count
-- from pg_class c join pg_namespace n on n.oid = c.relnamespace
-- where n.nspname = 'public' and c.relname = 'waitlist';

-- -- 3. the counter and the next seat (expect 88 and 89 on an empty table)
-- select coalesce(max(seat), 88) as display_count from public.waitlist;
