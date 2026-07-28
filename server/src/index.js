import 'dotenv/config';

import { createApp } from './app.js';
import { logger } from './lib/logger.js';

const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];

function warnOnMissingEnv() {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    // Names only — never values.
    logger.warn('env_missing', { count: missing.length, reason: missing.join(',') });
  }
}

const port = Number(process.env.PORT) || 3000;

warnOnMissingEnv();

const app = createApp();

app.listen(port, () => {
  logger.info('server_started', { port, env: process.env.NODE_ENV || 'development' });
});
