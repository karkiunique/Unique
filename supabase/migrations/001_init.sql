-- VoiceReach — migration 001: initial schema + row level security
--
-- IMPORTANT: the Express server talks to Postgres with the Supabase SERVICE-ROLE key,
-- which BYPASSES row level security. The policies below exist to protect the browser
-- (anon/authenticated) client, which in this product is only ever used for Supabase Auth.
-- All application data access goes through /server. Never ship the service-role key to the client.

-- ---------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------

-- users handled by supabase auth; profile extension:
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  gmail_connected boolean default false,
  gmail_refresh_token_enc text,      -- AES-256-GCM encrypted app-side (TOKEN_ENC_KEY). NEVER stored plaintext, including in dev.
  daily_send_limit int default 30,
  created_at timestamptz default now()
);

create table voice_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade,
  profile_json jsonb not null,       -- the style guide
  exemplars_enc text,                -- AES-256-GCM encrypted JSON array of 5-8 representative sent emails (few-shot anchors). User consents at onboarding; deletable in Settings.
  source_email_count int,
  version int default 1,             -- bumped on every re-sync
  last_synced_at timestamptz default now(),
  created_at timestamptz default now()
);

create table campaigns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade,
  name text not null,
  mode text not null check (mode in ('voice','template')),
  template_body text,                -- null in voice mode; may contain {{first_name}}, {{company}}, {{personalized}}
  subject_template text,
  status text default 'draft' check (status in ('draft','generating','review','sending','paused','done')),
  created_at timestamptz default now()
);

create table leads (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references campaigns(id) on delete cascade,
  user_id uuid references profiles(id) on delete cascade,
  email text not null,
  first_name text, last_name text, company text, title text, linkedin_url text,
  research_json jsonb,               -- tavily/apollo enrichment
  generated_subject text,
  generated_body text,
  edited_body text,                  -- user's manual edit wins over generated
  fidelity_score int,                -- 0-100 from the generation fidelity check; <80 flags "low fidelity" in review UI
  status text default 'pending' check (status in ('pending','generated','approved','queued','sent','replied','bounced','unsubscribed','failed')),
  sent_at timestamptz, replied_at timestamptz,
  gmail_message_id text, gmail_thread_id text,
  created_at timestamptz default now()
);

create table unsubscribes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade,
  email text not null,
  created_at timestamptz default now(),
  unique(user_id, email)
);

create table send_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id),
  lead_id uuid references leads(id),
  sent_at timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- row level security
-- enabled on every table; policy = user_id = auth.uid() for select/insert/update/delete.
-- profiles keys on `id` (it is the auth.users id), so its policies use `id`.
-- ---------------------------------------------------------------------------

alter table profiles enable row level security;
alter table voice_profiles enable row level security;
alter table campaigns enable row level security;
alter table leads enable row level security;
alter table unsubscribes enable row level security;
alter table send_log enable row level security;

-- profiles ------------------------------------------------------------------
create policy profiles_select_own on profiles
  for select to authenticated using (id = auth.uid());
create policy profiles_insert_own on profiles
  for insert to authenticated with check (id = auth.uid());
create policy profiles_update_own on profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy profiles_delete_own on profiles
  for delete to authenticated using (id = auth.uid());

-- voice_profiles ------------------------------------------------------------
create policy voice_profiles_select_own on voice_profiles
  for select to authenticated using (user_id = auth.uid());
create policy voice_profiles_insert_own on voice_profiles
  for insert to authenticated with check (user_id = auth.uid());
create policy voice_profiles_update_own on voice_profiles
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy voice_profiles_delete_own on voice_profiles
  for delete to authenticated using (user_id = auth.uid());

-- campaigns -----------------------------------------------------------------
create policy campaigns_select_own on campaigns
  for select to authenticated using (user_id = auth.uid());
create policy campaigns_insert_own on campaigns
  for insert to authenticated with check (user_id = auth.uid());
create policy campaigns_update_own on campaigns
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy campaigns_delete_own on campaigns
  for delete to authenticated using (user_id = auth.uid());

-- leads ---------------------------------------------------------------------
create policy leads_select_own on leads
  for select to authenticated using (user_id = auth.uid());
create policy leads_insert_own on leads
  for insert to authenticated with check (user_id = auth.uid());
create policy leads_update_own on leads
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy leads_delete_own on leads
  for delete to authenticated using (user_id = auth.uid());

-- unsubscribes --------------------------------------------------------------
create policy unsubscribes_select_own on unsubscribes
  for select to authenticated using (user_id = auth.uid());
create policy unsubscribes_insert_own on unsubscribes
  for insert to authenticated with check (user_id = auth.uid());
create policy unsubscribes_update_own on unsubscribes
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy unsubscribes_delete_own on unsubscribes
  for delete to authenticated using (user_id = auth.uid());

-- send_log ------------------------------------------------------------------
create policy send_log_select_own on send_log
  for select to authenticated using (user_id = auth.uid());
create policy send_log_insert_own on send_log
  for insert to authenticated with check (user_id = auth.uid());
create policy send_log_update_own on send_log
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy send_log_delete_own on send_log
  for delete to authenticated using (user_id = auth.uid());
