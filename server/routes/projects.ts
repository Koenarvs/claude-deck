import { Router } from 'express';
import type { Request, Response } from 'express';
import { CreateProjectInputSchema, UpdateProjectInputSchema } from '../../src/shared/schemas';
import { validateBody } from '../middleware/validate';
import type { ProjectService } from '../services/project-service';
import { ProjectNotFoundError, DuplicateProjectRootError } from '../services/project-service';
import logger from '../logger';

/**
 * CRUD router for the project registry (5A).
 * - POST   /projects        create
 * - GET    /projects        list
 * - GET    /projects/:id    read
 * - PATCH  /projects/:id    update
 * - DELETE /projects/:id    remove
 */
export function createProjectsRouter(projectService: ProjectService): Router {
  const router = Router();

  router.post('/projects', validateBody(CreateProjectInputSchema), (req: Request, res: Response) => {
    try {
      res.status(201).json(projectService.create(req.body));
    } catch (err) {
      if (err instanceof DuplicateProjectRootError) {
        res.status(409).json({ error: err.message });
        return;
      }
      logger.error({ err }, 'Failed to create project');
      res.status(500).json({ error: 'Failed to create project' });
    }
  });

  router.get('/projects', (_req: Request, res: Response) => {
    res.json(projectService.list());
  });

  router.get('/projects/:id', (req: Request, res: Response) => {
    const p = projectService.get(String(req.params['id']));
    if (!p) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.json(p);
  });

  router.patch(
    '/projects/:id',
    validateBody(UpdateProjectInputSchema),
    (req: Request, res: Response) => {
      try {
        res.json(projectService.update(String(req.params['id']), req.body));
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          res.status(404).json({ error: err.message });
          return;
        }
        logger.error({ err }, 'Failed to update project');
        res.status(500).json({ error: 'Failed to update project' });
      }
    },
  );

  router.delete('/projects/:id', (req: Request, res: Response) => {
    try {
      projectService.remove(String(req.params['id']));
      res.json({ removed: true });
    } catch (err) {
      if (err instanceof ProjectNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      logger.error({ err }, 'Failed to remove project');
      res.status(500).json({ error: 'Failed to remove project' });
    }
  });

  return router;
}
