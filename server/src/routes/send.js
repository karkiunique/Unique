import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import { requireAuth } from '../middleware/auth.js';
import { generateEmail } from '../services/generate.js';
import { sendEmail } from '../services/send.js';
import { verifyRecipient } from '../services/recipientCheck.js';
import { listSentThreads } from '../services/threads.js';
import { safeMessage } from '../lib/httpError.js';
import { logger } from '../lib/logger.js';

const router = Router();

const THREAD_LIMIT = 25;

/** Each call costs a DNS lookup, so this sits well below the global limit. */
const verifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down' }
});

/**
 * Only messages we wrote are echoed back — SDK errors carry a status too.
 *
 * `action` is the recovery the client should offer, as a stable code rather than
 * a phrase to match on: a failed send that needs re-consent is useless to the
 * user unless the UI can put the button in front of them.
 */
function fail(res, event, userId, err, fallbackMessage) {
  const status = Number(err?.status) || 500;
  logger.error(event, { userId, status, name: err?.name });

  const payload = { error: safeMessage(err, fallbackMessage) };
  if (err?.expose === true && typeof err.action === 'string') payload.action = err.action;

  return res.status(status).json(payload);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function bodyOf(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

/**
 * POST /api/send/generate — draft one email in the user's voice.
 *
 * Drafting ONLY. This route has no path to gmail.users.messages.send, and must
 * never grow one: generating and sending are separated precisely so a human sits
 * between them.
 */
router.post('/send/generate', requireAuth, async (req, res) => {
  const payload = bodyOf(req);
  const to = text(payload.to);
  const goal = text(payload.goal);

  if (to === '') return res.status(400).json({ error: 'A recipient email address is required' });
  if (goal === '') return res.status(400).json({ error: 'A goal for the email is required' });

  try {
    const draft = await generateEmail(req.user.id, {
      to,
      goal,
      recipientName: text(payload.recipientName),
      company: text(payload.company)
    });

    return res.status(200).json(draft);
  } catch (err) {
    return fail(res, 'send_generate_failed', req.user.id, err, 'Could not draft the email');
  }
});

/**
 * POST /api/send — THE CONFIRMATION GATE.
 *
 * `confirmed` must be the boolean literal true. Checked here, server-side, and
 * before anything else happens, because a UI-only confirmation is bypassable by
 * anyone who can call the API — and this route puts a message into a stranger's
 * inbox under the user's own name (CLAUDE.md, Security: "Nothing sends without
 * explicit human approval", enforced server-side).
 *
 * Strict boolean on purpose: the string 'true', 1 and 'yes' are all rejected. A
 * loose check is how an accidental default or a coerced form value turns into a
 * send nobody approved.
 *
 * The route also sends EXACTLY the subject and body it was handed. It does not
 * regenerate, rewrite, or re-fetch anything between confirmation and send —
 * otherwise the user would approve one email and a different one would go out.
 */
router.post('/send', requireAuth, async (req, res) => {
  const payload = bodyOf(req);

  if (payload.confirmed !== true) {
    return res.status(400).json({ error: 'Explicit confirmation required before sending' });
  }

  const to = text(payload.to);
  const subject = text(payload.subject);
  const body = typeof payload.body === 'string' ? payload.body : '';

  if (to === '') return res.status(400).json({ error: 'A recipient email address is required' });
  if (subject === '') return res.status(400).json({ error: 'A subject is required' });
  if (body.trim() === '') return res.status(400).json({ error: 'A body is required' });

  try {
    const result = await sendEmail(req.user.id, { to, subject, body });
    return res.status(200).json(result);
  } catch (err) {
    return fail(res, 'send_failed', req.user.id, err, 'Could not send the email');
  }
});

/**
 * POST /api/send/verify-recipient — advisory deliverability check on one address.
 *
 * POST, not GET, so the address travels in the body: a query string lands in
 * access logs, proxy history and the browser's own history, and this one names
 * who the user is contacting.
 *
 * Advisory only. It persists nothing, touches no table, and never blocks a send —
 * the answer goes back to the caller and the human decides (CLAUDE.md Decisions,
 * 2026-08-05: MX is a risk signal, bounce detection is the real one).
 *
 * The log line carries {userId, status} and nothing else. Not the address, and
 * not the domain either: the domain still reveals who is being contacted, and
 * the logger allowlist has no field for it.
 */
router.post('/send/verify-recipient', verifyLimiter, requireAuth, async (req, res) => {
  const to = text(bodyOf(req).to);

  if (to === '') return res.status(400).json({ error: 'A recipient email address is required' });

  // A per-recipient verdict must not be cached by a browser or an intermediary.
  res.set('Cache-Control', 'no-store');

  try {
    const result = await verifyRecipient(to);
    logger.info('recipient_verified', { userId: req.user.id, status: result.status });

    return res.status(200).json(result);
  } catch (err) {
    return fail(res, 'recipient_verify_failed', req.user.id, err, 'Could not check the address');
  }
});

/** GET /api/threads — sent threads plus reply state, derived from Gmail on read. */
router.get('/threads', requireAuth, async (req, res) => {
  try {
    const threads = await listSentThreads(req.user.id, { limit: THREAD_LIMIT });
    return res.status(200).json({ threads });
  } catch (err) {
    return fail(res, 'threads_failed', req.user.id, err, 'Could not load your sent threads');
  }
});

export default router;
