import { google } from 'googleapis';

import { getSupabaseAdmin } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { httpError } from '../lib/httpError.js';
import { cleanEmailBody, extractPlainTextBody } from './gmailParse.js';

/**
 * Gmail OAuth + sent-mail ingestion.
 *
 * Security rules that this file exists to enforce (CLAUDE.md):
 *  - the refresh token is AES-256-GCM encrypted before it ever reaches the DB;
 *  - raw email bodies live in process memory only — never DB, disk, logs or errors;
 *  - minimum scopes only: gmail.readonly + gmail.send. gmail.modify is still not
 *    requested — reply detection reads threads read-only and labels nothing.
 */

// readonly covers ingestion and reply detection. gmail.send was added on
// 2026-08-04 (see CLAUDE.md Decisions) because the confirmed single-send slice
// now calls gmail.users.messages.send — the phase that first exercises it.
// gmail.modify stays deferred until reply-labeling genuinely needs it.
export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send'
];

export const MAX_SENT_EMAILS = 100;
const STATE_TTL_MS = 10 * 60 * 1000;
const GMAIL_PAGE_SIZE = 100;

export function createOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('Missing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET or GOOGLE_REDIRECT_URI in the environment');
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function toBase64Url(value) {
  return value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value) {
  return value.replace(/-/g, '+').replace(/_/g, '/');
}

/**
 * The `state` param is opaque and authenticated: it is the AES-256-GCM blob of
 * {userId, issuedAt}. Google hands it back on the callback, which has no session.
 */
export function encodeOAuthState(userId) {
  if (typeof userId !== 'string' || userId === '') {
    throw new Error('encodeOAuthState requires a userId');
  }
  return toBase64Url(encrypt(JSON.stringify({ u: userId, t: Date.now() })));
}

export function decodeOAuthState(state) {
  if (typeof state !== 'string' || state === '') {
    throw httpError(400, 'Missing OAuth state');
  }

  let payload;
  try {
    payload = JSON.parse(decrypt(fromBase64Url(state)));
  } catch {
    throw httpError(400, 'Invalid OAuth state');
  }

  if (!payload || typeof payload.u !== 'string' || payload.u === '') {
    throw httpError(400, 'Invalid OAuth state');
  }
  if (!Number.isFinite(payload.t) || Date.now() - payload.t > STATE_TTL_MS) {
    throw httpError(400, 'OAuth state has expired, please try again');
  }

  return payload.u;
}

/** Google consent URL. offline + consent so we always get a refresh token back. */
export function buildAuthUrl(userId) {
  const client = createOAuthClient();

  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GMAIL_SCOPES,
    include_granted_scopes: false,
    state: encodeOAuthState(userId)
  });
}

/** Exchange the code, encrypt the refresh token, mark the profile connected. */
export async function handleCallback(code, state) {
  if (typeof code !== 'string' || code.trim() === '') {
    throw httpError(400, 'Missing OAuth code');
  }

  const userId = decodeOAuthState(state);
  const client = createOAuthClient();

  let tokens;
  try {
    ({ tokens } = await client.getToken(code));
  } catch {
    // Never surface Google's error — it can echo the authorization code back.
    throw httpError(502, 'Could not exchange the Google authorization code');
  }

  const refreshToken = tokens?.refresh_token;
  if (typeof refreshToken !== 'string' || refreshToken === '') {
    throw httpError(400, 'Google did not return a refresh token, please re-consent');
  }

  const { data, error } = await getSupabaseAdmin()
    .from('profiles')
    .update({ gmail_refresh_token_enc: encrypt(refreshToken), gmail_connected: true })
    .eq('id', userId)
    .select('id');

  if (error) throw httpError(500, 'Could not store the Gmail connection');
  if (!Array.isArray(data) || data.length === 0) throw httpError(404, 'Profile not found');

  logger.info('gmail_connected', { userId });

  return { userId };
}

/**
 * Authed OAuth2 client for a user. The token is decrypted in memory only;
 * googleapis refreshes the short-lived access token on demand from it.
 */
export async function getAuthedClient(userId) {
  if (typeof userId !== 'string' || userId === '') {
    throw httpError(400, 'A userId is required');
  }

  const { data, error } = await getSupabaseAdmin()
    .from('profiles')
    .select('gmail_refresh_token_enc')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw httpError(500, 'Could not load the Gmail connection');

  const encrypted = data?.gmail_refresh_token_enc;
  if (typeof encrypted !== 'string' || encrypted === '') {
    throw httpError(400, 'Gmail is not connected');
  }

  const client = createOAuthClient();
  client.setCredentials({ refresh_token: decrypt(encrypted) });

  return client;
}

function toEpochSeconds(after) {
  if (after instanceof Date) return Math.floor(after.getTime() / 1000);
  if (typeof after === 'number' && Number.isFinite(after)) {
    return Math.floor(after > 1e11 ? after / 1000 : after);
  }
  if (typeof after === 'string' && after !== '') {
    const parsed = Date.parse(after);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  }
  return null;
}

async function listSentMessageIds(gmail, query, limit) {
  const ids = [];
  let pageToken;

  do {
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: Math.min(GMAIL_PAGE_SIZE, limit - ids.length),
      pageToken
    });

    const messages = res?.data?.messages;
    for (const message of Array.isArray(messages) ? messages : []) {
      if (ids.length >= limit) break;
      if (message?.id) ids.push(message.id);
    }

    pageToken = res?.data?.nextPageToken || undefined;
  } while (pageToken && ids.length < limit);

  return ids;
}

/**
 * Fetch the most recent sent messages (100 max, fewer if that is all there is)
 * and keep the pre-clean extracted text next to each cleaned body, newest-first.
 *
 * fetchSentEmails is a thin wrapper over this, so the dev ingest-preview route
 * can inspect what the cleaner removed from the very same corpus the voice
 * builder receives, without a second fetch or a second copy of the cleaning.
 * Nothing here is persisted: both texts are in-memory only.
 */
export async function fetchSentMessages(userId, options = {}) {
  const auth = await getAuthedClient(userId);
  const gmail = google.gmail({ version: 'v1', auth });

  const afterSeconds = toEpochSeconds(options.after);
  const query = afterSeconds ? `in:sent after:${afterSeconds}` : 'in:sent';

  const ids = await listSentMessageIds(gmail, query, MAX_SENT_EMAILS);

  const messages = [];
  for (const id of ids) {
    const message = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    const raw = extractPlainTextBody(message?.data?.payload);
    messages.push({ raw, cleaned: cleanEmailBody(raw) });
  }

  return messages;
}

/**
 * Fetch and clean the most recent sent emails (100 max, fewer if that is all
 * there is). Returns cleaned bodies newest-first. Nothing here is persisted.
 */
export async function fetchSentEmails(userId, options = {}) {
  const messages = await fetchSentMessages(userId, options);
  const bodies = messages.map((message) => message.cleaned).filter((body) => Boolean(body));

  // Counts only — bodies never reach the logs.
  logger.info('gmail_sent_fetched', { userId, count: bodies.length });

  return bodies;
}

export { extractPlainTextBody, stripQuotedReplies, stripSignature, cleanEmailBody } from './gmailParse.js';
