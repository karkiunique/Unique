import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

import healthRoutes from './routes/health.js';
import meRoutes from './routes/me.js';
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

  app.use(helmet());
  app.use(cors(buildCorsOptions()));
  app.use(express.json({ limit: '1mb' }));
  app.use(buildRateLimiter());

  app.use('/api', healthRoutes);
  app.use('/api', meRoutes);

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
