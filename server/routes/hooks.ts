import { Router } from 'express';
import { z } from 'zod';
import type { HookIngest } from '../hook-ingest';
import { validateBody } from '../middleware/validate';
import logger from '../logger';

/**
 * Zod schema for the hook payload body.
 * Validates the common fields sent by hooks/client.js.
 * Extra fields are passed through (passthrough mode).
 */
const HookPayloadSchema = z
  .object({
    session_id: z.string().optional(),
    tool_name: z.string().optional(),
    tool_input: z.record(z.unknown()).optional(),
    cwd: z.string().optional(),
    model: z.string().optional(),
    timestamp: z.number().optional(),
    received_at: z.number().optional(),
  })
  .passthrough();

/**
 * Creates the hook ingest router.
 *
 * Endpoints:
 * - POST /hook/session-start — fires on session init
 * - POST /hook/user-prompt-submit — fires when user submits a prompt
 * - POST /hook/pre-tool-use — blocks until approval decision or timeout
 * - POST /hook/post-tool-use — fires after tool execution
 * - POST /hook/stop — fires when session ends
 *
 * All endpoints validate the body, persist to hook_events, and fail-open on server errors
 * (for pre-tool-use, return { decision: "allow" } on error).
 *
 * @param hookIngest - The HookIngest service instance
 */
export function createHooksRouter(hookIngest: HookIngest): Router {
  const router = Router();

  /**
   * POST /hook/session-start
   * Creates a sessions row if not exists, broadcasts session:observed.
   */
  router.post('/hook/session-start', validateBody(HookPayloadSchema), (req, res) => {
    try {
      hookIngest.onSessionStart(req.body);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'Error in session-start hook handler');
      res.json({ ok: true }); // fail-open
    }
  });

  /**
   * POST /hook/user-prompt-submit
   * Logs the prompt submission event.
   */
  router.post('/hook/user-prompt-submit', validateBody(HookPayloadSchema), (req, res) => {
    try {
      hookIngest.onUserPromptSubmit(req.body);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'Error in user-prompt-submit hook handler');
      res.json({ ok: true }); // fail-open
    }
  });

  /**
   * POST /hook/pre-tool-use
   * Blocks until the approval coordinator resolves (UI decision or timeout).
   * Returns { decision: "allow"|"deny", reason? }.
   * Fails open on server errors: returns { decision: "allow" }.
   */
  router.post('/hook/pre-tool-use', validateBody(HookPayloadSchema), async (req, res) => {
    try {
      const decision = await hookIngest.onPreToolUse(req.body);
      res.json(decision);
    } catch (err) {
      logger.error({ err }, 'Error in pre-tool-use hook handler — failing open');
      res.json({ decision: 'allow' }); // fail-open
    }
  });

  /**
   * POST /hook/post-tool-use
   * Processes tool result; extracts plan from TodoWrite if applicable.
   */
  router.post('/hook/post-tool-use', validateBody(HookPayloadSchema), (req, res) => {
    try {
      hookIngest.onPostToolUse(req.body);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'Error in post-tool-use hook handler');
      res.json({ ok: true }); // fail-open
    }
  });

  /**
   * POST /hook/permission-request
   * 3-option permission dialogs (yes / yes always / no).
   * Blocks until approval decision, like pre-tool-use.
   */
  router.post('/hook/permission-request', validateBody(HookPayloadSchema), async (req, res) => {
    try {
      const decision = await hookIngest.onPermissionRequest(req.body);
      res.json(decision);
    } catch (err) {
      logger.error({ err }, 'Error in permission-request hook handler — failing open');
      res.json({ decision: 'allow' }); // fail-open
    }
  });

  /**
   * POST /hook/subagent-start
   * Links child session to parent session and goal.
   */
  router.post('/hook/subagent-start', validateBody(HookPayloadSchema), (req, res) => {
    try {
      hookIngest.onSubagentStart(req.body);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'Error in subagent-start hook handler');
      res.json({ ok: true }); // fail-open
    }
  });

  /**
   * POST /hook/subagent-stop
   * Marks child session as ended.
   */
  router.post('/hook/subagent-stop', validateBody(HookPayloadSchema), (req, res) => {
    try {
      hookIngest.onSubagentStop(req.body);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'Error in subagent-stop hook handler');
      res.json({ ok: true }); // fail-open
    }
  });

  /**
   * POST /hook/stop
   * Marks the session as ended.
   */
  router.post('/hook/stop', validateBody(HookPayloadSchema), (req, res) => {
    try {
      hookIngest.onStop(req.body);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'Error in stop hook handler');
      res.json({ ok: true }); // fail-open
    }
  });

  return router;
}
