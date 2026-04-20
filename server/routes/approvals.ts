import { Router } from 'express';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import type { ApprovalCoordinator } from '../approval-coordinator';
import { ApprovalDecisionSchema } from '../../src/shared/schemas';
import { validateBody } from '../middleware/validate';
import logger from '../logger';

/**
 * Zod schema for the approval decision body.
 */
const DecideApprovalBodySchema = z.object({
  decision: ApprovalDecisionSchema,
  reason: z.string().optional(),
});

/**
 * Creates the approvals router.
 *
 * Endpoints:
 * - GET /approvals — list approvals, optionally filtered by status
 * - POST /approvals/:id/decide — resolve a pending approval
 *
 * @param db - Database connection for querying approval rows
 * @param coordinator - The ApprovalCoordinator singleton
 */
export function createApprovalsRouter(
  db: Database.Database,
  coordinator: ApprovalCoordinator,
): Router {
  const router = Router();

  /**
   * GET /approvals
   * Returns approvals, optionally filtered by ?status=pending|approved|denied|timeout
   */
  router.get('/approvals', (req, res) => {
    try {
      const status = req.query['status'] as string | undefined;

      let rows;
      if (status) {
        rows = db
          .prepare(`SELECT * FROM approvals WHERE status = ? ORDER BY requested_at DESC`)
          .all(status);
      } else {
        rows = db.prepare(`SELECT * FROM approvals ORDER BY requested_at DESC`).all();
      }

      res.json(rows);
    } catch (err) {
      logger.error({ err }, 'Error listing approvals');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /approvals/:id/decide
   * Resolves a pending approval with the given decision.
   * Body: { decision: "approved"|"denied"|"timeout", reason?: string }
   */
  router.post(
    '/approvals/:id/decide',
    validateBody(DecideApprovalBodySchema),
    (req, res) => {
      try {
        const approvalId = req.params['id'];
        if (!approvalId) {
          res.status(400).json({ error: 'Missing approval ID' });
          return;
        }

        const { decision, reason } = req.body as z.infer<typeof DecideApprovalBodySchema>;

        const resolved = coordinator.resolve(approvalId, decision, reason);

        if (!resolved) {
          // Check if it exists at all
          const row = db
            .prepare(`SELECT status FROM approvals WHERE id = ?`)
            .get(approvalId) as { status: string } | undefined;

          if (!row) {
            res.status(404).json({ error: 'Approval not found' });
            return;
          }

          // Already resolved
          res.status(409).json({
            error: 'Approval already resolved',
            status: row.status,
          });
          return;
        }

        // Return the updated approval row
        const updated = db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(approvalId);
        res.json(updated);
      } catch (err) {
        logger.error({ err }, 'Error resolving approval');
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  );

  return router;
}
