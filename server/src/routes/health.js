import { Router } from 'express';

const router = Router();

/** GET /api/health — unauthenticated liveness probe. No secrets in the response. */
router.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'voicereach-server',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

export default router;
