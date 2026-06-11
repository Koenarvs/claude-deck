import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
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
let extraDirs: string[] = [];
beforeEach(() => {
  db = makeMigratedDb();
});
afterEach(() => {
  db.close();
  if (repo) {
    cleanupTempRepo(repo);
    repo = null;
  }
  for (const d of extraDirs) cleanupTempRepo(d);
  extraDirs = [];
});

describe('WorkspaceService', () => {
  it('provisions a worktree on a new branch under worktree_root', () => {
    repo = makeTempRepo();
    const wtRoot = path.join(path.dirname(repo), `wt-${path.basename(repo)}`);
    extraDirs.push(wtRoot);
    const projects = createProjectService(db);
    const goals = createGoalService(db, projects);
    const project = projects.create({ name: 'R', root_path: repo, worktree_root: wtRoot });
    const goal = goals.create({ title: 'Feature X', cwd: repo, projectId: project.id });

    const ws = createWorkspaceService(db, projects);
    const provisioned = ws.provision(goal.id);

    expect(provisioned).not.toBeNull();
    expect(provisioned!.mode).toBe('worktree');
    expect(fs.existsSync(provisioned!.worktree_path)).toBe(true);
    // Branch exists in the repo.
    const branches = execFileSync('git', ['branch', '--list', provisioned!.branch], {
      cwd: repo,
      encoding: 'utf-8',
    });
    expect(branches).toContain(provisioned!.branch);
  });

  it('is idempotent: provisioning twice returns the same workspace', () => {
    repo = makeTempRepo();
    extraDirs.push(path.join(path.dirname(repo), `.${path.basename(repo)}-worktrees`));
    const projects = createProjectService(db);
    const goals = createGoalService(db, projects);
    const project = projects.create({ name: 'R', root_path: repo });
    const goal = goals.create({ title: 'Y', cwd: repo, projectId: project.id });
    const ws = createWorkspaceService(db, projects);
    const a = ws.provision(goal.id);
    const b = ws.provision(goal.id);
    expect(a).not.toBeNull();
    expect(b!.worktree_path).toBe(a!.worktree_path);
  });

  it('returns null for a goal whose cwd is not in a registered project', () => {
    const goals = createGoalService(db, createProjectService(db));
    const goal = goals.create({ title: 'Z', cwd: 'C:/tmp/nope-unregistered' });
    const ws = createWorkspaceService(db, createProjectService(db));
    expect(ws.provision(goal.id)).toBeNull();
  });
});
