# Deploying — one Railway service

The API and the built web app ship together from a single service, same origin
(CLAUDE.md, Decisions 2026-08-19). There is no Vercel, no second host, and no CORS
between the site and its API.

## Railway setup

Point Railway at the repo root. `railway.json` does the rest:

    build:  npm run install:all && npm run build
    start:  npm start
    health: /api/health

`npm run build` builds the web app into `web/dist`; `npm start` runs the server,
which serves that directory alongside `/api`.

## Environment variables

**Required — the service will not work without these.** Copy from `server/.env`:

| Variable | Notes |
|---|---|
| `SUPABASE_URL` | |
| `SUPABASE_SERVICE_ROLE_KEY` | server-only. Never `VITE_`-prefixed, never in the web build |
| `TOKEN_ENC_KEY` | decrypts Gmail refresh tokens |
| `UNSUB_SECRET` | signs unsubscribe tokens |
| `ANTHROPIC_API_KEY` | drafting |
| `GOOGLE_CLIENT_ID` | |
| `GOOGLE_CLIENT_SECRET` | |
| `GOOGLE_REDIRECT_URI` | **change it** — see below |
| `APP_URL` | **change it** — see below |

**The two that are not copied verbatim.** Both are `localhost` in development:

    APP_URL=https://<your-app>.up.railway.app
    GOOGLE_REDIRECT_URI=https://<your-app>.up.railway.app/api/gmail/callback

`GOOGLE_REDIRECT_URI` must ALSO be registered in Google Cloud Console -> Credentials
-> your OAuth client -> Authorized redirect URIs. Google rejects any redirect it has
not been told about, so setting it here alone is not enough.

`APP_URL` no longer gates the site. Same-origin requests carry no `Origin` header,
so CORS is not in the path between the page and the API. It is still used for the
review and unsubscribe links in outbound mail, so a wrong value sends people to the
wrong host — it just no longer breaks the whole app.

**Optional:**

| Variable | Set to | Without it |
|---|---|---|
| `NODE_ENV` | `production` | log lines say "development" |
| `ENABLE_DEV_ROUTES` | omit | omit it. `true` exposes dev inspection routes |
| `ANTHROPIC_MODEL` | omit | uses the pinned model, which is what you want |
| `POSTMARK_API_TOKEN` | when you have it | the daily job drafts and tells nobody |
| `POSTMARK_FROM_EMAIL` | when you have it | same |

**Do not set `PORT`** — Railway injects it and `src/index.js` reads it. Hardcoding it
breaks the healthcheck.

**Not needed yet:** `REDIS_URL` (no BullMQ queue), `APOLLO_API_KEY` / `TAVILY_API_KEY`
(Stage B, blocked on the licence), `SUPABASE_ANON_KEY` (the server never reads it).

**No `VITE_*` variables anywhere.** `web/.env.production` pins the API base to
same-origin at build time and is committed for exactly that reason.

## After the first deploy

1. `https://<your-app>.up.railway.app/api/health` -> `{"status":"ok"}`
2. `https://<your-app>.up.railway.app/` -> the landing page, counter reading 88 + signups
3. An unmatched API path -> `404 {"error":"Not found"}`, NOT the HTML shell. If it
   returns HTML, the SPA fallback has been moved in front of the API routes.
4. Register the redirect URI with Google, then try Gmail connect.

## Not deployed by this

The daily draft job. It is a scheduled invocation, not part of the web service:

    Service -> Settings -> Cron Schedule
    Command:  node server/src/workers/runDailyDrafts.js
    Schedule: 0 6 * * *

Hold it until Postmark is configured, or it runs nightly and tells nobody
(docs/daily-job.md).
