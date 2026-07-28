import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

/**
 * GET /api/me — authenticated smoke route.
 * Exists so the JWT middleware is exercisable end-to-end in Phase 1.
 */
router.get('/me', requireAuth, (req, res) => {
  res.status(200).json({
    user: {
      id: req.user.id,
      email: req.user.email
    }
  });
});

export default router;
