import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Serving the built web app from the same origin as the API
 * (CLAUDE.md, Decisions 2026-08-19).
 *
 * Same origin is the point: it removes CORS from the path between the site and
 * every request, and lets `VITE_API_URL` be the relative `/api` so nothing
 * environment-specific is compiled into the bundle.
 */

// Resolved from THIS module, never from cwd: the server is started from the repo
// root by Railway and from `server/` in development, and a cwd-relative path
// would silently resolve to nothing in one of them.
const HERE = dirname(fileURLToPath(import.meta.url));

/** `<repo>/web/dist`, or null when the web app has not been built. */
export function webDistPath() {
  const candidate = resolve(HERE, '..', '..', '..', 'web', 'dist');

  return existsSync(join(candidate, 'index.html')) ? candidate : null;
}

/**
 * Whether this request should be answered with the SPA shell.
 *
 * A path under `/api` NEVER is. That is the whole hazard of putting a catch-all
 * in front of a JSON API: an unmatched endpoint would answer `200 text/html`,
 * and the caller would fail somewhere far away from the typo that caused it.
 */
export function isSpaRequest(method, path) {
  if (method !== 'GET' && method !== 'HEAD') return false;

  return !path.startsWith('/api');
}
