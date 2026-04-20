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

    // Create new external session
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO sessions (id, goal_id, origin, cwd, model, trace_dir, stream_event_count, hook_event_count, stderr_bytes, total_cost_usd, total_tokens_in, total_tokens_out, started_at, ended_at)
         VALUES (?, NULL, 'external', ?, ?, NULL, 0, 1, 0, NULL, NULL, NULL, ?, NULL)`,
      )
      .run(sessionId, payload.cwd ?? null, payload.model ?? null, now);

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
          total_cost_usd: (s['total_cost_usd'] as number) ?? null,
          total_tokens_in: (s['total_tokens_in'] as number) ?? null,
          total_tokens_out: (s['total_tokens_out'] as number) ?? null,
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
    const isAutonomous = this.getGoalPermissionMode(goalId) === 'autonomous';

    return this.approvalCoordinator.request(
      {
        session_id: sessionId,
        goal_id: goalId,
        tool_name: toolName,
        tool_args: JSON.stringify(payload.tool_input ?? {}),
      },
      isAutonomous,
    );
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
