import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeMigratedDb } from '../helpers/db-fixture';
import { createGoalService } from '../../../server/services/goal-service';
import { createProjectService } from '../../../server/services/project-service';
import type Database from 'better-sqlite3';

vi.mock('../../../server/ws', () => ({ broadcast: vi.fn() }));
vi.mock('../../../server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let db: Database.Database;
beforeEach(() => {
  db = makeMigratedDb();
});
afterEach(() => db.close());

describe('goal ↔ project linking (5A)', () => {
  it('stores project_id and inherits default permission mode from the project', () => {
    const projects = createProjectService(db);
    const goals = createGoalService(db, projects);
    const p = projects.create({
      name: 'Deck',
      root_path: 'C:/github/claude-deck',
      default_permission_mode: 'autonomous',
    });
    const g = goals.create({
      title: 'Task A',
      cwd: 'C:/github/claude-deck/server',
      projectId: p.id,
    });
    const row = db.prepare('SELECT project_id, permission_mode FROM goals WHERE id = ?').get(g.id) as {
      project_id: string;
      permission_mode: string;
    };
    expect(row.project_id).toBe(p.id);
    expect(row.permission_mode).toBe('autonomous');
  });

  it('auto-links project by cwd when projectId is omitted', () => {
    const projects = createProjectService(db);
    const goals = createGoalService(db, projects);
    const p = projects.create({ name: 'Deck', root_path: 'C:/github/claude-deck' });
    const g = goals.create({ title: 'Task B', cwd: 'C:/github/claude-deck/src' });
    const row = db.prepare('SELECT project_id FROM goals WHERE id = ?').get(g.id) as {
      project_id: string | null;
    };
    expect(row.project_id).toBe(p.id);
  });

  it('explicit permission_mode wins over the project default', () => {
    const projects = createProjectService(db);
    const goals = createGoalService(db, projects);
    const p = projects.create({
      name: 'Deck',
      root_path: 'C:/github/claude-deck',
      default_permission_mode: 'autonomous',
    });
    const g = goals.create({
      title: 'Task C',
      cwd: 'C:/github/claude-deck',
      projectId: p.id,
      permission_mode: 'supervised',
    });
    const row = db.prepare('SELECT permission_mode FROM goals WHERE id = ?').get(g.id) as {
      permission_mode: string;
    };
    expect(row.permission_mode).toBe('supervised');
  });

  it('leaves project_id null for an unregistered cwd', () => {
    const goals = createGoalService(db, createProjectService(db));
    const g = goals.create({ title: 'Ad hoc', cwd: 'C:/tmp/scratch' });
    const row = db.prepare('SELECT project_id FROM goals WHERE id = ?').get(g.id) as {
      project_id: string | null;
    };
    expect(row.project_id).toBeNull();
  });

  it('still works without a projectService (back-compat)', () => {
    const goals = createGoalService(db);
    const g = goals.create({ title: 'No svc', cwd: 'C:/x' });
    expect(g.project_id ?? null).toBeNull();
  });

  it('list() surfaces the isolated workspace branch (5B) via the join', () => {
    const goals = createGoalService(db, createProjectService(db));
    const g = goals.create({ title: 'WS', cwd: 'C:/x' });
    db.prepare(
      `INSERT INTO goal_workspace (goal_id, branch, worktree_path, base_ref, mode, created_at)
       VALUES (?, 'goal/abc-feature', '/wt', 'main', 'worktree', 0)`,
    ).run(g.id);
    const listed = goals.list().find((x) => x.id === g.id);
    expect(listed?.workspace_branch).toBe('goal/abc-feature');
    // Goals without a workspace report null.
    const g2 = goals.create({ title: 'NoWS', cwd: 'C:/y' });
    expect(goals.list().find((x) => x.id === g2.id)?.workspace_branch ?? null).toBeNull();
  });
});
