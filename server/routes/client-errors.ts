import { Router } from 'express';
import { z } from 'zod';
import logger from '../logger';

const ClientErrorSchema = z.object({
  message: z.string().max(4000),
  stack: z.string().max(16000).optional(),
  componentStack: z.string().max(16000).optional(),
  url: z.string().max(2000).optional(),
  source: z.enum(['window.onerror', 'unhandledrejection', 'error-boundary']).optional(),
});

/**
 * Sink for frontend errors (error boundary + window.onerror/unhandledrejection,
 * see src/lib/error-reporter.ts). Routes them through the server logger so they
 * land in the persisted log files instead of vanishing in a browser console.
 */
export function createClientErrorsRouter(): Router {
  const router = Router();

  router.post('/client-errors', (req, res) => {
    const parsed = ClientErrorSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid client error payload' });
      return;
    }
    const { message, stack, componentStack, url, source } = parsed.data;
    logger.error({ client: true, source, url, stack, componentStack }, `client error: ${message}`);
    res.status(204).end();
  });

  return router;
}
