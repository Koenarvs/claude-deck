import { Router } from 'express';
import cron from 'node-cron';
import type { Request, Response } from 'express';
import {
  CreateScheduledTaskInputSchema,
  UpdateScheduledTaskInputSchema,
} from '../../src/shared/schemas';
import { validateBody } from '../middleware/validate';
import type { ScheduledTaskService } from '../services/scheduled-task-service';
import type { Scheduler } from '../scheduler';
import type { CreateScheduledTaskInput, UpdateScheduledTaskInput } from '../../src/shared/types';

/**
 * Creates the `/api/scheduled-tasks` router.
 *
 * Provides CRUD endpoints for scheduled tasks and a `run-now` action.
 * All mutation endpoints refresh the in-memory scheduler after persisting changes.
 *
 * @param taskService - Handles database persistence for scheduled tasks.
 * @param scheduler - Manages in-memory cron job registration.
 */
export function createScheduledRouter(
  taskService: ScheduledTaskService,
  scheduler: Scheduler,
): Router {
  const router = Router();

  /** GET /api/scheduled-tasks — returns all scheduled tasks. */
  router.get('/scheduled-tasks', (_req: Request, res: Response) => {
    const tasks = taskService.list();
    res.json(tasks);
  });

  /** POST /api/scheduled-tasks — creates a new scheduled task. */
  router.post(
    '/scheduled-tasks',
    validateBody(CreateScheduledTaskInputSchema),
    (req: Request, res: Response) => {
      const input = req.body as CreateScheduledTaskInput;

      if (!cron.validate(input.cron_expr)) {
        res.status(400).json({ error: `Invalid cron expression: ${input.cron_expr}` });
        return;
      }

      const task = taskService.create(input);
      scheduler.refresh(task.id);
      res.status(201).json(task);
    },
  );

  /** PATCH /api/scheduled-tasks/:id — updates an existing scheduled task. */
  router.patch(
    '/scheduled-tasks/:id',
    validateBody(UpdateScheduledTaskInputSchema),
    (req: Request, res: Response) => {
      const id = String(req.params['id']);
      const input = req.body as UpdateScheduledTaskInput;

      if (input.cron_expr !== undefined && !cron.validate(input.cron_expr)) {
        res.status(400).json({ error: `Invalid cron expression: ${input.cron_expr}` });
        return;
      }

      const task = taskService.update(id, input);
      if (!task) {
        res.status(404).json({ error: 'Scheduled task not found' });
        return;
      }

      scheduler.refresh(task.id);
      res.json(task);
    },
  );

  /** DELETE /api/scheduled-tasks/:id — deletes a scheduled task and unregisters its cron job. */
  router.delete('/scheduled-tasks/:id', (req: Request, res: Response) => {
    const id = String(req.params['id']);

    const deleted = taskService.delete(id);
    if (!deleted) {
      res.status(404).json({ error: 'Scheduled task not found' });
      return;
    }

    scheduler.refresh(id);
    res.json({ deleted: true });
  });

  /** POST /api/scheduled-tasks/:id/run-now — fires the task immediately, creating a goal. */
  router.post('/scheduled-tasks/:id/run-now', (req: Request, res: Response) => {
    const id = String(req.params['id']);

    try {
      const result = scheduler.runNow(id);
      res.json(result);
    } catch (err) {
      if (err instanceof Error && err.message.includes('not found')) {
        res.status(404).json({ error: 'Scheduled task not found' });
        return;
      }
      throw err;
    }
  });

  return router;
}
