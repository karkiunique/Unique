import { getSupabaseAdmin } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';

/**
 * Pull the bearer token out of the Authorization header.
 * Returns null for anything malformed. The token itself is never logged.
 */
export function extractBearerToken(req) {
  const headers = req?.headers ?? {};
  const raw = headers.authorization ?? headers.Authorization ?? '';
  if (typeof raw !== 'string' || raw.length === 0) return null;

  const parts = raw.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  if (parts[0].toLowerCase() !== 'bearer') return null;
  if (!parts[1]) return null;

  return parts[1];
}

/**
 * Verifies the Supabase JWT server-side on every request and attaches `req.user`.
 * Supabase validates the signature/expiry for us via auth.getUser(token).
 */
export async function requireAuth(req, res, next) {
  const token = extractBearerToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  let result;
  try {
    result = await getSupabaseAdmin().auth.getUser(token);
  } catch {
    // Never surface or log the underlying error — it can echo the token back.
    logger.error('auth_verify_failed', { route: req?.path, method: req?.method, status: 500 });
    return res.status(500).json({ error: 'Could not verify credentials' });
  }

  const user = result?.data?.user;
  if (result?.error || !user?.id) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.user = { id: user.id, email: user.email ?? null };
  return next();
}
