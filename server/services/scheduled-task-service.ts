import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import type {
  ScheduledTask,
  CreateScheduledTaskInput,
  UpdateScheduledTaskInput,
  GoalTemplate,
} from '../../src/shared/types';

/**
 * Row shape as stored in SQLite. `enabled` is 0|1 and
 * `goal_template_json` is a serialized JSON string.
 */
interface ScheduledTaskRow {
  id: string;
  name: string;
  cron_expr: string;
  goal_template_json: string;
  enabled: number;
  last_run_at: number | null;
  next_run_at: number | null;
  created_at: number;
}

/** Converts a SQLite row to the application-level ScheduledTask type. */
function rowToTask(row: ScheduledTaskRow): ScheduledTask {
  return {
    id: row.id,
    name: row.name,
    cron_expr: row.cron_expr,
    goal_template_json: row.goal_template_json,
    enabled: row.enabled === 1,
    last_run_at: row.last_run_at,
    next_run_at: row.next_run_at,
    created_at: row.created_at,
  };
}

/**
 * CRUD service for scheduled tasks.
 *
 * All methods operate against the `scheduled_tasks` table in SQLite.
 * Goal template JSON is serialized on write and stored as a TEXT column.
 */
export class ScheduledTaskService {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** Creates a new scheduled task and returns the full row. */
  create(input: CreateScheduledTaskInput): ScheduledTask {
    const id = uuid();
    const now = Date.now();
    const templateJson = JSON.stringify(input.goal_template_json);
    const enabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : 1;

    this.db
      .prepare(
        `INSERT INTO scheduled_tasks (id, name, cron_expr, goal_template_json, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.name, input.cron_expr, templateJson, enabled, now);

    return this.get(id)!;
  }

  /** Returns a scheduled task by ID, or null if not found. */
  get(id: string): ScheduledTask | null {
    const row = this.db
      .prepare('SELECT * FROM scheduled_tasks WHERE id = ?')
      .get(id) as ScheduledTaskRow | undefined;

    return row ? rowToTask(row) : null;
  }

  /** Returns all scheduled tasks, ordered by creation time descending. */
  list(): ScheduledTask[] {
    const rows = this.db
      .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
      .all() as ScheduledTaskRow[];

    return rows.map(rowToTask);
  }

  /**
   * Updates a scheduled task. Only provided fields are modified.
   * Returns the updated task, or null if the task was not found.
   */
  update(id: string, input: UpdateScheduledTaskInput): ScheduledTask | null {
    const existing = this.get(id);
    if (!existing) return null;

    const sets: string[] = [];
    const values: (string | number)[] = [];

    if (input.name !== undefined) {
      sets.push('name = ?');
      values.push(input.name);
    }
    if (input.cron_expr !== undefined) {
      sets.push('cron_expr = ?');
      values.push(input.cron_expr);
    }
    if (input.goal_template_json !== undefined) {
      sets.push('goal_template_json = ?');
      values.push(JSON.stringify(input.goal_template_json));
    }
    if (input.enabled !== undefined) {
      sets.push('enabled = ?');
      values.push(input.enabled ? 1 : 0);
    }

    if (sets.length === 0) {
      return existing;
    }

    values.push(id);
    this.db.prepare(`UPDATE scheduled_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);

    return this.get(id)!;
  }

  /** Deletes a scheduled task. Returns true if the row existed and was removed. */
  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
    return result.changes > 0;
  }

  /** Updates `last_run_at` and optionally `next_run_at` after a cron fire. */
  recordRun(id: string, lastRunAt: number, nextRunAt: number | null): void {
    this.db
      .prepare('UPDATE scheduled_tasks SET last_run_at = ?, next_run_at = ? WHERE id = ?')
      .run(lastRunAt, nextRunAt, id);
  }

  /**
   * Parses the stored goal_template_json string into a GoalTemplate object.
   * Throws if the JSON is malformed (should not happen if created through the service).
   */
  parseTemplate(task: ScheduledTask): GoalTemplate {
    return JSON.parse(task.goal_template_json) as GoalTemplate;
  }
}
