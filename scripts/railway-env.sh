#!/usr/bin/env bash
# Print the Railway environment block for production, from server/.env.
#
#   bash scripts/railway-env.sh
#
# Paste the output into Railway -> your service -> Variables -> Raw Editor.
#
# Reads local secrets and writes them to STDOUT ONLY. Nothing is stored, committed
# or sent anywhere. Do not redirect it into a file inside the repo.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/server/.env"
[ -f "$ENV_FILE" ] || { echo "server/.env not found" >&2; exit 1; }

DOMAIN="${1:-https://try-unique.com}"

get() { grep "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2-; }

# Copied verbatim from server/.env.
for key in SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY TOKEN_ENC_KEY UNSUB_SECRET \
           ANTHROPIC_API_KEY GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET; do
  value="$(get "$key")"
  if [ -z "$value" ]; then
    echo "# MISSING LOCALLY: $key" >&2
  else
    echo "$key=$value"
  fi
done

# Production-specific. NOT copied from the local file, which points at localhost.
echo "APP_URL=$DOMAIN"
echo "GOOGLE_REDIRECT_URI=$DOMAIN/api/gmail/callback"
echo "NODE_ENV=production"

# Forced false regardless of the local value: dev inspection routes must never be
# reachable in production, and this variable is 'true' on a development machine.
echo "ENABLE_DEV_ROUTES=false"

# Deliberately NOT emitted:
#   PORT               Railway injects it; setting it breaks the healthcheck
#   REDIS_URL          no BullMQ queue yet
#   APOLLO/TAVILY      Stage B, blocked on the licence
#   SUPABASE_ANON_KEY  the server never reads it
#   POSTMARK_*         add when Postmark is configured, or the daily job tells nobody
#   VITE_*             the web bundle is same-origin; no VITE var is needed at all
