import { getAccessToken } from './supabase.js';

/**
 * Where the API lives.
 *
 * Defaults to the EMPTY STRING, meaning same-origin — which is how production
 * runs: one Railway service serves both the API and this bundle, so `/api/...`
 * resolves against whatever host the page was loaded from and nothing
 * environment-specific is compiled in (Decisions, 2026-08-19).
 *
 * Local development sets VITE_API_URL=http://localhost:3000 in web/.env, because
 * there the app is on 5173 and the API is not.
 *
 * NOT `/api`: buildUrl appends `/api` itself, so a base of `/api` would produce
 * `/api/api/queue`.
 */
const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');

function buildUrl(path) {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE}/api${suffix}`;
}

async function parseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * fetch wrapper for the Express API. Attaches the Supabase session JWT
 * as `Authorization: Bearer <token>`; the server verifies it on every route.
 * Throws an Error with `.status` on non-2xx, using the server's `{error}` payload.
 */
export async function apiFetch(path, options = {}) {
  const { method = 'GET', body, headers = {}, auth = true, signal } = options;

  const requestHeaders = { Accept: 'application/json', ...headers };
  if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';

  if (auth) {
    const token = await getAccessToken();
    if (!token) {
      const err = new Error('Not signed in');
      err.status = 401;
      throw err;
    }
    requestHeaders.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(buildUrl(path), {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal
  });

  const payload = await parseBody(response);

  if (!response.ok) {
    const err = new Error(payload?.error || `Request failed with status ${response.status}`);
    err.status = response.status;
    // The recovery the server named, as a code. Callers key off this, never off
    // the wording of the message.
    if (typeof payload?.action === 'string') err.action = payload.action;
    throw err;
  }

  return payload;
}

export const api = {
  get: (path, options) => apiFetch(path, { ...options, method: 'GET' }),
  post: (path, body, options) => apiFetch(path, { ...options, method: 'POST', body }),
  patch: (path, body, options) => apiFetch(path, { ...options, method: 'PATCH', body }),
  // PUT, not PATCH: the standing target is replaced wholesale, so an omitted
  // criterion means "no longer a constraint" rather than "leave it alone".
  put: (path, body, options) => apiFetch(path, { ...options, method: 'PUT', body })
};
