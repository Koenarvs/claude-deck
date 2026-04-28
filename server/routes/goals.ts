import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { GoalStatus } from '../../src/shared/types';
import { CreateGoalInputSchema, UpdateGoalInputSchema, GoalStatusSchema } from '../../src/shared/schemas';
import { validateBody, validateQuery } from '../middleware/validate';
import type { GoalService } from '../services/goal-service';
import { GoalNotFoundError, InvalidTransitionError } from '../services/goal-service';
import logger from '../logger';

// ── Query Schemas ────────────────────────────────────────────────────────────

const ListGoalsQuerySchema = z.object({
  status: GoalStatusSchema.optional(),
  tag: z.string().optional(),
});

const SendMessageBodySchema = z.object({
  prompt: z.string().min(1),
  modelOverride: z.string().optional(),
});

const AdoptSessionBodySchema = z.object({
  session_id: z.string().min(1),
});

// ── Route Factory ────────────────────────────────────────────────────────────

/**
 * Creates the goals router with all CRUD + action endpoints.
 * Injects the GoalService dependency so the router is testable
 * with an in-memory database.
 *
 * Endpoints:
 * - POST   /goals              — Create a new goal
 * - GET    /goals              — List goals (filter by status, tag)
 * - GET    /goals/:id          — Get goal detail (goal + messages + plan)
 * - PATCH  /goals/:id          — Update a goal (title, status, kanban_order, etc.)
 * - DELETE /goals/:id          — Archive (soft-delete) a goal
 * - POST   /goals/:id/messages — Send a message to spawn/resume a session
 * - POST   /goals/:id/interrupt — Interrupt the active session
 * - POST   /goals/:id/adopt-session — Link an external session to this goal
 *
 * @param goalService - The GoalService instance
 */
export function createGoalsRouter(
  goalService: GoalService,
  spawnSession?: (goalId: string, prompt: string) => string,
  spawnTerminal?: (goalId: string, initialPrompt?: string) => string,
): Router {
  const router = Router();

  /**
   * POST /goals — Create a new goal.
   * Body: CreateGoalInput (title, cwd required; description, model, permission_mode, tags, initialPrompt optional).
   * Returns: 201 with the created Goal.
   */
  router.post(
    '/goals',
    validateBody(CreateGoalInputSchema),
    (req: Request, res: Response) => {
      try {
        const goal = goalService.create(req.body);
        // Note: initialPrompt handling (spawning SessionRunner) is deferred to B1 integration.
        // The goal is created in 'planning' status; B1's sendMessage will transition it to 'active'.
        res.status(201).json(goal);
      } catch (err) {
        logger.error({ err }, 'Failed to create goal');
        res.status(500).json({ error: 'Failed to create goal' });
      }
    },
  );

  /**
   * GET /goals — List goals with optional filters.
   * Query: status? (GoalStatus), tag? (string).
   * Returns: 200 with Goal[].
   */
  router.get(
    '/goals',
    validateQuery(ListGoalsQuerySchema),
    (req: Request, res: Response) => {
      try {
        const status = req.query['status'] as string | undefined;
        const tag = req.query['tag'] as string | undefined;

        const goals = goalService.list(
          status || tag
            ? { status: status as GoalStatus | undefined, tag }
            : undefined,
        );
        res.json(goals);
      } catch (err) {
        logger.error({ err }, 'Failed to list goals');
        res.status(500).json({ error: 'Failed to list goals' });
      }
    },
  );

  /**
   * GET /goals/:id — Get goal detail including messages and plan.
   * Returns: 200 with GoalDetail, or 404 if not found.
   */
  router.get('/goals/:id', (req: Request, res: Response) => {
    try {
      const detail = goalService.getDetail(String(String(req.params['id'])));
      if (!detail) {
        res.status(404).json({ error: 'Goal not found' });
        return;
      }
      res.json(detail);
    } catch (err) {
      logger.error({ err }, 'Failed to get goal detail');
      res.status(500).json({ error: 'Failed to get goal detail' });
    }
  });

  /**
   * PATCH /goals/:id — Update a goal.
   * Body: UpdateGoalInput (all fields optional: title, description, status, priority, tags, model, permission_mode, kanban_order).
   * Returns: 200 with updated Goal, 400 on invalid transition, 404 if not found.
   */
  router.patch(
    '/goals/:id',
    validateBody(UpdateGoalInputSchema),
    (req: Request, res: Response) => {
      try {
        const goal = goalService.update(String(String(req.params['id'])), req.body);
        res.json(goal);
      } catch (err) {
        if (err instanceof GoalNotFoundError) {
          res.status(404).json({ error: err.message });
          return;
        }
        if (err instanceof InvalidTransitionError) {
          res.status(400).json({
            error: err.message,
            from: err.from,
            to: err.to,
          });
          return;
        }
        logger.error({ err }, 'Failed to update goal');
        res.status(500).json({ error: 'Failed to update goal' });
      }
    },
  );

  /**
   * DELETE /goals/:id — Soft-delete (archive) a goal.
   * Returns: 200 with { archived: true }, 404 if not found.
   */
  router.delete('/goals/:id', (req: Request, res: Response) => {
    try {
      goalService.archive(String(String(req.params['id'])));
      res.json({ archived: true });
    } catch (err) {
      if (err instanceof GoalNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      if (err instanceof InvalidTransitionError) {
        res.status(400).json({
          error: err.message,
          from: err.from,
          to: err.to,
        });
        return;
      }
      logger.error({ err }, 'Failed to archive goal');
      res.status(500).json({ error: 'Failed to archive goal' });
    }
  });

  /**
   * POST /goals/:id/messages — Send a message to the goal's session.
   * Body: { prompt: string, modelOverride?: string }.
   * Returns: 200 with { session_id }, 404 if goal not found.
   *
   * Note: Full session spawning/piping is deferred to B1 integration.
   * This endpoint currently validates input and returns a placeholder response.
   */
  router.post(
    '/goals/:id/messages',
    validateBody(SendMessageBodySchema),
    (req: Request, res: Response) => {
      try {
        const goal = goalService.get(String(String(req.params['id'])));
        if (!goal) {
          res.status(404).json({ error: 'Goal not found' });
          return;
        }

        const prompt = req.body.prompt as string;

        if (spawnSession) {
          const sessionId = spawnSession(goal.id, prompt);
          res.json({ session_id: sessionId });
        } else {
          // No session spawner configured
          res.json({ session_id: goal.current_session_id });
        }
      } catch (err) {
        logger.error({ err }, 'Failed to send message');
        res.status(500).json({ error: 'Failed to send message' });
      }
    },
  );

  /**
   * POST /goals/:id/interrupt — Interrupt the goal's active session.
   * Returns: 200 with { killed: true }, 404 if goal not found.
   *
   * Note: Full subprocess kill is deferred to B1 integration.
   */
  router.post('/goals/:id/interrupt', (req: Request, res: Response) => {
    try {
      const goal = goalService.get(String(String(req.params['id'])));
      if (!goal) {
        res.status(404).json({ error: 'Goal not found' });
        return;
      }

      // B1 integration: processRegistry.get(id)?.interrupt()
      // Then transition goal to 'waiting'.
      res.json({ killed: true });
    } catch (err) {
      logger.error({ err }, 'Failed to interrupt goal');
      res.status(500).json({ error: 'Failed to interrupt goal' });
    }
  });

  /**
   * POST /goals/:id/adopt-session — Link an external session to this goal.
   * Body: { session_id: string }.
   * Returns: 200 with the updated Goal, 404 if goal not found.
   */
  router.post(
    '/goals/:id/adopt-session',
    validateBody(AdoptSessionBodySchema),
    (req: Request, res: Response) => {
      try {
        const goal = goalService.adoptSession(
          String(String(req.params['id'])),
          req.body.session_id,
        );
        res.json(goal);
      } catch (err) {
        if (err instanceof GoalNotFoundError) {
          res.status(404).json({ error: err.message });
          return;
        }
        logger.error({ err }, 'Failed to adopt session');
        res.status(500).json({ error: 'Failed to adopt session' });
      }
    },
  );

  /**
   * POST /goals/:id/terminal — Spawn a PTY-based terminal session.
   * Body: { prompt?: string } (optional initial prompt).
   * Returns: 200 with { session_id, status }.
   */
  router.post('/goals/:id/terminal', (req: Request, res: Response) => {
    try {
      const goal = goalService.get(String(req.params['id']));
      if (!goal) {
        res.status(404).json({ error: 'Goal not found' });
        return;
      }

      if (!spawnTerminal) {
        res.status(501).json({ error: 'Terminal mode not available' });
        return;
      }

      const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt : undefined;
      const sessionId = spawnTerminal(goal.id, prompt);
      res.json({
        session_id: sessionId,
        status: sessionId === 'already_running' ? 'already_running' : 'started',
      });
    } catch (err) {
      logger.error({ err }, 'Failed to spawn terminal');
      res.status(500).json({ error: 'Failed to spawn terminal' });
    }
  });

  return router;
}
