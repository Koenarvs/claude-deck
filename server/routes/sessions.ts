import { Router } from 'express';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { SessionOriginSchema } from '../../src/shared/schemas';
import { validateQuery } from '../middleware/validate';
import type { SessionService } from '../services/session-service';
import type { MessageService } from '../services/message-service';
import { getSessionUsage } from '../services/usage-service';

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
 * Query parameter schema for GET /api/sessions/:id/events.
 */
const ListEventsQuerySchema = z.object({
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
 * Creates the sessions router with injected service dependencies.
 *
 * Endpoints:
 * - GET /api/sessions — list sessions with optional origin/active/pagination filters
 * - GET /api/sessions/:id — get a single session by ID
 * - GET /api/sessions/:id/messages — list messages for a session with pagination
 * - GET /api/sessions/:id/events — list hook events for a session with pagination
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
      const query = (req as unknown as Record<string, unknown>)['validatedQuery'] as z.infer<typeof ListSessionsQuerySchema>;

      // Check for goal_id filter (not in zod schema, passed as raw query param)
      const goalId = typeof req.query['goal_id'] === 'string' ? req.query['goal_id'] : undefined;

      if (goalId) {
        // Direct DB query for goal-scoped sessions (includes children)
        const db = (req.app as unknown as { locals: { db: import('better-sqlite3').Database } }).locals?.db;
        if (db) {
          const rows = db.prepare(
            'SELECT * FROM sessions WHERE goal_id = ? ORDER BY started_at ASC LIMIT ?'
          ).all(goalId, query.limit ?? 200);
          res.json(rows);
          return;
        }
      }

      const sessions = sessionService.list({
        origin: query.origin,
        active: query.active,
        limit: query.limit,
        offset: query.offset,
      });

      // Enrich sessions with last_event_at and current_tool
      const db = (req.app as unknown as { locals: { db: Database.Database } }).locals?.db;
      if (db && sessions.length > 0) {
        const sessionIds = sessions.map((s) => s.id);
        const placeholders = sessionIds.map(() => '?').join(',');

        // Get last_event_at per session
        const lastEventRows = db.prepare(
          `SELECT session_id, MAX(created_at) as last_event_at
           FROM hook_events
           WHERE session_id IN (${placeholders})
           GROUP BY session_id`
        ).all(...sessionIds) as Array<{ session_id: string; last_event_at: number }>;

        const lastEventMap = new Map(lastEventRows.map((r) => [r.session_id, r.last_event_at]));

        // Get current_tool per session: most recent PreToolUse without a matching PostToolUse
        // A tool is "currently executing" if there's a PreToolUse that came after the last PostToolUse
        const currentToolRows = db.prepare(
          `SELECT he.session_id, he.tool_name
           FROM hook_events he
           WHERE he.session_id IN (${placeholders})
             AND he.event_type = 'PreToolUse'
             AND he.tool_name IS NOT NULL
             AND he.created_at = (
               SELECT MAX(he2.created_at)
               FROM hook_events he2
               WHERE he2.session_id = he.session_id
                 AND he2.event_type = 'PreToolUse'
             )
             AND NOT EXISTS (
               SELECT 1 FROM hook_events he3
               WHERE he3.session_id = he.session_id
                 AND he3.event_type = 'PostToolUse'
                 AND he3.created_at > he.created_at
             )`
        ).all(...sessionIds) as Array<{ session_id: string; tool_name: string }>;

        const currentToolMap = new Map(currentToolRows.map((r) => [r.session_id, r.tool_name]));

        const enriched = sessions.map((s) => ({
          ...s,
          last_event_at: lastEventMap.get(s.id) ?? null,
          current_tool: currentToolMap.get(s.id) ?? null,
        }));

        res.json(enriched);
      } else {
        res.json(sessions.map((s) => ({ ...s, last_event_at: null, current_tool: null })));
      }
    },
  );

  /**
   * GET /api/sessions/:id
   * Returns a single session by ID, or 404 if not found.
   */
  router.get('/sessions/:id', (req, res) => {
    const session = sessionService.get(String(String(req.params['id'])));
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
      const sessionId = String(String(req.params['id']));
      const session = sessionService.get(sessionId);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      const query = (req as unknown as Record<string, unknown>)['validatedQuery'] as z.infer<typeof ListMessagesQuerySchema>;
      const messages = messageService.listBySession(sessionId, {
        limit: query.limit,
        before: query.before,
      });
      res.json(messages);
    },
  );

  /**
   * POST /api/sessions/:id/end
   * Manually marks a session as ended. Used for stale sessions that never received a Stop hook.
   */
  router.post('/sessions/:id/end', (req, res) => {
    const sessionId = String(req.params['id']);
    const session = sessionService.get(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (session.ended_at != null) {
      res.status(409).json({ error: 'Session already ended' });
      return;
    }
    sessionService.end(sessionId);
    res.json({ ok: true, ended_at: Date.now() });
  });

  /**
   * GET /api/sessions/:id/usage
   * Returns token usage parsed from Claude Code's local JSONL logs.
   */
  router.get('/sessions/:id/usage', (req, res) => {
    const sessionId = String(req.params['id']);
    const session = sessionService.get(sessionId);
    const usage = getSessionUsage(sessionId, session?.model ?? null);
    if (!usage) {
      res.json({ inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0, currentContextTokens: 0, estimatedCostUsd: 0, messageCount: 0 });
      return;
    }
    res.json(usage);
  });

  /**
   * GET /api/sessions/:id/events
   * Returns hook events for a session, ordered by created_at descending.
   *
   * Query params:
   * - limit: number (default 100, max 1000)
   * - offset: number (default 0)
   */
  router.get(
    '/sessions/:id/events',
    validateQuery(ListEventsQuerySchema),
    (req, res) => {
      const sessionId = String(req.params['id']);
      const session = sessionService.get(sessionId);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      const query = (req as unknown as Record<string, unknown>)['validatedQuery'] as z.infer<typeof ListEventsQuerySchema>;
      const limit = query.limit ?? 100;
      const offset = query.offset ?? 0;

      const db = (req.app as unknown as { locals: { db: Database.Database } }).locals?.db;
      if (!db) {
        res.json([]);
        return;
      }

      const events = db.prepare(
        `SELECT * FROM hook_events
         WHERE session_id = ?
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`
      ).all(sessionId, limit, offset);

      res.json(events);
    },
  );

  return router;
}
