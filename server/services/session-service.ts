import type Database from 'better-sqlite3';
import type { Session, SessionOrigin } from '../../src/shared/types';
import type { ServerEvent } from '../../src/shared/events';
import logger from '../logger';

/** Input for creating a new session. */
export interface CreateSessionInput {
  id: string;
  origin: SessionOrigin;
  started_at: number;
  goal_id?: string | null | undefined;
  cwd?: string | null | undefined;
  model?: string | null | undefined;
}

/** Filters for listing sessions. */
export interface ListSessionsFilter {
  origin?: SessionOrigin | undefined;
  active?: boolean | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

/** Counters to atomically increment on a session row. */
export interface IncrementCountersInput {
  stream?: number | undefined;
  hook?: number | undefined;
  stderr_bytes?: number | undefined;
}

/** End-of-session metadata (reserved for future per-session fields). */
export type EndSessionInput = Record<string, never>;

/**
 * Service for managing session lifecycle.
 *
 * Sessions represent individual `claude` CLI invocations, either spawned
 * by the dashboard (origin=dashboard) or observed externally via hooks
 * (origin=external). External sessions have goal_id=NULL unless adopted.
 *
 * Session creation uses INSERT OR IGNORE for idempotency — two rapid
 * hook POSTs for the same session_id result in exactly one row.
 */
export class SessionService {
  private readonly upsertStmt: Database.Statement;
  private readonly getStmt: Database.Statement;
  private readonly endStmt: Database.Statement;
  private readonly updateTraceDirStmt: Database.Statement;
  private readonly linkGoalStmt: Database.Statement;

  constructor(
    private readonly db: Database.Database,
    private readonly broadcastFn: (event: ServerEvent) => void,
  ) {
    // INSERT OR IGNORE ensures idempotency for duplicate session-start hooks
    this.upsertStmt = db.prepare(`
      INSERT OR IGNORE INTO sessions (id, goal_id, origin, cwd, model, trace_dir, stream_event_count, hook_event_count, stderr_bytes, started_at, ended_at)
      VALUES (@id, @goal_id, @origin, @cwd, @model, NULL, 0, 0, 0, @started_at, NULL)
    `);

    this.getStmt = db.prepare('SELECT * FROM sessions WHERE id = ?');

    this.endStmt = db.prepare(`
      UPDATE sessions
      SET ended_at = @ended_at
      WHERE id = @id
    `);

    this.updateTraceDirStmt = db.prepare('UPDATE sessions SET trace_dir = ? WHERE id = ?');

    this.linkGoalStmt = db.prepare('UPDATE sessions SET goal_id = ? WHERE id = ?');
  }

  /**
   * Creates a session row. Uses INSERT OR IGNORE for idempotency.
   * If the row already exists (same session_id), the insert is silently ignored.
   * Broadcasts `session:observed` for external sessions.
   *
   * @returns The session (either newly created or existing).
   */
  create(input: CreateSessionInput): Session {
    const row = {
      id: input.id,
      goal_id: input.goal_id ?? null,
      origin: input.origin,
      cwd: input.cwd ?? null,
      model: input.model ?? null,
      started_at: input.started_at,
    };

    const result = this.upsertStmt.run(row);

    const session = this.getStmt.get(input.id) as Session;

    // Only broadcast if a new row was actually inserted
    if (result.changes > 0) {
      logger.info({ sessionId: session.id, origin: session.origin }, 'Session created');

      if (session.origin === 'external') {
        this.broadcastFn({
          type: 'session:observed',
          session,
        });
      }
    } else {
      logger.debug({ sessionId: input.id }, 'Session already exists, ignoring duplicate create');
    }

    return session;
  }

  /**
   * Retrieves a session by ID.
   *
   * @returns The session, or null if not found.
   */
  get(id: string): Session | null {
    const row = this.getStmt.get(id) as Session | undefined;
    return row ?? null;
  }

  /**
   * Lists sessions with optional filtering by origin and active status.
   * Active sessions are those with ended_at IS NULL.
   * Ordered by started_at DESC (most recent first).
   */
  list(filters?: ListSessionsFilter): Session[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filters?.origin != null) {
      conditions.push('origin = ?');
      params.push(filters.origin);
    }

    if (filters?.active === true) {
      conditions.push('ended_at IS NULL');
    } else if (filters?.active === false) {
      conditions.push('ended_at IS NOT NULL');
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters?.limit ?? 100;
    const offset = filters?.offset ?? 0;

    const sql = `SELECT * FROM sessions ${whereClause} ORDER BY started_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as Session[];
  }

  /**
   * Marks a session as ended. Sets ended_at and optionally updates
   * cost/token metadata. Broadcasts `session:ended`.
   */
  end(id: string, _input?: EndSessionInput): void {
    const now = Date.now();
    this.endStmt.run({
      id,
      ended_at: now,
    });

    logger.info({ sessionId: id }, 'Session ended');

    this.broadcastFn({
      type: 'session:ended',
      id,
    });
  }

  /**
   * Updates the trace directory path for a session.
   */
  updateTraceDir(id: string, tracePath: string): void {
    this.updateTraceDirStmt.run(tracePath, id);
    logger.debug({ sessionId: id, traceDir: tracePath }, 'Session trace_dir updated');
  }

  /**
   * Atomically increments session event counters using SQL `SET x = x + ?`.
   * Any counter field not provided is left unchanged.
   */
  incrementCounters(id: string, counters: IncrementCountersInput): void {
    const sets: string[] = [];
    const params: (string | number)[] = [];

    if (counters.stream != null && counters.stream > 0) {
      sets.push('stream_event_count = stream_event_count + ?');
      params.push(counters.stream);
    }
    if (counters.hook != null && counters.hook > 0) {
      sets.push('hook_event_count = hook_event_count + ?');
      params.push(counters.hook);
    }
    if (counters.stderr_bytes != null && counters.stderr_bytes > 0) {
      sets.push('stderr_bytes = stderr_bytes + ?');
      params.push(counters.stderr_bytes);
    }

    if (sets.length === 0) return;

    const sql = `UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`;
    params.push(id);

    this.db.prepare(sql).run(...params);
    logger.debug({ sessionId: id, counters }, 'Session counters incremented');
  }

  /**
   * Associates a session with a goal by updating its goal_id.
   * Used by the adopt-session endpoint to link external sessions to goals.
   */
  linkGoal(id: string, goalId: string): void {
    this.linkGoalStmt.run(goalId, id);
    logger.info({ sessionId: id, goalId }, 'Session linked to goal');
  }
}
