-- VoiceReach — migration 003: record the Gmail ids of the mail WE sent
--
-- WHY THIS EXISTS: the register screen listed the user's entire `in:sent`, personal mail included.
-- That is wrong product behaviour and more exposure than intended — the register must show only mail
-- sent FROM Unique. Nothing we store today can tell a Unique-sent message apart from one the user
-- wrote in Gmail themselves, so there was no way to express "ours only". These two columns are that
-- way: we record what we send, and the listing reads back from here instead of searching Gmail.
--
-- Rejected alternatives: a Gmail label would need `gmail.modify`, which is deliberately unrequested;
-- a custom MIME header is unusable because Gmail search cannot query arbitrary headers.
--
-- IDS ONLY. Never the subject, never the recipient, never the body. Those are fetched from Gmail
-- per request and stay in process memory, exactly as before (CLAUDE.md § Privacy & data protection,
-- and Decisions 2026-08-06). The persistence posture widens by two opaque identifiers, which is the
-- minimum that makes "only ours" expressible.
--
-- Append-only: 001 and 002 are not touched. 001 already enables row level security on send_log and
-- defines its four policies, so this migration adds NO policies, grants or roles.
--
-- Idempotent: safe to paste into the Supabase SQL Editor more than once.

-- ---------------------------------------------------------------------------
-- columns
-- ---------------------------------------------------------------------------

alter table public.send_log add column if not exists gmail_message_id text;
alter table public.send_log add column if not exists gmail_thread_id text;

-- ---------------------------------------------------------------------------
-- indexes
-- ---------------------------------------------------------------------------

-- Idempotent recording: a retry after a send that actually succeeded must not create a second row.
-- Postgres treats NULLs as DISTINCT in a unique index, so every existing row (and any future
-- campaign row that has no Gmail id yet) is unaffected — only real message ids collide.
create unique index if not exists send_log_user_id_gmail_message_id_key
  on public.send_log (user_id, gmail_message_id);

-- The listing query: this user's rows, newest first.
create index if not exists send_log_user_id_sent_at_idx
  on public.send_log (user_id, sent_at desc);

-- ---------------------------------------------------------------------------
-- verification — commented out on purpose so pasting this file applies the migration only.
-- Run these by hand afterwards; both should confirm the change landed.
-- ---------------------------------------------------------------------------

-- -- 1. the two id columns exist on send_log (expect exactly two rows, both text)
-- select column_name, data_type, is_nullable
-- from information_schema.columns
-- where table_schema = 'public'
--   and table_name = 'send_log'
--   and column_name in ('gmail_message_id', 'gmail_thread_id')
-- order by column_name;

-- -- 2. the idempotency index exists and is unique (expect one row, indisunique = true)
-- select indexname, indexdef
-- from pg_indexes
-- where schemaname = 'public'
--   and tablename = 'send_log'
--   and indexname = 'send_log_user_id_gmail_message_id_key';
