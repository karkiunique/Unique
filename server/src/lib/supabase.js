import { createClient } from '@supabase/supabase-js';

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
    }
  });

  return client;
}

/** Test helper: drop the memoized client so env changes take effect. */
export function resetSupabaseAdmin() {
  client = null;
}
