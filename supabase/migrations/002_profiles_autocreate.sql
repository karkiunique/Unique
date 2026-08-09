-- VoiceReach — migration 002: auto-create a `profiles` row for every new auth user
--
-- WHY THIS EXISTS: nothing creates a profiles row. Migration 001 defines the table but no trigger,
-- and /server never inserts one — the only writes are two statements in services/gmail.js and one
-- in services/send.js, all of which UPDATE a row they assume already exists. So a brand new signup
-- gets an auth.users row and no profile, and the first Gmail connect 404s: handleCallback updates
-- by id and cannot upsert, because profiles.email is NOT NULL and the OAuth callback has no
-- verified email to supply. Until now the only remedy was a hand-written backfill.
--
-- IMPORTANT: the trigger FAILS OPEN. If the insert raises for any reason it emits a WARNING and
-- still lets the signup complete. A missing profile row is exactly today's behaviour and is
-- recoverable by re-running the backfill at the bottom of this file; a trigger that throws on
-- auth.users takes AUTHENTICATION DOWN for the entire project. The WARNING is the point — it lands
-- in the Postgres logs, so the fallback is loud rather than a silent repeat of the current bug.
--
-- Idempotent: safe to paste into the Supabase SQL Editor more than once.

-- ---------------------------------------------------------------------------
-- trigger function
--
-- `security definer` because Supabase Auth inserts into auth.users as its own role, which has no
-- rights on public.profiles.
--
-- `set search_path = ''` is mandatory on a security definer function: with an unpinned search_path
-- a caller can put a schema of their own ahead of `public` and capture an unqualified object
-- reference, running their code with this function's elevated rights. Every reference below is
-- therefore fully qualified (public.profiles, auth.users).
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Inner block so a failure is caught here and cannot propagate to the auth.users insert.
  begin
    -- coalesce: profiles.email is NOT NULL but auth.users.email is nullable for phone and
    -- anonymous sign-ins — an unguarded insert would throw on those and take signup with it.
    -- on conflict: keeps this idempotent against re-runs and against a race with the backfill.
    insert into public.profiles (id, email)
    values (new.id, coalesce(new.email, ''))
    on conflict (id) do nothing;
  exception
    when others then
      -- The user id and SQLERRM only. CLAUDE.md § Privacy permits IDs in logs; a UUID is not PII
      -- the way an address is. Never interpolate new.email or any other user value here.
      raise warning 'handle_new_user: profile insert failed for %, allowing signup to proceed: %',
        new.id, sqlerrm;
  end;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- trigger
-- dropped first so the migration can be re-run without erroring on an existing trigger.
-- ---------------------------------------------------------------------------

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- backfill
-- one-time catch-up for auth.users rows that predate the trigger (including any the repo owner
-- already fixed by hand). `on conflict do nothing` makes re-running it a no-op.
-- ---------------------------------------------------------------------------

insert into public.profiles (id, email)
select id, coalesce(email, '')
from auth.users
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- verification — commented out on purpose so pasting this file applies the migration only.
-- Run these by hand afterwards; both should confirm the fix.
-- ---------------------------------------------------------------------------

-- -- 1. the trigger exists and is attached to auth.users (expect exactly one row)
-- select tgname, tgrelid::regclass as table_name, tgenabled
-- from pg_trigger
-- where tgname = 'on_auth_user_created' and not tgisinternal;

-- -- 2. every auth user now has a profile (expect missing_profiles = 0)
-- select count(*) as missing_profiles
-- from auth.users u
-- left join public.profiles p on p.id = u.id
-- where p.id is null;
