import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

/**
 * Service-role Supabase client. This key bypasses RLS — it is server-only and must
 * never be exposed to the browser. Created lazily so that importing this module in
 * tests (or in `node --check`) does not require env vars to be present.
 */
let client = null;

export function getSupabaseAdmin() {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in the environment');
  }

  client = createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false
    },
    // Do NOT remove: we never use Supabase realtime, but createClient constructs a
    // RealtimeClient eagerly, and realtime-js requires a native `WebSocket` global —
    // which Node 20 does not have (it lands in Node 22). Without this transport,
    // createClient THROWS and every authenticated request 500s. Supplying `ws` keeps
    // us on the Node 20 pinned in CLAUDE.md. Harmless on Node 22+.
    realtime: { transport: ws }
  });

  return client;
}

/** Test helper: drop the memoized client so env changes take effect. */
export function resetSupabaseAdmin() {
  client = null;
}
