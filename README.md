# Unique

AI cold email platform. Users connect their Gmail, the app builds a voice profile from their
sent mail, then sends cold emails in that voice through their own Gmail account.

**Current state: Phase 2** — Phase 1 scaffold (Supabase schema + RLS, Express skeleton with
Supabase JWT middleware, Supabase auth on the frontend) plus Gmail OAuth, sent-mail ingestion
and voice profile generation on the server. Campaigns, generation and sending are Phase 3+
(see `CLAUDE.md` for the build order and contract).

```
/server   Express API (plain JS, ESM, Node 20)
/web      Vite + React app (plain JS)
/supabase/migrations   SQL migrations
CLAUDE.md contract: stack, schema, routes, security rules
```

## 1. Supabase project

1. Create a project at https://supabase.com (free tier is fine). Pick a region near you.
2. **Project Settings -> API**: copy the Project URL, the `anon` public key, and the
   `service_role` secret key.
   - `service_role` goes in `server/.env` only. It bypasses RLS and must never reach the browser.
   - `anon` goes in `web/.env`.
3. **SQL Editor -> New query**: paste the contents of `supabase/migrations/001_init.sql`
   and run it. This creates the tables, enables row level security on every table, and adds
   `user_id = auth.uid()` policies (`id = auth.uid()` for `profiles`).
4. **Authentication -> Providers**: enable Email. For local development you can turn off
   "Confirm email" so signup logs you straight in.
5. **Authentication -> URL Configuration**: set Site URL to `http://localhost:5173`.

(If you use the Supabase CLI instead: `supabase db push` picks up `supabase/migrations/`.)

## 2. Google Cloud OAuth app (needed in Phase 2, set it up now)

1. https://console.cloud.google.com -> create a project.
2. **APIs & Services -> Library** -> enable the **Gmail API**.
3. **APIs & Services -> OAuth consent screen**: External, fill in app name / support email.
   Add **one** scope: `https://www.googleapis.com/auth/gmail.readonly`. Phase 2 only reads
   sent mail, so nothing broader is registered — no `gmail.send` (that comes with the Phase 4
   send worker) and no `gmail.modify`. Verify Google has not pre-selected extra scopes, and
   remove any it did. Add your dev Google account as a test user.
4. **APIs & Services -> Credentials -> Create credentials -> OAuth client ID**:
   application type **Web application**, authorised redirect URI
   `http://localhost:3000/api/gmail/callback`.
5. Copy the client ID and client secret into `server/.env`.

## 3. Local setup

```bash
# API
cd server
cp .env.example .env      # fill in SUPABASE_*, TOKEN_ENC_KEY, UNSUB_SECRET
npm install
npm run dev               # http://localhost:3000

# Web (second terminal)
cd web
cp .env.example .env      # fill in VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
npm install
npm run dev               # http://localhost:5173
```

Generate the two secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"  # TOKEN_ENC_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"     # UNSUB_SECRET
```

Smoke test: `curl http://localhost:3000/api/health` returns `{"status":"ok",...}`. Then sign up in
the web app — the landing view calls `GET /api/me` with your Supabase JWT and shows your user id.

Phase 2 endpoints (all need `Authorization: Bearer <supabase jwt>` except the OAuth callback):

| Route | Does |
| --- | --- |
| `POST /api/gmail/connect` | returns the Google consent URL (`{ url }`) |
| `GET /api/gmail/callback` | Google redirects here; stores the encrypted refresh token, starts ingestion, redirects to `APP_URL/onboarding?connected=1` |
| `POST /api/voice/generate` | ingests the last 100 sent emails and builds + saves the voice profile |
| `GET /api/voice` | the current voice profile (404 if there is none yet) |

`ANTHROPIC_API_KEY` and `TOKEN_ENC_KEY` must be set for these to work.

`.env` is git-ignored. Never commit real keys; `.env.example` holds placeholders only.

## 4. Scripts

| Location | Command | Does |
| --- | --- | --- |
| `server` | `npm run dev` | API with `--watch` |
| `server` | `npm test` | vitest, single run (all external APIs mocked) |
| `server` | `npm run lint` | eslint |
| `server` | `npm run check` | lint + tests + `node --check src/index.js` |
| `web` | `npm run dev` | Vite dev server |
| `web` | `npm run build` | production bundle |
| `web` | `npm run lint` | eslint |
| `web` | `npm run check` | lint + `node --check` on the lib entry files |

## 5. Ground rules (short version — full list in CLAUDE.md)

- Plain JavaScript. No TypeScript, no Next.js, no ORM.
- Gmail refresh tokens and voice exemplars are AES-256-GCM encrypted app-side before any DB
  write — never plaintext, dev included.
- Raw email bodies live in process memory only: never in the DB, on disk, in logs, or in
  error messages.
- Every route validates input and returns `{ error }` JSON with a proper status code.
- Files stay under ~300 lines. Dependencies are pinned.
