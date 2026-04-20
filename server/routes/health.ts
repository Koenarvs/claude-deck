import { Router } from 'express';

const router = Router();

/** GET /health — returns server health status and uptime. */
router.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

export default router;
