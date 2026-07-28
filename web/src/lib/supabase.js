import { createClient } from '@supabase/supabase-js';

/**
 * Browser Supabase client — ANON key only, used for auth (signup/login/session).
 * All application data goes through the Express API with the service-role key.
 * The service-role key must never appear in this bundle.
 */
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

let client = null;

export function isSupabaseConfigured() {
  return Boolean(url && anonKey);
}

export function getSupabase() {
  if (!isSupabaseConfigured()) {
    throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY — copy web/.env.example to web/.env');
  }
  if (!client) {
    client = createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    });
  }
  return client;
}

/** Current access token (JWT) or null. Never logged. */
export async function getAccessToken() {
  if (!isSupabaseConfigured()) return null;
  const { data, error } = await getSupabase().auth.getSession();
  if (error) return null;
  return data?.session?.access_token ?? null;
}
