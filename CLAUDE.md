# Project: VoiceReach (working name) — AI Cold Email Platform

## What this is
B2B SaaS web app. Users connect their Gmail, the app builds a "voice profile" from their sent emails, then bulk-sends cold emails that are either (a) fully AI-written in the user's voice, or (b) a user-provided template with AI-personalized sections per recipient. Sends go through the user's own Gmail account. Later: internal warm-intro network between users (DO NOT build yet).

## Team split (2 devs)
- **Dev A (backend):** everything in `/server` — Gmail integration, send queue, AI engine, lead pipeline
- **Dev B (product):** everything in `/web` + Supabase schema/RLS + migrations
- The Supabase schema and the API routes in this doc are the contract. Do not change either without updating this file first.

## Tech stack (do not substitute)
- **Backend:** Node.js 20 + Express, plain JavaScript (no TypeScript)
- **DB/Auth/Storage:** Supabase (Postgres). Supabase Auth for users. RLS on all tables.
- **Frontend:** React (Vite), plain CSS or Tailwind — keep it simple
- **Queue:** BullMQ + Redis
- **Email:** Gmail API via googleapis npm package (OAuth 2.0). No SMTP/IMAP.
- **AI:** Anthropic API, model `claude-sonnet-4-6`. SDK: `@anthropic-ai/sdk`
  - **Model IDs must be verified before use.** Never suggest, apply, or swap a model ID from recall, training data, or a bundled reference sheet — check the exact string against https://docs.claude.com first. An unverified ID fails at runtime as a 404, and a plausible-looking wrong string is worse than no suggestion. This pin does not change without a real-account voice-fidelity result showing it falls short.
- **Lead data:** Apollo.io API (stub behind an interface — API key may not exist yet)
- **Web research:** Tavily API (stub behind an interface)
- **Billing:** Stripe (Phase 4, not MVP)
- **Deploy:** Railway (server + Redis), Supabase cloud

## Repo structure
```
/server
  /src
    /routes        # Express routes
    /services
      gmail.js     # OAuth, ingestion, sending
      voice.js     # voice profile builder
      generate.js  # email generation (voice + template modes)
      leads.js     # Apollo + Tavily (stubbed)
      queue.js     # BullMQ producers/workers
    /workers
      sendWorker.js
      replyWatcher.js
      voiceSyncWorker.js  # weekly rolling re-sync of the voice profile
    /lib
      supabase.js  # service-role client
      anthropic.js
    index.js
  .env.example
/web
  /src
    /pages         # Onboarding, Campaigns, CampaignBuilder, Leads, Dashboard, Settings
    /components
    /lib
      api.js       # fetch wrapper to server
      supabase.js  # anon client (auth only)
/supabase
  /migrations
CLAUDE.md          # this file
```

## Environment variables (.env.example — create with placeholders)
```
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_ANON_KEY=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3000/api/gmail/callback
ANTHROPIC_API_KEY=
APOLLO_API_KEY=
TAVILY_API_KEY=
REDIS_URL=redis://localhost:6379
APP_URL=http://localhost:5173
```

## Supabase schema (migration 001 — build exactly this)
```sql
-- users handled by supabase auth; profile extension:
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,                    -- migration 006. THE authoritative sign-off name. Required at
                                     -- signup by the app and populated by the 002 trigger from
                                     -- auth metadata. Nullable in the DB ONLY because pre-006
                                     -- accounts exist and a name cannot be invented for them.
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
  brief text,                        -- migration 004: what this campaign is actually about, in the user's words
  clarifications jsonb,              -- migration 004: [{question, answer}] from the clarify pass. Answers may be null (skipped).
  status text default 'draft' check (status in ('draft','generating','review','sending','paused','done')),
  created_at timestamptz default now()
);
-- migration 004 adds `brief` and `clarifications`. Before them the generation goal fell back to the
-- campaign NAME, so a campaign called "First test" produced six letters about running a first test.
-- CLAUDE.md § 3 always specified "the user's campaign goal" as a prompt input; there was simply no
-- column holding one. Both are user-authored content about their own business: treat them exactly
-- like `template_body` — never logged, never in an error message.

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
  variant_json jsonb,                -- migration 005: WHICH variant this letter used. Written at
                                     -- generation, read by nothing until the adaptation loop exists.
                                     -- {opener_starter, cta_form, length_band, profile_version}.
                                     -- References the user's OWN profile entries — no new content class.
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
  lead_id uuid references leads(id),          -- null for one-off compose sends (no campaign)
  gmail_message_id text,                      -- migration 003
  gmail_thread_id text,                       -- migration 003
  sent_at timestamptz default now()
);
-- migration 003 adds gmail_message_id / gmail_thread_id so the register can show ONLY mail sent
-- from Unique. IDs ONLY — never the subject, recipient or body. Those are fetched from Gmail on
-- demand and never persisted. unique(user_id, gmail_message_id) keeps the write idempotent.
-- RLS: enable on all tables; policy = user_id = auth.uid() for select/insert/update/delete.
-- Server uses service-role key and bypasses RLS.
--
-- migration 002: a `profiles` row is created automatically by an AFTER INSERT trigger on
-- auth.users. Nothing in /server creates one, so without this every new signup 404s on Gmail
-- connect (handleCallback updates an existing row and cannot upsert — profiles.email is NOT NULL
-- and the OAuth callback has no verified email). The trigger FAILS OPEN: if the insert cannot be
-- made it raises a warning and still lets the signup through, because a missing profile row is
-- recoverable by backfill whereas a throwing trigger on auth.users takes authentication down
-- entirely. 002 also backfills any pre-existing auth.users, and is idempotent.
```

## API routes (server, all under /api, auth = Supabase JWT in Authorization header)
```
POST /gmail/connect          -> returns Google OAuth URL
GET  /gmail/callback         -> handles code exchange, stores refresh token, kicks off ingestion
PATCH /me                    -> set the user's full_name (the sign-off name). Backfill for pre-006
                                accounts, which are prompted on next login. (added 2026-08-13)
POST /voice/generate         -> builds voice profile from ingested sent emails; returns profile
GET  /voice                  -> current voice profile
POST /campaigns              -> create campaign {name, mode, template_body?, subject_template?}
GET  /campaigns              -> list with counts (sent/replied)
GET  /campaigns/:id          -> detail + leads
POST /campaigns/:id/clarify  -> from the brief, return <=8 clarifying questions (added 2026-08-09)
PATCH /campaigns/:id         -> edit name/template/subject, and the brief + clarification answers
POST /campaigns/:id/leads    -> bulk add leads (CSV parsed client-side, JSON array here)
POST /campaigns/:id/generate -> batch-generate emails for all pending leads (async, updates statuses)
GET  /leads/:id              -> one lead's full letter for the review screen (added 2026-08-08)
PATCH /leads/:id             -> edit body/subject, approve, etc.
POST /leads/:id/regenerate   -> redraft one lead, leaving the rest of the campaign alone (added 2026-08-08)
POST /campaigns/:id/send     -> queue all approved leads, set status 'sending'
POST /campaigns/:id/pause
GET  /dashboard              -> aggregate stats
POST /unsubscribe/:token     -> public route, no auth (token = signed lead id)
```

## Core implementation specs

### 1. Gmail OAuth + ingestion (gmail.js)
- Scopes: **`gmail.readonly` + `gmail.send`** — see Decisions, 2026-07-29 and 2026-08-04. `gmail.send` was added when the minimal send slice first exercised it. `gmail.modify` remains deferred and is added only if reply-labeling genuinely needs it. Never request a scope in an earlier phase than the code that exercises it.
- Store the refresh token in `profiles.gmail_refresh_token_enc`, AES-256-GCM encrypted via `lib/crypto.js` before the write — never plaintext, dev included. Build a `getAuthedClient(userId)` helper that decrypts in memory and refreshes access tokens automatically.
- Ingestion: fetch the user's last **100** sent emails (`in:sent`) — if they have fewer than 100, use whatever exists; if more, take only the most recent 100. Extract plain-text body, strip quoted replies (lines starting with `>` and everything after `On ... wrote:`), strip signature (heuristic: everything after `--` or last 4 lines if they contain phone/url patterns). Hold cleaned texts in memory only — pass directly to voice builder, never write raw bodies to DB, disk, or logs.
- **Continuous voice sync (voiceSyncWorker.js):** the voice model improves over time from the user's ongoing real emails. Cron per user (weekly, plus a manual "Re-sync now" button in Settings): fetch sent emails newer than `voice_profiles.last_synced_at` (use Gmail `after:` query), clean them the same way, and re-run the full profile analysis over the rolling window of the most recent 100 sent emails. Merge: new analysis replaces `profile_json` but `learned_corrections[]` from user edits are preserved and re-appended. Bump `version`, set `last_synced_at`. Same ephemeral rules — bodies in memory only, nothing raw persisted.
- Exemplar selection: from the cleaned set, have the model pick the 5–8 emails that best represent the user's natural outreach voice (excluding one-liners, forwards, anything with obvious PII of third parties beyond names). Redact recipient email addresses and phone numbers from exemplars. Encrypt (AES-256-GCM, TOKEN_ENC_KEY) and store in `voice_profiles.exemplars_enc`. Onboarding UI must show these to the user for explicit approval ("These emails will be used as style references — approve / swap / remove") before saving. On re-sync, if the model finds stronger exemplar candidates, it proposes swaps in the UI — exemplars never change without user approval. Settings has a "Delete my exemplars" button that hard-deletes them.

### 2. Voice profile (voice.js) — CORE PRODUCT, exactness is the whole point
One Anthropic API call over the cleaned sent emails. The profile must capture *mechanics*, not vibes — return ONLY JSON:
```json
{
  "tone": "", "formality_1to10": 0,
  "greeting_styles": ["exact greetings they actually use, verbatim"],
  "signoff_styles": ["verbatim"],
  "typical_length_words": {"min": 0, "median": 0, "max": 0},
  "sentence_rhythm": "e.g. short punchy 5-12 word sentences, occasional fragment",
  "paragraph_style": "e.g. 1-2 sentence paragraphs, no walls of text",
  "contractions": "always/sometimes/never",
  "capitalization_quirks": "e.g. lowercase i, no caps after dash",
  "punctuation_habits": "e.g. dashes over commas, no exclamation marks, ellipses",
  "sentence_starters": ["verbatim frequent openers"],
  "transition_words": ["verbatim"],
  "how_they_ask": "how this person actually makes requests/CTAs, with a verbatim example",
  "signature_phrases": ["verbatim phrases used 2+ times"],
  "vocabulary_level": "", "emoji_usage": "", "humor": "",
  "never_does": ["patterns absent from their writing that AI would typically add — e.g. never says 'I hope this finds you well', never uses semicolons"]
}
```
Parse defensively (strip ```json fences). Input = rolling window of up to 100 most recent sent emails (~80k chars cap; if over, keep the most recent that fit). The `never_does` list is critical — it's the anti-AI-slop filter.

**Errors are not traits (Decisions, 2026-08-12).** The profile describes how this person *writes*, not
the mistakes they make. Never catalogue misspellings, wrong homophones, or inconsistent proper-noun
casing as characteristics — a profile that records `"some spelling errors (buisness, eachother)"` or
`"capitalizes 'AI' as 'Ai'"` instructs the generator to reproduce them. `capitalization_quirks` is for
DELIBERATE style (lowercase `i`, no caps after a dash), never for typos.

### 3. Generation (generate.js)
- **Voice mode:** prompt = voice profile JSON + lead data + research_json + user's campaign goal → generate subject + body. Return JSON `{subject, body}`.
- **Template mode:** user template contains `{{personalized}}` marker(s) plus merge vars. Merge vars (`{{first_name}}`, `{{company}}`, `{{title}}`) are replaced in code, NOT by the model. Only `{{personalized}}` sections go to Claude with lead research. If a merge var is missing for a lead, flag the lead `failed` with reason — never send with blank/wrong substitutions.
- Batch: iterate leads sequentially with p-limit concurrency 3. Update each lead row as it completes so the UI can poll progress.
- **Few-shot anchoring (mandatory in voice mode):** every generation prompt includes the decrypted exemplars as "here are real emails this person wrote" alongside the profile JSON. The instruction: match these mechanically — length, rhythm, greeting, sign-off, punctuation — not just tone. Exemplars are decrypted in memory per-request, never logged.
- **Fidelity check pass:** after generating, a second lightweight call scores the draft against profile + exemplars: `{score_0to100, violations:[]}` checking length within user's median±40%, greeting/sign-off from their actual lists, no `never_does` violations, rhythm match. Score <80 → regenerate once with violations fed back. Still <80 → flag lead `generated` with a "low fidelity" badge so the user reviews it first. Store score on the lead row (`fidelity_score int`).
- **Single-send fidelity gate (compose flow): 80 is a floor, not a warning.** In the one-at-a-time
  compose flow a generated draft scoring **below 80 cannot proceed to the confirmation step** — the
  user regenerates instead. This is stricter than the batch/review-screen behaviour above, which
  flags a low-fidelity lead for review rather than blocking it. The reason for the difference: in the
  compose flow the draft goes straight out under the user's name with one click, so a draft that does
  not sound like them must not reach the send button at all.
  **Escape hatch, to avoid a deadlock:** once the user manually edits the body, the score is marked
  stale and the gate lifts — at that point the words are theirs, not the model's, and the whole
  product philosophy is that the human is the author of record. Never trap a user behind a score the
  model cannot reach.
- **Every generated email must sign off as the user, by name.** The body always ends with a sign-off
  drawn from the user's own `signoff_styles`, including their name — never an unsigned body, never a
  generic closing the user does not use. Note the interaction with signature stripping: we
  deliberately strip signature BLOCKS (title, company, URL) from the corpus, so the model must still
  produce the closing plus the name, and must not be starved into producing a bare "Best," with no
  name. Treat a missing sign-off as a guardrail violation and regenerate once.
- **Edit-learning loop:** when a user edits a generated email on the review screen, diff generated vs edited; if the diff is stylistic (not content), append a note to `profile_json.learned_corrections[]` (e.g. "user removes exclamation marks", "user shortens greetings to just the name"). Cap at 20 corrections, FIFO. These get injected into future generation prompts.
- Guardrails: banned phrases list (`"I hope this email finds you well"`, `"I know you're busy"`, `"quick question"` as subject, `"I'll keep this brief"`, `"delve"`, `"leverage"` unless the user's own emails use them), reject and regenerate once if hit. Length limit comes from the user's own typical_length_words, not a fixed cap.
- **No unsubscribe footer on 1:1 compose sends** (changed 2026-08-06 — see Decisions). The signed-token
  route, the public page and `lib/unsubscribe.js` all stay: bulk campaign sending in Phase 4 needs
  them, and that is where the footer belongs. It is only the automatic append on a single
  human-confirmed email that is removed.

### 4. Sending (queue.js + sendWorker.js)
- BullMQ queue `sends`. Job = `{leadId}`. Worker: check daily limit via send_log count for today, check unsubscribes table, build MIME message (use `nodemailer` mail-composer or raw RFC 2822 + base64url), send via `gmail.users.messages.send`, store gmail_message_id/thread_id, insert send_log, set lead `sent`.
- Spacing: delay jobs 90–240s apart (randomized) per user. If daily limit hit, delay job to tomorrow 9am user-local (store tz later; UTC for MVP).
- On 4xx from Gmail (auth revoked): pause campaign, set gmail_connected=false.

### 5. Reply detection (replyWatcher.js)
- MVP: cron every 10 min per active campaign → `gmail.users.threads.get` on each sent lead's thread; if messages count > 1 and a message is not from the user, mark lead `replied`, remove any pending follow-up jobs. (Gmail push notifications/watch = later.)

### 6. Lead pipeline (leads.js) — STUB FOR MVP
- Export `enrichLead(lead)` and `researchLead(lead)` with the real Apollo/Tavily call shapes, but if API keys are absent return `{}` gracefully. MVP flow is CSV upload only.

## Frontend pages (web)
1. **Onboarding:** signup/login (Supabase Auth) → "Connect Gmail" button → OAuth → "Building your voice profile…" progress screen (poll GET /voice) → show profile summary, allow "Regenerate."
2. **Campaigns list:** cards with name, mode badge, sent/replied counts, status.
3. **Campaign builder:** name → mode toggle (Voice / Template) → if template: textarea editor with a merge-var helper bar ({{first_name}} {{company}} {{title}} {{personalized}}) → CSV upload (papaparse client-side, map columns to fields, preview table) → "Generate emails" → progress bar (poll leads statuses).
4. **Review screen (the money screen):** list of leads, click one → generated subject/body in editable fields → Approve / Approve All / Regenerate one. Only approved leads can be sent.
5. **Dashboard:** totals (sent, replies, reply rate) + per-campaign table.
6. **Settings:** daily limit slider (10–50), voice profile viewer + regenerate, unsubscribe list, disconnect Gmail.
7. **Public unsubscribe page:** `/u/:token` → one click → confirmation. No auth.

## Build order (do phases in sequence, each must run before next)
- **Phase 1:** Repo scaffold, Supabase migration 001 + RLS, Supabase auth on frontend, Express skeleton with JWT middleware, .env.example, both apps run locally.
- **Phase 2:** Gmail OAuth + sent-mail ingestion + voice profile end-to-end (test with a real Gmail dev account).
- **Phase 3:** Campaigns + CSV upload + generation (both modes) + review screen.
- **Phase 4:** Send queue + worker + unsubscribe route/page + reply watcher + dashboard.
- **Phase 5 (post-MVP, do not start unless told):** Apollo/Tavily real integration, Stripe, follow-up sequences, warm-intro network, Outlook.

### Product direction — lead sourcing (recorded 2026-08-04, NOT scoped yet)
The intended end state is that a user does not upload a CSV at all: the app finds prospects, resolves
their email, researches them, and sends a personalized email in the user's voice — all in-app.
Sources, in rough order of how settled they are:
- **Apollo** — prospect search + email resolution. Already the planned source; `leads.js` is stubbed
  behind an interface for exactly this.
- **Tavily** — web research per prospect, feeding `leads.research_json` into generation.
- **The user's own mailbox** — mine already-ingested sent mail for existing contacts and warm
  relationships. NEW; not in the schema. Note the Phase 2 ingestion is `gmail.readonly` over `in:sent`
  and holds nothing in the DB, so this needs its own design and probably its own consent step.
- **LinkedIn** — NEW, and the one with real constraints: there is no public API for cold outreach or
  bulk profile access, and scraping violates the User Agreement. Apollo already exposes much of the
  same firmographic data licensed. Any LinkedIn work needs a legal/ToS answer first, not just an
  engineering one.
Do not build any of this until it is scoped into its own phase with schema changes agreed.

## Security (non-negotiable — this product reads people's email; one leak kills the company)
- **Encryption:** `TOKEN_ENC_KEY` (32-byte, in env) encrypts Gmail refresh tokens and voice exemplars via AES-256-GCM app-side before any DB write. Build `lib/crypto.js` with `encrypt(text)` / `decrypt(blob)` — random IV per record, auth tag stored with ciphertext. Nothing sensitive is ever stored plaintext, dev included.
- **Raw email bodies:** exist only in process memory during ingestion/generation. Never in DB (except approved exemplars, encrypted), never on disk, never in logs, never in error messages, never sent to any third party except the Anthropic API for the profile/generation calls themselves.
- **Logging:** structured logs with an allowlist of fields. Redaction middleware strips anything matching email-body/token patterns before write. No request-body logging on any route that carries email content.
- **Scopes:** request the minimum Gmail scopes, and add each one **in the phase that first exercises it — never earlier**. Current set: `gmail.readonly` (ingestion, reply detection) + `gmail.send` (the confirmed single-send slice, added 2026-08-04 when it was first called). `gmail.modify` is still **not** requested — reply detection reads threads under `readonly` and labels nothing. A scope granted before the code that uses it is an unnecessary standing grant on the user's mailbox, and re-consent is cheap.
- **Nothing sends without explicit human approval.** Any route that puts a message into someone's inbox under the user's name must require an explicit confirmation of the exact rendered content, enforced **server-side**. A UI-only confirmation is bypassable and does not satisfy this.
- **Disconnect = revoke:** "Disconnect Gmail" calls Google's token revocation endpoint, deletes the encrypted token, deletes exemplars, sets gmail_connected=false. Account deletion cascades everything (schema already cascades).
- **Transport/API hardening:** helmet, CORS locked to APP_URL only, express-rate-limit on all routes (strict on auth + OAuth callback), 1MB JSON body limit, Supabase JWT verified server-side on every route.
- **RLS:** enabled on every table, `user_id = auth.uid()` policies. Frontend anon client can only touch auth. All data access goes through the server with the service-role key; service-role key never ships to the client.
- **Unsubscribe tokens:** HMAC-SHA256 signed (`UNSUB_SECRET`), verified server-side, no DB lookup needed to validate. Unguessable, non-enumerable.
- **Secrets:** .env never committed; .env.example has placeholders only. Railway env vars for prod. Rotate TOKEN_ENC_KEY support: version byte prefix on ciphertexts.
- **Dependencies:** pin versions. Before each phase completes, `npm audit --omit=dev --audit-level=high` must pass in both apps — no high or critical vulnerabilities in **production** dependencies. Dev-dependency vulnerabilities do not block a phase: they never ship, and force-fixing them breaks toolchains for no real risk reduction. Record them as known warnings instead. Fix prod vulns with targeted version bumps, never a blanket `npm audit fix --force`; if the only fix is a breaking major bump, raise the tradeoff before applying it.
- **Exception to exact pinning — security `overrides`:** entries in an `overrides` block use a caret floor (e.g. `^0.1.13`), not an exact pin. An exact pin in an override freezes out future patches *including security patches*, which defeats the purpose of the override. Direct dependencies stay exact-pinned as above; this applies only to `overrides`. Do not "correct" a caret in an `overrides` block to an exact version.

Add to .env.example:
```
TOKEN_ENC_KEY=
UNSUB_SECRET=
```

## Code quality
New and modified code must be clean and readable:
- Clear, intention-revealing names; no single-letter vars except loop indices.
- Small functions, one job each. Extract rather than nest deeply.
- Comments explain WHY, not WHAT. No commented-out code committed.
- Match existing file conventions — consistency over personal preference.
- No dead code, no unused imports/vars (the linter enforces this; keep it green).

**IMPORTANT:** "clean" is a standard for code you're already writing to satisfy a requirement. It is **NOT** license to refactor working code you weren't asked to touch. Do not rename, restructure, or "tidy" existing code outside the change's scope — that's regression risk, not cleanliness. Smallest correct change still wins.

## Privacy & data protection (non-negotiable, checker-enforced)
These are hard invariants. Any violation is a build failure, same severity as a failing test:
- Raw email bodies live in process memory only — never written to DB, disk, logs, or error messages.
- OAuth tokens and voice exemplars encrypted at rest (AES-256-GCM). Never logged, never in error output, never returned in an API response.
- No secrets, tokens, email content, or PII in any log line — structured logs carry IDs and counts only (existing allowlist pattern).
- Minimum Gmail scope for the feature being built. Never widen scope preemptively.
- No user's data reachable by another user — auth-check every data-returning endpoint.

**Checker:** after each cycle, grep the diff for these violations — `console.log`/logger calls carrying email bodies or token values, plaintext token persistence, PII in error strings, un-authed data endpoints. Report any as a **FAILURE** with `file:line`, not a warning. This runs in addition to tests/lint/typecheck.

## Decisions (dated — do not silently revisit)

### 2026-08-13 — The sign-off name is collected at signup, and enforced for everyone

**The gap.** § 3 says every generated email must sign off as the user, by name, and treats a missing
sign-off as a guardrail violation. The only deterministic enforcement is `findMissingSignoff()`, which
returns `[]` when `signoff_styles` is empty — it cannot match a closing against a list that does not
exist. So a brand-new user got **no sign-off enforcement at all**, and it compounded: a new user
usually has no exemplars either, so the prompt's fallback pointed at example emails that were not in
the prompt. The guarantee was strongest for established users and weakest for first-time senders, and
the failure was silent — an unsigned letter went out under their name with no violation recorded.

**The fix: `profiles.full_name`, collected as a REQUIRED field at account creation** (migration 006).
This is the authoritative sign-off name. Chosen over deriving it from Google OAuth or the email
local-part because it is simpler and more accurate — an email local-part is wrong often enough to be
embarrassing on a cold email, and OAuth adds a data dependency for something the user can just type.

**Signup stays minimal.** Full name is the ONLY new required field. Do NOT add company, role, or
anything else to signup — collect those later, post-signup, if ever. Onboarding friction hits new
users hardest, and they are exactly the population this decision exists to protect.

**Enforcement is uniform, and that is the whole point.** `findMissingSignoff` checks the name for
EVERY user, including one with no styles and no exemplars. The floor: **the name must appear in the
sign-off region of the body.** Style matching stays as an ADDITIONAL check where `signoff_styles`
exists. Enforcement must never again be weaker for a new user than for an established one.

**Legacy accounts, and why this does not reintroduce the gap.** Pre-006 rows have no name, so the
column is nullable in the DB — a name cannot be invented, and a `NOT NULL` would break the existing
`auth.users` trigger. Those users are **prompted for it on next login**, and until they answer the
check **falls back to the style-based test, never crashing and never blocking a send**. This is safe
precisely because a legacy account is by definition an established one with `signoff_styles` — the
population that already had enforcement. Nobody ends up worse off than today, and every new user is
strictly better. **A null name must never throw on the send path.**

The 002 trigger is extended to populate `full_name` from the signup metadata, so the name arrives with
the row rather than needing a second write. Route: `PATCH /me` sets the name, used by the backfill
prompt.

### 2026-08-12 — Batch variety, and the outcome-adaptation loop it feeds

**Two features, one now and one after Phase 4. The first must not ship without the second's
groundwork, because that groundwork cannot be added retroactively.**

**NOW — batch variety.** Nothing in a generation prompt knows what the other letters in the batch
said. A measured batch opened 4 of 6 letters with the same sentence and shared five phrases across
all six. Each prompt must receive the openers and CTA forms already used in this run and pick a
different construction — **drawn from the user's own `sentence_starters` and `how_they_ask`, never
invented.** Variety within their voice, not variety away from it.

**NOW — variant tagging (`leads.variant_json`, migration 005).** Record which variant each letter
used: `{opener_starter, cta_form, length_band, profile_version}`. **Nothing reads it yet.** It exists
because every letter sent before the adaptation loop is otherwise a lost data point — reconstructing
which pattern a body used by parsing it after the fact is lossy and cannot recover a distinction the
generator made but never wrote down. `profile_version` is included because variant performance is not
comparable across a re-synced profile.

This stores references to the user's own profile entries, not new content. `generated_body` is
already in this table, so it is not a new exposure class.

**AFTER PHASE 4 — the adaptation loop.** Reply outcomes bias future variant selection: what lands
gets reused more. Blocked until `replyWatcher` exists, because nothing currently writes `replied`.

**The statistics are hostile and the design must answer them.** Cold reply rates run ~1–5%;
separating a 3% variant from a 5% one takes hundreds of sends per variant. A campaign of 50 teaches
almost nothing, and reinforcing 1-reply-out-of-3 is reinforcing noise — which compounds, because the
"winner" then gets used more, earns more replies by volume, and looks even more like a winner.
Required guards:
- a minimum sample per variant before any nudge;
- a floor that never lets a variant go extinct — always keep exploring;
- treat the signal as a weak prior, never a rule.
This is a multi-armed bandit; Thompson sampling handles the small-sample explore/exploit tension and
degrades gracefully on thin data. **Adaptation must never collapse variety — that is the very problem
the variety work exists to fix.**

**Confounding, stated plainly:** a reply depends far more on WHO was emailed than on which opener was
used. Lead quality is the dominant variable. Attributing a reply to sentence construction is a strong
causal claim from weak evidence, and the guards above are what keep it honest.

**Voice fidelity outranks reply rate.** Reinforcement selects among the user's OWN patterns and never
invents a high-performing one. Optimising toward whatever gets replies and away from sounding like
them loses the thing the product is for.

Note this is the second adaptation loop. `learned_corrections` learns from the user's EDITS ("that is
not how I would put it"); this learns from OUTCOMES ("that worked"). They are complementary and must
not be merged.

### 2026-08-12 — Replicate the voice, not the typos

**Voice fidelity means sounding like the user, not misspelling like them.** A real batch went out
reading "less then ever" and "Ai" instead of "AI", with the product name rendered three ways across
six letters. That is not authenticity, it is a cold email that looks careless to a stranger.

**The line, and it is deliberately narrow:**

FIX — objective errors, never voice:
- misspellings (`buisness`, `eachother`, `seprate`, `insituitons`)
- wrong homophones (`then`/`than`, `your`/`you're`, `its`/`it's`)
- proper-noun casing — `AI` not `Ai`, and ONE consistent spelling of the product name per email

PRESERVE — looks like an error, IS the voice:
- comma splices and run-ons joined by a comma (`sentence_rhythm` names this explicitly)
- commas where a period would be standard; minimal punctuation generally
- sentence fragments, omitted periods on closing lines
- ALL-CAPS for emphasis
- deliberate lowercase style, where a user genuinely writes that way
- contractions at whatever rate they use them

Fixing the second list would produce polished corporate prose, which is the exact opposite of the
product. **Spelling and proper nouns only. Never touch syntax or rhythm.**

**Three places have to change together, or the fix half-works:**
1. **`voice.js` / `voicePrompts.js`** — the profile must stop CATALOGUING errors as traits. A real
   profile contained `vocabulary_level: "...some spelling errors (buisness, eachother, seprate,
   micic)"` and `capitalization_quirks: "capitalizes 'AI' as 'Ai' inconsistently"`. The profile was
   instructing the error.
2. **`generatePrompts.js`** — "copy their habits exactly, quirks included" needs the carve-out, and
   the exemplar instruction "match them mechanically" needs it too: exemplars are raw real emails
   and carry the user's real typos.
3. **The fidelity checker** — it scores a draft against profile + exemplars. Left alone it will
   PENALISE correct spelling as a deviation from the voice, and the sub-80 retry will push the model
   back toward the typo. This is the non-obvious one.

**Existing stored profiles already contain the error catalogue**, so a prompt fix alone does not
clean them. Generation must defend against a dirty profile, AND users need a re-sync to get a clean
one. Do not assume a prompt change is sufficient.

### 2026-08-09 — The campaign brief + clarify pass; and the review deck

**The problem, found by a real batch test.** Six letters were generated for a campaign named
"First test". All six were *about running a first test* — subjects came out as "First test", one body
ended "Just testing to make sure things are working on my end." The cause was not the voice model:
`campaignGoal()` fell back to `campaign.name` because **no goal column existed**. § 3 had always
listed "the user's campaign goal" as a prompt input; nothing stored one.

**The brief.** `campaigns.brief` holds the user's own in-depth description of what the email is
about, written in the campaign builder at creation. It, not the name, is the generation goal.

**The clarify pass.** `POST /campaigns/:id/clarify` sends the brief to the model and returns **at most
8** questions. They are asked **one at a time, conversationally**, each skippable — a wall of eight
boxes reads as work and gets abandoned. Answers are stored in `campaigns.clarifications` as
`[{question, answer}]` and feed generation alongside the brief.

Questions must interrogate what a cold email actually needs and the brief did not say — who should
reply, what the ask is, what proof exists, what makes this recipient set right. They must never ask
for anything already in the brief, and never ask for the user's writing style: style comes from the
voice profile, which is derived from their real sent mail, and asking would invite them to describe a
voice rather than have it observed.

**A skipped question is a first-class outcome.** Generation proceeds on the brief plus whatever was
answered. Never block drafting on an unanswered question.

**The review deck.** The review screen is a deck, not a click-in/click-out list: one letter fills the
view, **Enter approves and advances**, arrows move without approving, `E` edits, `Esc` returns to the
list, and any letter can be revisited at any time.

This does NOT weaken the 2026-08-08 per-lead approval decision — it strengthens it. Every letter is
rendered full-screen before it can be approved, and every approval is still one explicit action
against one lead through `PATCH /leads/:id`. There is still no Approve All and no server change.

**The known tradeoff, stated so it is not rediscovered:** Enter-to-approve makes a mistaken or
held-down keypress able to approve a letter the user skimmed. That is accepted for the speed it buys
on a long batch. If it proves to be a real problem, add an undo — do not add a confirm dialog on
every letter, which would rebuild the friction the deck exists to remove.

### 2026-08-08 — TWO HARD BLOCKERS ON PHASE 4 (highest priority — read before writing Phase 4 code)

Both are gate-integrity requirements, not cleanups. Phase 4 is where sending becomes autonomous, and
these are the two places where the human-approval guarantee can be silently lost.

**BLOCKER 1 — every send MUST route through `selectSendableLeads`. This is the top wiring
requirement of Phase 4.**
`server/src/services/leadReview.js` exports `selectSendableLeads`, the server-side enforcement of
"only `approved` leads may ever be sendable." It is fully tested and mutation-verified — three
mutations kill it, including the full gate breach — but **it has no production caller.** The tests
prove the function behaves; nothing yet proves the send path uses it.

Building the Phase 4 queue without routing through it means **autonomous sending with the approval
gate bypassed** — the exact failure this project has already shipped once, when a trailing-slash
route variant sent email with no confirmation and passed a fully green 32-test suite.

`POST /campaigns/:id/send` and `sendWorker.js` must select their leads through this function and
must not re-query `leads` themselves. A test must FAIL if they stop doing so — assert on the call,
not on the outcome, because a re-query can produce an identical result set while bypassing the gate.

**BLOCKER 2 — harden the compose 80-point fidelity floor server-side when the send path is touched.**
`web/src/components/FidelityGate.jsx` blocks a sub-80 draft from reaching the confirm step. There is
no equivalent check in `routes/send.js` or `services/send.js`, so the floor is bypassable by a direct
API call.

This is not a violation of the § Security non-negotiable — that requires the exact-content
*confirmation* gate to be server-side, and that gate is server-side and mutation-verified. But the
fidelity floor itself is a UI-only gate, and this repo's history is unambiguous that UI-only gates get
bypassed. Close it when the send path is next opened.

Preserve the escape hatch when hardening: § 3 states that once the user manually edits the body the
score goes stale and the gate lifts, because at that point the words are theirs. A server-side floor
that ignores this would trap users behind a score the model cannot reach.

### 2026-08-08 — No "Approve All" on the review screen; approval is per-lead only
TODO.md allowed an Approve All provided it "only applies to leads the user has actually opened."
On implementation that condition turned out to be unenforceable, so the feature was not built.

**Why:** the server cannot verify that a lead was ever rendered for a human. A client-supplied list
of "leads I opened" is exactly as forgeable as "approve everything on this campaign" — it is the
same UI-only gate the rule exists to prevent, wearing an id array. Since this screen is the last
place a human sees an email before it goes out under their own name, a convenience that can be
spoofed is worse than no convenience.

**What exists instead:** one `PATCH /leads/:id` with `approve: true` per lead, refused unless the
lead is already `generated`/`approved` AND has a non-empty subject and body. The read/unread marks
in the UI are a reading aid and are explicitly NOT the enforcement.

Revisit only with a mechanism that proves human review server-side. Per-lead approval is the floor.

### 2026-08-08 — Two lead routes added to the contract
`GET /leads/:id` and `POST /leads/:id/regenerate` were added in Phase 3 Loop 4. Recorded here
because the route list in this file is the contract.

`GET /leads/:id` exists so a letter is fetched one at a time, on open. The alternative was widening
`GET /campaigns/:id` to return every generated and edited body at once, which is strictly more
exposure for the same screen — `campaigns.js` `LEAD_COLUMNS` deliberately excludes the body columns
for that reason. `POST /leads/:id/regenerate` is required by the review screen's regenerate-one.

### 2026-08-06 — No unsubscribe footer on 1:1 compose sends
The auto-appended `Don't want emails from me? [Unsubscribe](...)` line is removed from the compose
flow. On a single, human-confirmed, personally-written email it reads as machine-generated and
undercuts the product's entire premise — that the message sounds like the user wrote it themselves.
A footer is the clearest possible tell that it did not.

**What stays:** `lib/unsubscribe.js`, the HMAC-signed token, `POST /unsubscribe/:token`, and the
public unsubscribe page. None of that is deleted. Phase 4 bulk campaign sending is where an
unsubscribe mechanism genuinely belongs, and it will use exactly this machinery.

**The tradeoff, stated plainly so it is not rediscovered later:** for bulk commercial mail, an opt-out
is a legal expectation in several jurisdictions and a deliverability signal everywhere. This decision
is scoped to 1:1 sends, where reply-to-opt-out is the normal convention. **It must not be carried
into Phase 4 batch sending** — reinstate the footer there.

Incidental note: the removed link embedded a base64 payload of `{userId, recipientEmail}`. It was
HMAC-signed and therefore unforgeable, but base64 is not encryption, so any recipient could decode
the sender's internal user id. Worth keeping in mind when the footer returns in Phase 4 — consider an
opaque lookup id instead of an encoded payload.

### 2026-08-06 — The register stores sent IDs; this revises "reply detection stores nothing"
The 2026-08-04 entry said reply detection persists nothing and derives everything from Gmail on read.
That was right for what existed then. **The requirement changed:** the register must show only mail
sent *from Unique*, and there is no way to tell a Unique-sent message from one the user wrote in
Gmail themselves without recording what we sent. Until now the screen listed the user's entire
`in:sent`, personal mail included — which was both wrong product behaviour and more exposure than
intended.

Rejected alternatives: a Gmail label needs `gmail.modify`, still deliberately unrequested; a custom
MIME header is unusable because Gmail search cannot query arbitrary headers.

**Migration 003 stores IDs and nothing else** — `gmail_message_id` and `gmail_thread_id` on
`send_log`. No subject, no recipient, no body, ever. Subject, recipient and reply state are fetched
from Gmail per request and remain in memory only, exactly as before. The persistence posture widens
by two opaque identifiers, which is the minimum that makes "only ours" expressible.

Thread bodies ARE returned to the user for the detail view and the follow-up flow. This is not the
dev corpus route: it is one thread the user sent, fetched on demand, shown to the person who wrote
it, never persisted and never logged. The dev gate exists to stop bulk-dumping an ingestion corpus,
not to stop a user reading their own conversation.

### 2026-08-05 — Recipient verification: MX + role/disposable only; bounce detection is the real signal
**MX lookup plus role/disposable flagging is cheap front-line prevention, and nothing more.** It runs
server-side on Node's built-in `dns.promises.resolveMx` — no third-party API, no new OAuth scope, and
no recipient data leaving our infrastructure beyond the DNS query itself (which reveals a domain, not
an address).

Why it matters more than data hygiene: we send from the **user's own Gmail account**. A bad bounce
rate damages their personal sender reputation and can get their real mailbox rate-limited. This check
protects the user's mailbox, not just our data quality.

**Its ceiling is known and accepted:** it cannot detect a departed employee at a live domain
(`john@realcompany.com` after John left), and it cannot see through catch-all domains, which are
common in B2B and accept everything by design. MX proves a domain can receive mail. It never proves a
mailbox exists. Treat the result as a risk signal, never as verification — and never let a DNS
timeout mark a good address bad.

**The real deliverability signal is bounce detection, and it belongs in Phase 4** with the send
worker, feeding the `bounced` status already present in the `leads` schema. That is ground truth
rather than a guess, because it is the receiving server's own verdict. MX is the cheap check that
runs before sending; bounces are the authoritative one that arrives after.

**SMTP `RCPT TO` probing is rejected, not deferred.** Railway blocks outbound port 25; Gmail and
Microsoft 365 deliberately return accept-all or ambiguous codes to defeat mailbox enumeration; and
probing from an unwarmed IP invites blocklisting. Paid verification APIs work because they run it
from reputation-managed IP pools, not because the technique is sound for us to self-host. Do not
implement it.

### 2026-08-05 — Recipient autocomplete (Option B) deferred; Option A carries a pre-launch cost
Deriving autocomplete suggestions from already-ingested `in:sent` recipients is **deferred**, not
rejected. It is a re-contact convenience that does not serve the cold-outreach case — for a genuinely
cold prospect it returns nothing, and an empty suggestion list reads as "not a real person," which is
worse than no feature. Revisit only if users ask for it.

**Option A (Google People API) additionally carries a pre-launch cost.** Verified scope strings are
`https://www.googleapis.com/auth/contacts.readonly` (`people.connections.list`) and
`https://www.googleapis.com/auth/contacts.other.readonly` (`otherContacts.list`) — note the literal
string is `contacts.other.readonly`, **not** `otherContacts.readonly`. Both are Google
**"sensitive"-tier** scopes requiring app review before production. Fine in Testing mode, a real
gate at launch. If Option A is ever adopted, budget that review.

### 2026-08-04 — `gmail.send` pulled forward for the minimal send/receive slice
Phase 4's sending capability is **partially pulled forward** so the product can be validated
end-to-end before Phase 3 exists: compose one email in the user's voice, confirm it, send it, and
detect replies. `GMAIL_SCOPES` is now `gmail.readonly` + `gmail.send`, and re-consent is required.

This does not supersede the 2026-07-29 rule — it satisfies it. The rule is that a scope is requested
in the phase that first exercises it; `gmail.users.messages.send` is now called, so the scope is now
warranted. **`gmail.modify` remains deferred** and is still not requested: reply detection reads
thread contents under `readonly` and does not label anything.

What is deliberately NOT pulled forward: the BullMQ/Redis send queue, 90–240s send spacing, daily
send limits, and batch campaign sending. Those stay in Phase 4. This slice sends one
human-confirmed email at a time.

**Human confirmation is non-negotiable and enforced server-side, not just in the UI.** Nothing is
sent under the user's name without an explicit approval of the exact rendered subject, body, and
recipient. A UI-only gate is bypassable; the send route itself rejects an unconfirmed request.

**Reply detection stores nothing.** Sent threads and their reply state are derived from Gmail on
read, so no schema change was needed and no message content is persisted. Ingestion stays `in:sent`;
this is not an inbox view.

### 2026-07-29 — Phase 2 requests `gmail.readonly` only; `gmail.send` deferred to the sending phase
`GMAIL_SCOPES` contains **`gmail.readonly` and nothing else**. Phase 2 covers OAuth, sent-mail ingestion, and voice-profile generation — none of which sends a message — so `gmail.send` was an unnecessary standing grant on the user's mailbox and has been removed.

`gmail.send` is added in **Phase 4**, together with `queue.js` / `sendWorker.js`, i.e. the first code that actually calls `gmail.users.messages.send`. `gmail.modify` remains deferred indefinitely and is added only if reply-labeling genuinely requires it (`replyWatcher.js` can work without it).

Adding a scope later costs one re-consent, which is cheap. Holding an unused send grant over someone's mailbox is not. The general rule now lives in § Security → Scopes: **a scope is requested in the phase that first exercises it, never earlier.** This supersedes the earlier "readonly + send for MVP" wording, which predated the phase split.

### 2026-07-29 — `googleapis` stays pinned at 144.0.0; moderate `uuid` advisory accepted
`googleapis@144.0.0` carries a **moderate** advisory, `uuid@9.0.1` / GHSA-w5hq-g745-h8pq (missing buffer bounds check in v3/v5/v6 when `buf` is provided), reaching **production** via `gaxios@6.7.1` → `googleapis-common@7.2.0`. This is **accepted, not fixed**. It sits below the `--audit-level=high` gate, so the phase gate passes.

Why not upgrade: `googleapis@173.0.0` clears `uuid` but pulls `gaxios@7.1.3` → `rimraf` → `glob` → `minimatch` → `brace-expansion` into production as **6 high-severity** findings — strictly worse against our own gate. The only remedy for that chain is forcing `brace-expansion@5.0.8`, and both versions currently in the tree (1.1.16 and 2.1.3) are the newest releases in their major lines with no backported patch — so the override would force a breaking major across transitive consumers that expect `^1` / `^2`.

**Revisit when:** googleapis clears the `uuid` advisory without dragging in the `gaxios@7` chain, or `brace-expansion` ships a 1.x/2.x backport. Not before. Do not "fix" this with `npm audit fix --force`.

## Rules
- **This is a platform, not one person's tool. Every feature must work for a user whose voice
  profile is thin or empty.** WitWeb / USC / El Camino is demo seed data belonging to one account —
  it must never appear in source, defaults, prompts or fallbacks. A new user signs up with few sent
  emails, so `sentence_starters`, `signoff_styles`, `how_they_ask`, `typical_length_words` and
  `exemplars` may each be missing, empty, null or the wrong type, and a user may delete their
  exemplars in Settings at any time. Nothing may throw, and nothing may invent a construction the
  user does not actually use in order to fill a gap — degrade to less personalisation, never to
  fabricated personality. **Every generation feature ships with a sparse-profile test.**
- No TypeScript, no Next.js, no ORM (use supabase-js / raw SQL).
- **Testing is mandatory:** Phase 1 sets up vitest (server) + eslint (both apps) with npm scripts: `npm run test`, `npm run lint`, `npm run check` (runs both + `node --check` on entry files). Every feature ships with tests for its service functions (mock Gmail/Anthropic/Supabase calls — never hit real APIs in tests). The checker agent depends on these scripts existing.
- **Agent workflow:** all features are built via the builder/checker loop defined in `.claude/agents/` and `.claude/commands/build-loop.md`. The builder never runs tests; the checker never edits code.
- Never log email bodies or tokens. Never commit .env.
- Voice fidelity is the product. If a change makes generation faster/cheaper but less exact to the user's voice, don't make it.
- Every route: validate input, return `{error}` JSON with proper status codes.
- Keep files under ~300 lines; split when bigger.
- Write a README with local setup steps (Supabase project, Google Cloud OAuth app setup steps included).
- Anthropic API docs if needed: https://docs.claude.com/en/api/overview
