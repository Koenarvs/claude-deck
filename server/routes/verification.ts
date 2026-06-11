import { Router } from 'express';
import type { Request, Response } from 'express';
import type { VerificationService } from '../services/verification-service';

/**
 * 5C verification gate routes:
 * - GET /goals/:id/verification — the latest doneCommand result for a goal (404 if none).
 * - GET /analytics/model-scorecard — per-model pass rate from completed verifications.
 */
export function createVerificationRouter(svc: VerificationService): Router {
  const router = Router();

  router.get('/goals/:id/verification', (req: Request, res: Response) => {
    const result = svc.latestForGoal(String(req.params['id']));
    if (!result) {
      res.status(404).json({ error: 'No verification result for this goal' });
      return;
    }
    res.json(result);
  });

  router.get('/analytics/model-scorecard', (_req: Request, res: Response) => {
    res.json(svc.modelScorecard());
  });

  return router;
}
