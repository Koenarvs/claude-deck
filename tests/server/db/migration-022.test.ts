import { describe, it, expect, afterEach } from 'vitest';
import { makeMigratedDb } from '../helpers/db-fixture';
import type Database from 'better-sqlite3';

let db: Database.Database;
afterEach(() => db?.close());

describe('migration 022 — goal_workspace + resume columns', () => {
  it('creates goal_workspace with expected columns', () => {
    db = makeMigratedDb();
    const cols = (db.pragma('table_info(goal_workspace)') as Array<{ name: string }>).map(
      (c) => c.name,
    );
    for (const c of ['goal_id', 'branch', 'worktree_path', 'base_ref', 'mode', 'created_at']) {
      expect(cols).toContain(c);
    }
  });

  it('adds provider_session_id + workspace_path to sessions', () => {
    db = makeMigratedDb();
    const cols = (db.pragma('table_info(sessions)') as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('provider_session_id');
    expect(cols).toContain('workspace_path');
  });

  it('enforces the mode check constraint', () => {
    db = makeMigratedDb();
    // Satisfy the goal_id foreign key first so only the CHECK can fail.
    const insGoal = db.prepare(
      `INSERT INTO goals (id, title, cwd, status, priority, permission_mode, kanban_order, created_at, updated_at)
       VALUES (?, ?, '/tmp', 'planning', 0, 'supervised', 0, 0, 0)`,
    );
    insGoal.run('g1', 'G1');
    insGoal.run('g2', 'G2');
    const ins = db.prepare(
      `INSERT INTO goal_workspace (goal_id, branch, worktree_path, base_ref, mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    expect(() => ins.run('g1', 'goal/x', '/wt', 'main', 'bogus', 0)).toThrow();
    expect(() => ins.run('g2', 'goal/y', '/wt', 'main', 'worktree', 0)).not.toThrow();
  });
});
