import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type {
  Goal,
  GoalStatus,
  GoalDetail,
  CreateGoalInput,
  UpdateGoalInput,
  PlanJson,
  Message,
} from '../../src/shared/types';
import { canTransition } from '../state-machine/goal-status';
import { broadcast } from '../ws';
import logger from '../logger';

// ── Row ↔ Domain Conversion ──────────────────────────────────────────────────

interface GoalRow {
  id: string;
  title: string;
  description: string | null;
  cwd: string;
  status: string;
  priority: number;
  tags: string | null;
  current_session_id: string | null;
  model: string | null;
  permission_mode: string;
  plan_json: string | null;
  initial_prompt: string | null;
  kanban_order: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: string | null;
  content: string | null;
  tool_name: string | null;
  tool_args: string | null;
  tool_result: string | null;
  tool_use_id: string | null;
  created_at: number;
}

/**
 * Converts a raw SQLite row into a typed Goal domain object.
 * Parses JSON columns (tags, plan_json) from their string representations.
 */
function rowToGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    cwd: row.cwd,
    status: row.status as GoalStatus,
    priority: row.priority,
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : [],
    current_session_id: row.current_session_id,
    model: row.model as Goal['model'],
    permission_mode: row.permission_mode as Goal['permission_mode'],
    plan_json: row.plan_json ? (JSON.parse(row.plan_json) as PlanJson) : null,
    initial_prompt: row.initial_prompt,
    kanban_order: row.kanban_order,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
  };
}

/**
 * Converts a raw SQLite message row into a typed Message domain object.
 */
function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    session_id: row.session_id,
    role: row.role as Message['role'],
    content: row.content,
    tool_name: row.tool_name,
    tool_args: row.tool_args,
    tool_result: row.tool_result,
    tool_use_id: row.tool_use_id,
    created_at: row.created_at,
  };
}

// ── Filter Types ─────────────────────────────────────────────────────────────

export interface GoalListFilters {
  status?: GoalStatus | undefined;
  tag?: string | undefined;
}

// ── Service ──────────────────────────────────────────────────────────────────

/**
 * Creates a GoalService bound to the given database instance.
 * All mutations broadcast WS events to subscribed clients.
 *
 * @param db - better-sqlite3 database instance (production or :memory: for tests)
 */
export function createGoalService(db: Database.Database) {
  // ── Prepared Statements ──────────────────────────────────────────────────

  const insertStmt = db.prepare<
    [string, string, string | null, string, string, number, string | null, string | null, string, string | null, string | null, number, number, number, number | null]
  >(`INSERT INTO goals (id, title, description, cwd, status, priority, tags, current_session_id, permission_mode, model, initial_prompt, kanban_order, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const getByIdStmt = db.prepare<[string], GoalRow>(
    'SELECT * FROM goals WHERE id = ?',
  );

  const maxKanbanStmt = db.prepare<[string], { max_order: number | null }>(
    'SELECT MAX(kanban_order) as max_order FROM goals WHERE status = ?',
  );

  const updateSessionStmt = db.prepare<[string | null, number, string]>(
    'UPDATE goals SET current_session_id = ?, updated_at = ? WHERE id = ?',
  );

  const updatePlanStmt = db.prepare<[string | null, number, string]>(
    'UPDATE goals SET plan_json = ?, updated_at = ? WHERE id = ?',
  );

  const archiveStmt = db.prepare<[number, number, string]>(
    "UPDATE goals SET status = 'archived', updated_at = ?, completed_at = ? WHERE id = ?",
  );

  const adoptSessionStmt = db.prepare<[string, string]>(
    'UPDATE sessions SET goal_id = ? WHERE id = ?',
  );

  const findByTitleStmt = db.prepare<[string], GoalRow>(
    "SELECT * FROM goals WHERE title = ? COLLATE NOCASE AND status != 'archived' LIMIT 1",
  );

  // ── Public API ───────────────────────────────────────────────────────────

  function findByTitle(title: string): Goal | null {
    const row = findByTitleStmt.get(title);
    return row ? rowToGoal(row) : null;
  }

  function resolveUniqueTitle(baseTitle: string, selfId: string): string {
    const first = `${baseTitle} (restored)`;
    if (!findByTitle(first) || findByTitle(first)!.id === selfId) return first;
    for (let i = 2; i <= 100; i++) {
      const candidate = `${baseTitle} (restored ${i})`;
      const hit = findByTitle(candidate);
      if (!hit || hit.id === selfId) return candidate;
    }
    return `${baseTitle} (restored 101)`;
  }

  /**
   * Creates a new goal with the given input. Assigns a UUID, sets initial
   * status to 'planning', and computes kanban_order as max(kanban_order)+1
   * for the 'planning' column.
   *
   * Broadcasts a `goal:created` WS event.
   *
   * @param input - Validated CreateGoalInput
   * @returns The newly created Goal
   */
  function create(input: CreateGoalInput): Goal {
    const existing = findByTitle(input.title);
    if (existing) {
      throw new DuplicateGoalTitleError(existing.id, existing.title);
    }

    const id = uuidv4();
    const now = Date.now();

    // Compute kanban_order: max existing in 'planning' + 1
    const maxRow = maxKanbanStmt.get('planning');
    const kanbanOrder = (maxRow?.max_order ?? 0) + 1;

    const tagsJson = input.tags ? JSON.stringify(input.tags) : null;

    insertStmt.run(
      id,
      input.title,
      input.description ?? null,
      input.cwd,
      'planning',
      0,
      tagsJson,
      null,
      input.permission_mode ?? 'supervised',
      input.model ?? null,
      input.initialPrompt ?? null,
      kanbanOrder,
      now,
      now,
      null,
    );

    const goal = get(id);
    if (!goal) {
      throw new Error(`Failed to create goal: row not found after insert (id=${id})`);
    }

    broadcast({ type: 'goal:created', goal });
    logger.info({ goalId: id, title: input.title }, 'Goal created');

    return goal;
  }

  /**
   * Retrieves a single goal by ID.
   *
   * @param id - Goal UUID
   * @returns The Goal, or null if not found
   */
  function get(id: string): Goal | null {
    const row = getByIdStmt.get(id);
    return row ? rowToGoal(row) : null;
  }

  /**
   * Retrieves a goal with its messages and plan (GoalDetail composite).
   * Messages are fetched from all sessions linked to this goal, ordered by created_at.
   *
   * @param id - Goal UUID
   * @returns GoalDetail, or null if the goal does not exist
   */
  function getDetail(id: string): GoalDetail | null {
    const goal = get(id);
    if (!goal) return null;

    const messageRows = db
      .prepare<[string], MessageRow>(
        `SELECT m.* FROM messages m
         JOIN sessions s ON m.session_id = s.id
         WHERE s.goal_id = ?
         ORDER BY m.created_at ASC`,
      )
      .all(id);

    const messages: Message[] = messageRows.map(rowToMessage);

    const igmRows = db
      .prepare<[string]>(
        `SELECT * FROM inter_goal_messages
         WHERE to_goal_id = ?
         ORDER BY created_at ASC`,
      )
      .all(id) as Array<{
        id: string; from_goal_id: string; to_goal_id: string;
        content: string; message_type: string; status: string;
        created_at: number; delivered_at: number | null; acknowledged_at: number | null;
      }>;

    const interGoalMessages: import('../../src/shared/types').InterGoalMessage[] = igmRows.map(r => ({
      id: r.id,
      from_goal_id: r.from_goal_id,
      to_goal_id: r.to_goal_id,
      content: r.content,
      message_type: r.message_type as import('../../src/shared/types').InterGoalMessageType,
      status: r.status as import('../../src/shared/types').InterGoalMessageStatus,
      created_at: r.created_at,
      delivered_at: r.delivered_at,
      acknowledged_at: r.acknowledged_at,
    }));

    return {
      goal,
      messages,
      interGoalMessages,
      plan: goal.plan_json,
    };
  }

  /**
   * Lists goals with optional status and tag filters.
   * Results are ordered by status group (planning, active, waiting first)
   * then by kanban_order within each status.
   *
   * @param filters - Optional status and tag filters
   * @returns Array of matching Goals
   */
  function list(filters?: GoalListFilters): Goal[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filters?.status) {
      conditions.push('status = ?');
      params.push(filters.status);
    }

    if (filters?.tag) {
      // SQLite JSON: check if the tags array contains the value
      conditions.push("EXISTS (SELECT 1 FROM json_each(tags) WHERE json_each.value = ?)");
      params.push(filters.tag);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT * FROM goals ${where} ORDER BY status, kanban_order ASC`;

    const rows = db.prepare(sql).all(...params) as GoalRow[];
    return rows.map(rowToGoal);
  }

  /**
   * Updates a goal with partial input. Validates status transitions via
   * the state machine. Sets completed_at when transitioning to 'complete'.
   *
   * Broadcasts `goal:updated` for general updates and additionally
   * `goal:status` when the status changes.
   *
   * @param id - Goal UUID
   * @param patch - Partial update fields
   * @returns The updated Goal
   * @throws Error if goal not found or status transition is invalid
   */
  function update(id: string, patch: UpdateGoalInput): Goal {
    const existing = get(id);
    if (!existing) {
      throw new GoalNotFoundError(id);
    }

    // Validate status transition if status is changing
    if (patch.status !== undefined && patch.status !== existing.status) {
      if (!canTransition(existing.status, patch.status)) {
        throw new InvalidTransitionError(existing.status, patch.status);
      }

      // When un-archiving, auto-suffix the title if it collides with a non-archived goal
      if (existing.status === 'archived' && patch.status !== 'archived') {
        const effectiveTitle = patch.title ?? existing.title;
        const duplicate = findByTitle(effectiveTitle);
        if (duplicate && duplicate.id !== id) {
          patch = { ...patch, title: resolveUniqueTitle(effectiveTitle, id) };
        }
      }
    }

    const now = Date.now();
    const setClauses: string[] = ['updated_at = ?'];
    const params: (string | number | null)[] = [now];

    if (patch.title !== undefined) {
      setClauses.push('title = ?');
      params.push(patch.title);
    }

    if (patch.description !== undefined) {
      setClauses.push('description = ?');
      params.push(patch.description);
    }

    if (patch.status !== undefined) {
      setClauses.push('status = ?');
      params.push(patch.status);

      if (patch.status === 'complete') {
        setClauses.push('completed_at = ?');
        params.push(now);
      }
    }

    if (patch.priority !== undefined) {
      setClauses.push('priority = ?');
      params.push(patch.priority);
    }

    if (patch.tags !== undefined) {
      setClauses.push('tags = ?');
      params.push(JSON.stringify(patch.tags));
    }

    if (patch.model !== undefined) {
      setClauses.push('model = ?');
      params.push(patch.model);
    }

    if (patch.permission_mode !== undefined) {
      setClauses.push('permission_mode = ?');
      params.push(patch.permission_mode);
    }

    if (patch.kanban_order !== undefined) {
      setClauses.push('kanban_order = ?');
      params.push(patch.kanban_order);
    }

    params.push(id);
    const sql = `UPDATE goals SET ${setClauses.join(', ')} WHERE id = ?`;
    db.prepare(sql).run(...params);

    const updated = get(id);
    if (!updated) {
      throw new Error(`Goal disappeared after update (id=${id})`);
    }

    broadcast({ type: 'goal:updated', goal: updated });

    // Additional status event when status changed
    if (patch.status !== undefined && patch.status !== existing.status) {
      broadcast({
        type: 'goal:status',
        id: updated.id,
        status: updated.status,
        current_session_id: updated.current_session_id,
      });
      logger.info({ goalId: id, from: existing.status, to: patch.status }, 'Goal status changed');
    }

    return updated;
  }

  /**
   * Archives a goal (soft-delete). Sets status to 'archived' and
   * completed_at to the current timestamp.
   *
   * Broadcasts `goal:updated` and `goal:status` WS events.
   *
   * @param id - Goal UUID
   * @throws GoalNotFoundError if the goal does not exist
   * @throws InvalidTransitionError if the goal is already archived
   */
  function archive(id: string): void {
    const existing = get(id);
    if (!existing) {
      throw new GoalNotFoundError(id);
    }

    if (!canTransition(existing.status, 'archived')) {
      throw new InvalidTransitionError(existing.status, 'archived');
    }

    const now = Date.now();
    archiveStmt.run(now, now, id);

    // End all open sessions — goal is off the board now
    const endedSessions = db.prepare(
      `UPDATE sessions SET ended_at = ? WHERE goal_id = ? AND ended_at IS NULL`,
    ).run(now, id);
    if (endedSessions.changes > 0) {
      logger.info({ goalId: id, count: endedSessions.changes }, 'Ended open sessions for archived goal');
    }

    const updated = get(id);
    if (!updated) {
      throw new Error(`Goal disappeared after archive (id=${id})`);
    }

    broadcast({ type: 'goal:updated', goal: updated });
    broadcast({
      type: 'goal:status',
      id: updated.id,
      status: updated.status,
      current_session_id: updated.current_session_id,
    });
    logger.info({ goalId: id }, 'Goal archived');
  }

  /**
   * Sets the current_session_id on a goal. Used when a session starts
   * or ends for the goal.
   *
   * Broadcasts `goal:status` WS event.
   *
   * @param id - Goal UUID
   * @param sessionId - Session ID or null to clear
   * @throws GoalNotFoundError if the goal does not exist
   */
  function setCurrentSession(id: string, sessionId: string | null): void {
    const existing = get(id);
    if (!existing) {
      throw new GoalNotFoundError(id);
    }

    const now = Date.now();
    updateSessionStmt.run(sessionId, now, id);

    broadcast({
      type: 'goal:status',
      id,
      status: existing.status,
      current_session_id: sessionId,
    });
  }

  /**
   * Updates the plan_json column for a goal. Called by the TodoWrite hook
   * handler when a session produces a plan update.
   *
   * Broadcasts `goal:plan-updated` WS event with the full plan.
   *
   * @param id - Goal UUID
   * @param plan - The PlanJson to store
   * @throws GoalNotFoundError if the goal does not exist
   */
  function setPlan(id: string, plan: PlanJson): void {
    const existing = get(id);
    if (!existing) {
      throw new GoalNotFoundError(id);
    }

    const now = Date.now();
    updatePlanStmt.run(JSON.stringify(plan), now, id);

    broadcast({
      type: 'goal:plan-updated',
      id,
      plan_json: plan,
    });
    logger.info({ goalId: id }, 'Goal plan updated');
  }

  /**
   * Links an external session to a goal by updating the session's goal_id.
   * Returns the updated goal.
   *
   * Broadcasts `goal:updated` WS event.
   *
   * @param goalId - Goal UUID
   * @param sessionId - Session UUID to adopt
   * @returns The goal after adoption
   * @throws GoalNotFoundError if the goal does not exist
   */
  function adoptSession(goalId: string, sessionId: string): Goal {
    const existing = get(goalId);
    if (!existing) {
      throw new GoalNotFoundError(goalId);
    }

    adoptSessionStmt.run(goalId, sessionId);

    const now = Date.now();
    updateSessionStmt.run(sessionId, now, goalId);

    const updated = get(goalId);
    if (!updated) {
      throw new Error(`Goal disappeared after adopt (id=${goalId})`);
    }

    broadcast({ type: 'goal:updated', goal: updated });
    logger.info({ goalId, sessionId }, 'Session adopted into goal');

    return updated;
  }

  return {
    create,
    get,
    getDetail,
    list,
    update,
    archive,
    setCurrentSession,
    setPlan,
    adoptSession,
  };
}

// ── Error Types ──────────────────────────────────────────────────────────────

/**
 * Error thrown when a goal is not found by ID.
 */
export class GoalNotFoundError extends Error {
  public readonly goalId: string;

  constructor(goalId: string) {
    super(`Goal not found: ${goalId}`);
    this.name = 'GoalNotFoundError';
    this.goalId = goalId;
  }
}

/**
 * Error thrown when an invalid status transition is attempted.
 */
export class InvalidTransitionError extends Error {
  public readonly from: GoalStatus;
  public readonly to: GoalStatus;

  constructor(from: GoalStatus, to: GoalStatus) {
    super(`Invalid status transition: ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

/**
 * Error thrown when creating or renaming a goal to a title that already
 * exists among non-archived goals (case-insensitive).
 */
export class DuplicateGoalTitleError extends Error {
  public readonly existingGoalId: string;
  public readonly existingTitle: string;

  constructor(existingGoalId: string, existingTitle: string) {
    super(`A goal with title "${existingTitle}" already exists`);
    this.name = 'DuplicateGoalTitleError';
    this.existingGoalId = existingGoalId;
    this.existingTitle = existingTitle;
  }
}

export type GoalService = ReturnType<typeof createGoalService>;
