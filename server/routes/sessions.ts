import { Router } from 'express';
import { z } from 'zod';
import { SessionOriginSchema } from '../../src/shared/schemas';
import { validateQuery } from '../middleware/validate';
import type { SessionService } from '../services/session-service';
import type { MessageService } from '../services/message-service';

/**
 * Query parameter schema for GET /api/sessions.
 * All fields optional; coerces string booleans and numbers from query strings.
 */
const ListSessionsQuerySchema = z.object({
  origin: SessionOriginSchema.optional(),
  active: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  limit: z
    .string()
    .transform(Number)
    .pipe(z.number().int().min(1).max(1000))
    .optional(),
  offset: z
    .string()
    .transform(Number)
    .pipe(z.number().int().min(0))
    .optional(),
});

/**
 * Query parameter schema for GET /api/sessions/:id/messages.
 */
const ListMessagesQuerySchema = z.object({
  limit: z
    .string()
    .transform(Number)
    .pipe(z.number().int().min(1).max(1000))
    .optional(),
  before: z
    .string()
    .transform(Number)
    .pipe(z.number().int().min(0))
    .optional(),
});

/**
 * Creates the sessions router with injected service dependencies.
 *
 * Endpoints:
 * - GET /api/sessions — list sessions with optional origin/active/pagination filters
 * - GET /api/sessions/:id — get a single session by ID
 * - GET /api/sessions/:id/messages — list messages for a session with pagination
 */
export function createSessionsRouter(
  sessionService: SessionService,
  messageService: MessageService,
): Router {
  const router = Router();

  /**
   * GET /api/sessions
   * Lists sessions with optional filtering.
   *
   * Query params:
   * - origin: 'dashboard' | 'external'
   * - active: 'true' | 'false' (active = ended_at IS NULL)
   * - limit: number (default 100, max 1000)
   * - offset: number (default 0)
   */
  router.get(
    '/sessions',
    validateQuery(ListSessionsQuerySchema),
    (req, res) => {
      const query = req.query as z.infer<typeof ListSessionsQuerySchema>;
      const sessions = sessionService.list({
        origin: query.origin,
        active: query.active,
        limit: query.limit,
        offset: query.offset,
      });
      res.json(sessions);
    },
  );

  /**
   * GET /api/sessions/:id
   * Returns a single session by ID, or 404 if not found.
   */
  router.get('/sessions/:id', (req, res) => {
    const session = sessionService.get(req.params['id']!);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(session);
  });

  /**
   * GET /api/sessions/:id/messages
   * Returns messages for a session, ordered by created_at ascending.
   *
   * Query params:
   * - limit: number (default 100, max 1000)
   * - before: number (created_at cursor for pagination)
   */
  router.get(
    '/sessions/:id/messages',
    validateQuery(ListMessagesQuerySchema),
    (req, res) => {
      // Verify session exists
      const sessionId = req.params['id']!;
      const session = sessionService.get(sessionId);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      const query = req.query as z.infer<typeof ListMessagesQuerySchema>;
      const messages = messageService.listBySession(sessionId, {
        limit: query.limit,
        before: query.before,
      });
      res.json(messages);
    },
  );

  return router;
}
