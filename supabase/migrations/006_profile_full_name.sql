-- VoiceReach — migration 006: the sign-off name
--
-- WHY THIS EXISTS: CLAUDE.md § 3 requires every generated email to sign off as the user, by name,
-- and treats a missing sign-off as a guardrail violation. The only deterministic enforcement,
-- findMissingSignoff(), returns [] when signoff_styles is empty — it cannot match a closing against
-- a list that does not exist. So a BRAND-NEW user got no sign-off enforcement at all, and it
-- compounded: a new user usually has no exemplars either, so the prompt's fallback pointed at
-- example emails that were not in the prompt. The guarantee was strongest for established users and
-- weakest for first-time senders, and it failed silently.
--
-- profiles.full_name is now THE authoritative sign-off name, collected as a required field at
-- account creation. Chosen over deriving it from Google OAuth or the email local-part: a local-part
-- is wrong often enough to be embarrassing on a cold email, and OAuth adds a data dependency for
-- something the user can simply type.
--
-- WHY NULLABLE, given it is "required": pre-006 accounts exist and a name cannot be invented for
-- them. A NOT NULL here would also break handle_new_user() for any path that has no metadata, and
-- that trigger is deliberately fail-open (002) because a throwing trigger on auth.users takes
-- authentication down entirely. Required is therefore enforced by the APP at signup, not by the
-- column. Legacy rows are prompted on next login; until they answer, the sign-off check falls back
-- to the style-based test — safe because a legacy account is by definition an established one that
-- already has signoff_styles. A null name must never throw on the send path.
--
-- Append-only: 001-005 are not touched, except that handle_new_user() is replaced in place below so
-- the name arrives WITH the profile row rather than needing a second write.
--
-- Idempotent: safe to paste into the Supabase SQL Editor more than once.

-- ---------------------------------------------------------------------------
-- column
-- ---------------------------------------------------------------------------

alter table public.profiles add column if not exists full_name text;

-- ---------------------------------------------------------------------------
-- trigger — replaces the 002 version, adding full_name from the signup metadata.
-- Everything else about it is unchanged and deliberately so: the inner block, the fail-open
-- exception handler, the coalesce on email, and the on-conflict are all load-bearing (see 002).
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
    -- full_name comes from the signup metadata the web client passes; nullif('') keeps a blank
    -- from being stored as a name, so the app sees "absent" rather than "present but empty".
    -- on conflict: keeps this idempotent against re-runs and against a race with the backfill.
    insert into public.profiles (id, email, full_name)
    values (
      new.id,
      coalesce(new.email, ''),
      nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), '')
    )
    on conflict (id) do nothing;
  exception
    when others then
      -- The user id and SQLERRM only. CLAUDE.md § Privacy permits IDs in logs; a UUID is not PII
      -- the way an address is. Never interpolate new.email, the name, or any other user value here.
      raise warning 'handle_new_user: profile insert failed for %, allowing signup to proceed: %',
        new.id, sqlerrm;
  end;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- backfill for accounts that signed up BEFORE this migration but AFTER 002, whose metadata may
-- already carry a name. Only fills a row that has none — never overwrites a name a user has set.
-- Anyone still null after this is prompted on next login.
-- ---------------------------------------------------------------------------

update public.profiles as p
set full_name = nullif(trim(coalesce(u.raw_user_meta_data ->> 'full_name', '')), '')
from auth.users as u
where u.id = p.id
  and p.full_name is null
  and nullif(trim(coalesce(u.raw_user_meta_data ->> 'full_name', '')), '') is not null;

-- ---------------------------------------------------------------------------
-- verification — commented out on purpose so pasting this file applies the migration only.
-- ---------------------------------------------------------------------------

-- -- 1. the column exists
-- select column_name, data_type, is_nullable from information_schema.columns
-- where table_schema = 'public' and table_name = 'profiles' and column_name = 'full_name';

-- -- 2. how many accounts still need the login prompt (expect: your pre-006 users)
-- select count(*) filter (where full_name is null) as needs_prompt,
--        count(*) filter (where full_name is not null) as has_name
-- from public.profiles;
