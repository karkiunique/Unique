import express from 'express';
import path from 'node:path';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

import healthRoutes from './routes/health.js';
import meRoutes from './routes/me.js';
import gmailRoutes from './routes/gmail.js';
import voiceRoutes from './routes/voice.js';
import campaignRoutes from './routes/campaigns.js';
import leadRoutes from './routes/leads.js';
import sendRoutes from './routes/send.js';
import unsubscribeRoutes from './routes/unsubscribe.js';
import waitlistRoutes from './routes/waitlist.js';
import targetRoutes from './routes/target.js';
import queueRoutes from './routes/queue.js';
import devInspectRoutes from './routes/devInspect.js';
import { devRoutesEnabled } from './lib/devOnly.js';
import { webDistPath, isSpaRequest, shouldNoIndex } from './lib/webApp.js';
import { logger } from './lib/logger.js';

const DEFAULT_APP_URL = 'http://localhost:5173';

/** CORS is locked to APP_URL only. Non-browser callers (no Origin header) are allowed. */
function buildCorsOptions() {
  const allowedOrigin = process.env.APP_URL || DEFAULT_APP_URL;
  return {
    origin(origin, callback) {
      if (!origin || origin === allowedOrigin) return callback(null, true);
      // Deny by omitting CORS headers rather than throwing a 500.
      return callback(null, false);
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600
  };
}

function buildRateLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: 100,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests, please slow down' }
  });
}

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // CSP is set explicitly rather than left on helmet's defaults. It never mattered
  // while this served only JSON; serving the app's HTML it decides whether the page
  // renders at all, and a default that silently blocks a stylesheet is a bad thing
  // to discover in production.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // Vite emits external JS and CSS. No CDN: fonts are self-hosted and
          // icons are inline SVG, both deliberate (see index.html, Icon.jsx).
          scriptSrc: ["'self'"],
          // 'unsafe-inline' is required for style ATTRIBUTES, which the landing
          // page uses for the benchmark bar widths. Scripts get no such licence.
          styleSrc: ["'self'", "'unsafe-inline'"],
          fontSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          // The browser talks to Supabase Auth directly from this origin.
          connectSrc: ["'self'", 'https://*.supabase.co'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"]
        }
      },
      // The app is served over https by Railway but assets are same-origin.
      crossOriginEmbedderPolicy: false
    })
  );
  app.use(cors(buildCorsOptions()));
  app.use(express.json({ limit: '1mb' }));
  app.use(buildRateLimiter());

  app.use('/api', healthRoutes);
  app.use('/api', meRoutes);
  app.use('/api', gmailRoutes);
  app.use('/api', voiceRoutes);
  app.use('/api', campaignRoutes);
  app.use('/api', leadRoutes);
  app.use('/api', sendRoutes);
  app.use('/api', unsubscribeRoutes);
  app.use('/api', waitlistRoutes);
  app.use('/api', targetRoutes);
  app.use('/api', queueRoutes);

  // Dev-only inspection routes. Checked here (not at module scope) so the gate is
  // re-evaluated per app instance; the router re-checks it on every request too.
  if (devRoutesEnabled()) {
    app.use('/api', devInspectRoutes);
  }

  // THE ORDER BELOW IS LOAD-BEARING. Every /api route is already mounted above.
  // Static assets come next, then the SPA shell, then the JSON 404 — reversed, the
  // shell would swallow unmatched API paths and a typo'd endpoint would answer
  // 200 text/html instead of 404 {"error"}.
  const dist = webDistPath();

  if (dist) {
    // index:false so the static layer never answers "/" itself; the SPA fallback
    // below owns every HTML response, so there is exactly one place that decides.
    app.use(express.static(dist, { index: false }));

    app.use((req, res, next) => {
      if (!isSpaRequest(req.method, req.path)) return next();

      // Index the front page, nothing else. The app routes share this shell, so
      // the instruction has to come from a header rather than a meta tag.
      if (shouldNoIndex(req.path)) res.set('X-Robots-Tag', 'noindex, nofollow');

      return res.sendFile(path.join(dist, 'index.html'));
    });
  }

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Error handler must keep 4 params for Express to recognise it.
  // We never log err.message: body-parser errors can echo request content.
  app.use((err, req, res, _next) => {
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Request body too large' });
    }
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    const status = Number(err?.status || err?.statusCode) || 500;
    logger.error('request_failed', {
      route: req.path,
      method: req.method,
      status,
      name: err?.name
    });
    return res.status(status).json({ error: status >= 500 ? 'Internal server error' : 'Request failed' });
  });

  return app;
}
