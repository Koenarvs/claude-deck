import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { HookEventType, PlanJson, PlanTodo } from '../src/shared/types';
import { ApprovalCoordinator, type Decision } from './approval-coordinator';
import { broadcast } from './ws';
import logger from './logger';

/** Shape of a hook payload received from the CLI hook script. */
export interface HookPayload {
  session_id?: string | undefined;
  tool_name?: string | undefined;
  tool_input?: Record<string, unknown> | undefined;
  cwd?: string | undefined;
  model?: string | undefined;
  timestamp?: number | undefined;
  received_at?: number | undefined;
  [key: string]: unknown;
}

/** TodoWrite item shape from Claude CLI. */
interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority?: number | undefined;
  children?: TodoItem[] | undefined;
}

/**
 * Converts a flat TodoItem from TodoWrite into the nested PlanTodo shape.
 */
function todoItemToPlanTodo(item: TodoItem): PlanTodo {
  return {
    content: item.content,
    status: item.status,
    priority: item.priority ?? 0,
    children: (item.children ?? []).map(todoItemToPlanTodo),
  };
}

/**
 * Service that processes incoming hook events from the CLI.
 *
 * Responsibilities:
 * - Persists all hook events to the `hook_events` table
 * - Creates sessions on SessionStart
 * - Coordinates tool approvals on PreToolUse
 * - Extracts plan updates from TodoWrite on PostToolUse
 * - Marks sessions ended on Stop
 */
export class HookIngest {
  private db: Database.Database;
  private approvalCoordinator: ApprovalCoordinator;

  constructor(db: Database.Database, approvalCoordinator: ApprovalCoordinator) {
    this.db = db;
    this.approvalCoordinator = approvalCoordinator;
  }

  /**
   * Persists a hook event to the database and broadcasts it via WebSocket.
   */
  private persistEvent(
    eventType: HookEventType,
    payload: HookPayload,
    toolName?: string | undefined,
  ): string {
    const id = uuidv4();
    const sessionId = payload.session_id ?? null;
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO hook_events (id, session_id, event_type, tool_name, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, sessionId, eventType, toolName ?? null, JSON.stringify(payload), now);

    // Increment hook_event_count on the session if it exists
    if (sessionId) {
      this.db
        .prepare(`UPDATE sessions SET hook_event_count = hook_event_count + 1 WHERE id = ?`)
        .run(sessionId);
    }

    // Broadcast the raw hook event
    broadcast({
      type: 'hook:event',
      event: {
        id,
        session_id: sessionId,
        event_type: eventType,
        tool_name: toolName ?? null,
        payload_json: JSON.stringify(payload),
        created_at: now,
      },
    });

    return id;
  }

  /**
   * Handles a SessionStart hook event.
   * Creates a sessions row with origin='external' if one does not already exist.
   */
  onSessionStart(payload: HookPayload): void {
    this.persistEvent('SessionStart', payload);

    const sessionId = payload.session_id;
    if (!sessionId) {
      logger.warn('SessionStart hook missing session_id');
      return;
    }

    // Check if session already exists (dashboard-spawned sessions are pre-created)
    const existing = this.db.prepare(`SELECT id FROM sessions WHERE id = ?`).get(sessionId) as
      | { id: string }
      | undefined;

    if (existing) {
      logger.debug({ sessionId }, 'SessionStart for existing session (dashboard-spawned)');
      return;
    }

    // Create new external session with display_name from cwd basename
    const now = Date.now();
    const cwd = payload.cwd ?? null;
    const displayName = cwd ? cwd.replace(/\\/g, '/').split('/').pop() ?? cwd : null;

    // Check if there's an active goal awaiting a session in the same cwd.
    // This catches MCP-spawned sessions where the session row wasn't pre-created
    // (e.g., race condition or alternative spawn path).
    let linkedGoalId: string | null = null;
    let origin: 'external' | 'dashboard' = 'external';
    if (cwd) {
      const waitingGoal = this.db.prepare(
        `SELECT id FROM goals
         WHERE cwd = ? AND current_session_id IS NULL
           AND status IN ('planning', 'active', 'waiting')
         ORDER BY updated_at DESC LIMIT 1`,
      ).get(cwd) as { id: string } | undefined;

      if (waitingGoal) {
        linkedGoalId = waitingGoal.id;
        origin = 'dashboard';
        logger.info(
          { sessionId, goalId: linkedGoalId, cwd },
          'Linked new session to waiting goal by cwd match',
        );
      }
    }

    this.db
      .prepare(
        `INSERT INTO sessions (id, goal_id, origin, cwd, model, display_name, trace_dir, stream_event_count, hook_event_count, stderr_bytes, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 0, 1, 0, ?, NULL)`,
      )
      .run(sessionId, linkedGoalId, origin, cwd, payload.model ?? null, displayName, now);

    // If we linked to a goal, update the goal's current_session_id
    if (linkedGoalId) {
      this.db.prepare(
        `UPDATE goals SET current_session_id = ?, updated_at = ? WHERE id = ?`,
      ).run(sessionId, now, linkedGoalId);

      broadcast({
        type: 'goal:status',
        id: linkedGoalId,
        status: 'active',
        current_session_id: sessionId,
      });
    }

    // Crash recovery: find recent crashed sessions in the same cwd
    // (ended_at IS NULL means the session never received a Stop hook — it crashed)
    if (cwd) {
      const crashedThreshold = now - 60_000; // within last 60 seconds
      const crashedSession = this.db.prepare(
        `SELECT id, goal_id FROM sessions
         WHERE cwd = ? AND ended_at IS NULL AND id != ?
           AND started_at >= ?
         ORDER BY started_at DESC LIMIT 1`,
      ).get(cwd, sessionId, crashedThreshold) as { id: string; goal_id: string | null } | undefined;

      if (crashedSession) {
        // End the crashed session
        this.db.prepare(
          `UPDATE sessions SET ended_at = ? WHERE id = ?`,
        ).run(now, crashedSession.id);

        // Set parent_session_id on the new session
        this.db.prepare(
          `UPDATE sessions SET parent_session_id = ? WHERE id = ?`,
        ).run(crashedSession.id, sessionId);

        // If crashed session had a goal and we didn't already link one, inherit it
        if (crashedSession.goal_id && !linkedGoalId) {
          this.db.prepare(
            `UPDATE sessions SET goal_id = ?, origin = 'dashboard' WHERE id = ?`,
          ).run(crashedSession.goal_id, sessionId);

          this.db.prepare(
            `UPDATE goals SET current_session_id = ?, updated_at = ? WHERE id = ?`,
          ).run(sessionId, now, crashedSession.goal_id);

          broadcast({
            type: 'goal:status',
            id: crashedSession.goal_id,
            status: 'active',
            current_session_id: sessionId,
          });
        }

        broadcast({
          type: 'session:ended',
          id: crashedSession.id,
        });

        logger.info(
          { newSessionId: sessionId, crashedSessionId: crashedSession.id, goalId: crashedSession.goal_id },
          'Crash recovery: linked new session to crashed predecessor',
        );
      }
    }

    const session = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId);
    if (session) {
      // Parse the raw DB row into the Session shape for the broadcast
      const s = session as Record<string, unknown>;
      broadcast({
        type: 'session:observed',
        session: {
          id: s['id'] as string,
          goal_id: (s['goal_id'] as string) ?? null,
          origin: s['origin'] as 'dashboard' | 'external',
          cwd: (s['cwd'] as string) ?? null,
          model: (s['model'] as string) ?? null,
          trace_dir: (s['trace_dir'] as string) ?? null,
          stream_event_count: (s['stream_event_count'] as number) ?? 0,
          hook_event_count: (s['hook_event_count'] as number) ?? 0,
          stderr_bytes: (s['stderr_bytes'] as number) ?? 0,
          started_at: (s['started_at'] as number) ?? null,
          ended_at: (s['ended_at'] as number) ?? null,
        },
      });
    }

    logger.info({ sessionId, cwd: payload.cwd }, 'External session created from hook');
  }

  /**
   * Handles a UserPromptSubmit hook event.
   * Persists the event and logs it.
   */
  onUserPromptSubmit(payload: HookPayload): void {
    this.persistEvent('UserPromptSubmit', payload);
    logger.debug({ session_id: payload.session_id }, 'UserPromptSubmit hook received');
  }

  /**
   * Handles a PreToolUse hook event.
   * Persists the event, then delegates to the ApprovalCoordinator to block
   * until the UI decides or the timeout expires.
   *
   * @returns The decision (allow or deny with optional reason)
   */
  async onPreToolUse(payload: HookPayload): Promise<Decision> {
    const toolName = payload.tool_name ?? 'unknown';
    this.persistEvent('PreToolUse', payload, toolName);

    const sessionId = payload.session_id ?? null;
    const goalId = this.getGoalIdForSession(sessionId);

    logger.debug({
      event: 'PreToolUse',
      toolName,
      sessionId,
      goalId,
    }, 'Hook: PreToolUse — notifying UI (pass-through)');

    // Broadcast for UI indicators (sidebar badge, kanban card) but don't block
    this.approvalCoordinator.notify({
      session_id: sessionId,
      goal_id: goalId,
      tool_name: toolName,
      tool_args: JSON.stringify(payload.tool_input ?? {}),
    });

    // Always pass through — let Claude Code handle permissions natively in the terminal
    return { decision: 'allow' };
  }

  /**
   * Handles a PostToolUse hook event.
   * Persists the event. If the tool was TodoWrite, extracts the plan and updates
   * the linked goal's plan_json.
   */
  onPostToolUse(payload: HookPayload): void {
    const toolName = payload.tool_name ?? null;
    this.persistEvent('PostToolUse', payload, toolName ?? undefined);

    // Extract plan from TodoWrite
    if (toolName === 'TodoWrite' && payload.tool_input) {
      this.extractPlanFromTodoWrite(payload);
    }
  }

  /**
   * Handles a PermissionRequest hook event.
   * These are the 3-option permission dialogs (yes / yes always / no).
   * Routes through the approval coordinator like PreToolUse.
   */
  async onPermissionRequest(payload: HookPayload): Promise<Decision> {
    const toolName = payload.tool_name ?? 'unknown';
    this.persistEvent('PermissionRequest', payload, toolName);

    const sessionId = payload.session_id ?? null;
    const goalId = this.getGoalIdForSession(sessionId);

    logger.info({
      event: 'PermissionRequest',
      toolName,
      sessionId,
      goalId,
      payloadKeys: Object.keys(payload).join(', '),
    }, 'Hook: PermissionRequest — notifying UI (pass-through)');

    // Broadcast for UI indicators but don't block
    this.approvalCoordinator.notify({
      session_id: sessionId,
      goal_id: goalId,
      tool_name: toolName,
      tool_args: JSON.stringify(payload.tool_input ?? {}),
    });

    // Always pass through — let Claude Code handle permissions natively in the terminal
    return { decision: 'allow' };
  }

  /**
   * Handles a SubagentStart hook event.
   * Links the child session to the parent session and goal.
   */
  onSubagentStart(payload: HookPayload): void {
    this.persistEvent('SubagentStart', payload);

    const parentSessionId = payload.session_id ?? null;
    const childSessionId = (payload as Record<string, unknown>).subagent_session_id as string | undefined
      ?? (payload as Record<string, unknown>).child_session_id as string | undefined;
    const agentDescription = (payload as Record<string, unknown>).description as string | undefined
      ?? (payload as Record<string, unknown>).name as string | undefined;

    logger.info({
      event: 'SubagentStart',
      parentSessionId,
      childSessionId,
      agentDescription,
      payloadKeys: Object.keys(payload).join(', '),
      rawPayload: JSON.stringify(payload).substring(0, 1000),
    }, 'Hook: SubagentStart — linking child to parent');

    if (childSessionId && parentSessionId) {
      // Set parent_session_id on the child session
      this.db.prepare(`UPDATE sessions SET parent_session_id = ? WHERE id = ?`)
        .run(parentSessionId, childSessionId);

      // Set display_name from agent description
      if (agentDescription) {
        this.db.prepare(`UPDATE sessions SET display_name = ? WHERE id = ?`)
          .run(agentDescription, childSessionId);
      }

      // Link child to parent's goal
      const parentGoalId = this.getGoalIdForSession(parentSessionId);
      if (parentGoalId) {
        this.db.prepare(`UPDATE sessions SET goal_id = ? WHERE id = ? AND goal_id IS NULL`)
          .run(parentGoalId, childSessionId);
      }
    }
  }

  /**
   * Handles a SubagentStop hook event.
   */
  onSubagentStop(payload: HookPayload): void {
    this.persistEvent('SubagentStop', payload);

    const childSessionId = (payload as Record<string, unknown>).subagent_session_id as string | undefined
      ?? (payload as Record<string, unknown>).child_session_id as string | undefined;

    logger.info({
      event: 'SubagentStop',
      childSessionId,
      payloadKeys: Object.keys(payload).join(', '),
    }, 'Hook: SubagentStop');

    if (childSessionId) {
      const now = Date.now();
      this.db.prepare(`UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL`)
        .run(now, childSessionId);
    }
  }

  /**
   * Handles a Stop hook event.
   * Persists the event and marks the session as ended.
   */
  onStop(payload: HookPayload): void {
    this.persistEvent('Stop', payload);

    const sessionId = payload.session_id;
    if (!sessionId) {
      logger.warn('Stop hook missing session_id');
      return;
    }

    const now = Date.now();
    this.db.prepare(`UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL`).run(now, sessionId);

    broadcast({
      type: 'session:ended',
      id: sessionId,
    });

    logger.info({ sessionId }, 'Session ended via Stop hook');
  }

  /**
   * Looks up the goal_id for a given session, if any.
   * Returns null if the session doesn't exist or has no goal.
   */
  private getGoalIdForSession(sessionId: string | null): string | null {
    if (!sessionId) return null;

    const row = this.db.prepare(`SELECT goal_id FROM sessions WHERE id = ?`).get(sessionId) as
      | { goal_id: string | null }
      | undefined;

    return row?.goal_id ?? null;
  }

  /**
   * Reads the permission_mode for a goal directly from the DB.
   * Stub for B2 — B3 will provide a goalService with this method.
   *
   * @returns 'autonomous' | 'supervised', defaults to 'supervised'
   */
  private getGoalPermissionMode(goalId: string | null): 'autonomous' | 'supervised' {
    if (!goalId) return 'supervised';

    const row = this.db.prepare(`SELECT permission_mode FROM goals WHERE id = ?`).get(goalId) as
      | { permission_mode: string }
      | undefined;

    return (row?.permission_mode as 'autonomous' | 'supervised') ?? 'supervised';
  }

  /**
   * Extracts plan data from a TodoWrite tool_input and updates the linked goal.
   */
  private extractPlanFromTodoWrite(payload: HookPayload): void {
    const sessionId = payload.session_id ?? null;
    const goalId = this.getGoalIdForSession(sessionId);

    if (!goalId) {
      logger.debug({ session_id: sessionId }, 'TodoWrite received but no linked goal — skipping plan update');
      return;
    }

    const toolInput = payload.tool_input;
    if (!toolInput || !Array.isArray(toolInput['todos'])) {
      logger.warn({ session_id: sessionId }, 'TodoWrite tool_input missing or invalid todos array');
      return;
    }

    const rawTodos = toolInput['todos'] as TodoItem[];
    const todos: PlanTodo[] = rawTodos.map(todoItemToPlanTodo);

    const planJson: PlanJson = {
      todos,
      raw_content: JSON.stringify(toolInput['todos']),
    };

    const planJsonStr = JSON.stringify(planJson);
    const now = Date.now();

    this.db
      .prepare(`UPDATE goals SET plan_json = ?, updated_at = ? WHERE id = ?`)
      .run(planJsonStr, now, goalId);

    broadcast({
      type: 'goal:plan-updated',
      id: goalId,
      plan_json: planJson,
    });

    logger.info({ goalId, todoCount: todos.length }, 'Plan updated from TodoWrite');
  }
}
