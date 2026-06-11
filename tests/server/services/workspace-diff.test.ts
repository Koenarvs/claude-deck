import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeMigratedDb } from '../helpers/db-fixture';
import { makeTempRepo, cleanupTempRepo } from '../helpers/git-fixture';
import { createProjectService } from '../../../server/services/project-service';
import { createGoalService } from '../../../server/services/goal-service';
import { createWorkspaceService } from '../../../server/services/workspace-service';
import type Database from 'better-sqlite3';

vi.mock('../../../server/ws', () => ({ broadcast: vi.fn() }));
vi.mock('../../../server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let db: Database.Database;
let repo: string | null = null;
let wtRoot: string | null = null;
beforeEach(() => {
  db = makeMigratedDb();
});
afterEach(() => {
  db.close();
  if (wtRoot) cleanupTempRepo(wtRoot);
  if (repo) cleanupTempRepo(repo);
  repo = null;
  wtRoot = null;
});

describe('WorkspaceService diff + summary', () => {
  it('reports a unified diff and dirty=true after a tracked change in the workspace', () => {
    repo = makeTempRepo();
    wtRoot = path.join(path.dirname(repo), `wt-d-${path.basename(repo)}`);
    const projects = createProjectService(db);
    const goals = createGoalService(db, projects);
    const project = projects.create({ name: 'R', root_path: repo, worktree_root: wtRoot });
    const goal = goals.create({ title: 'Edit', cwd: repo, projectId: project.id });
    const ws = createWorkspaceService(db, projects);
    const provisioned = ws.provision(goal.id)!;

    fs.writeFileSync(path.join(provisioned.worktree_path, 'README.md'), '# fixture\nchanged\n');

    const summary = ws.summary(goal.id);
    expect(summary?.branch).toBe(provisioned.branch);
    expect(summary?.dirty).toBe(true);

    const diff = ws.diff(goal.id);
    expect(diff).toContain('README.md');
    expect(diff).toContain('+changed');
  });

  it('returns empty diff and dirty=false for an untouched workspace', () => {
    repo = makeTempRepo();
    wtRoot = path.join(path.dirname(repo), `wt-n-${path.basename(repo)}`);
    const projects = createProjectService(db);
    const goals = createGoalService(db, projects);
    const project = projects.create({ name: 'R', root_path: repo, worktree_root: wtRoot });
    const goal = goals.create({ title: 'NoOp', cwd: repo, projectId: project.id });
    const ws = createWorkspaceService(db, projects);
    ws.provision(goal.id);
    expect(ws.summary(goal.id)?.dirty).toBe(false);
    expect(ws.diff(goal.id)).toBe('');
  });

  it('summary + diff are null/empty for a goal with no workspace', () => {
    const goals = createGoalService(db, createProjectService(db));
    const goal = goals.create({ title: 'NoWs', cwd: 'C:/tmp/none' });
    const ws = createWorkspaceService(db, createProjectService(db));
    expect(ws.summary(goal.id)).toBeNull();
    expect(ws.diff(goal.id)).toBe('');
  });
});
