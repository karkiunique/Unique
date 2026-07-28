import { getAccessToken } from './supabase.js';

const API_BASE = (import.meta.env.VITE_API_URL || 'http://localhost:3000').replace(/\/+$/, '');

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
    throw err;
  }

  return payload;
}

export const api = {
  get: (path, options) => apiFetch(path, { ...options, method: 'GET' }),
  post: (path, body, options) => apiFetch(path, { ...options, method: 'POST', body }),
  patch: (path, body, options) => apiFetch(path, { ...options, method: 'PATCH', body })
};
