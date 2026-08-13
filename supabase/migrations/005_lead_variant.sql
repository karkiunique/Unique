-- VoiceReach — migration 005: record WHICH variant each letter used
--
-- WHY THIS EXISTS, AND WHY NOW: the adaptation loop (reply outcomes biasing future variant choice)
-- is blocked until Phase 4 builds replyWatcher — nothing writes `replied` yet. But every letter sent
-- between now and then is a lost data point unless we record, at generation time, which variant it
-- used. Reconstructing that later by parsing a body is lossy, and it cannot recover a distinction
-- the generator made but never wrote down. So the column lands now and nothing reads it yet.
--
-- Shape: {opener_starter, cta_form, length_band, profile_version}
--   opener_starter  which of the user's OWN sentence_starters was drawn
--   cta_form        which of their OWN ask forms (how_they_ask) was used
--   length_band     short | mid | long, relative to their typical_length_words median
--   profile_version voice_profiles.version at generation time — variant performance is NOT
--                   comparable across a re-synced profile, so comparisons must be version-scoped
--
-- NOT A NEW EXPOSURE CLASS. These reference the user's own profile entries, which already live in
-- voice_profiles.profile_json, and `generated_body` is already a column on this table. No recipient
-- data, no third-party PII. Still covered by CLAUDE.md § Privacy: never logged.
--
-- Append-only: 001-004 are not touched. 001 already enables row level security on leads and defines
-- its policies, so this migration adds NO policies, grants or roles.
--
-- Idempotent: safe to paste into the Supabase SQL Editor more than once.

-- ---------------------------------------------------------------------------
-- column
-- ---------------------------------------------------------------------------

alter table public.leads add column if not exists variant_json jsonb;

-- ---------------------------------------------------------------------------
-- index
-- ---------------------------------------------------------------------------

-- The adaptation loop's read pattern: this user's replied-or-not letters, by variant. A partial
-- index keeps it off the rows that have no variant recorded (everything generated before 005).
create index if not exists leads_user_id_variant_idx
  on public.leads (user_id, status)
  where variant_json is not null;

-- ---------------------------------------------------------------------------
-- verification — commented out on purpose so pasting this file applies the migration only.
-- ---------------------------------------------------------------------------

-- select column_name, data_type from information_schema.columns
-- where table_schema = 'public' and table_name = 'leads' and column_name = 'variant_json';
