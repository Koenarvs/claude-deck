import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { makeMigratedDb } from '../helpers/db-fixture';
import { makeTempRepo, cleanupTempRepo } from '../helpers/git-fixture';
import { createProjectService } from '../../../server/services/project-service';
import { createGoalService } from '../../../server/services/goal-service';
import { createWorkspaceService } from '../../../server/services/workspace-service';
import { createGoalsRouter } from '../../../server/routes/goals';
import type Database from 'better-sqlite3';

vi.mock('../../../server/ws', () => ({ broadcast: vi.fn() }));
vi.mock('../../../server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let db: Database.Database;
let server: http.Server;
let port: number;
let repo: string | null = null;
let wtRoot: string | null = null;
let goalId = '';
const url = (p: string) => `http://127.0.0.1:${port}/api${p}`;

beforeEach(async () => {
  db = makeMigratedDb();
  repo = makeTempRepo();
  wtRoot = path.join(path.dirname(repo), `wt-diffroute-${path.basename(repo)}`);
  const projects = createProjectService(db);
  const goals = createGoalService(db, projects);
  const ws = createWorkspaceService(db, projects);
  const project = projects.create({ name: 'R', root_path: repo, worktree_root: wtRoot });
  const goal = goals.create({ title: 'Diff Goal', cwd: repo, projectId: project.id });
  goalId = goal.id;
  const provisioned = ws.provision(goal.id)!;
  fs.writeFileSync(path.join(provisioned.worktree_path, 'README.md'), '# fixture\nedited by agent\n');

  const app = express();
  app.use(express.json());
  app.use('/api', createGoalsRouter(goals, undefined, undefined, undefined, ws));
  server = http.createServer(app);
  port = await new Promise<number>((r) =>
    server.listen(0, () => {
      const a = server.address();
      if (a && typeof a === 'object') r(a.port);
    }),
  );
});
afterEach(() => {
  server.close();
  db.close();
  if (wtRoot) cleanupTempRepo(wtRoot);
  if (repo) cleanupTempRepo(repo);
  repo = null;
  wtRoot = null;
});

describe('GET /api/goals/:id/diff', () => {
  it('returns the workspace diff + dirty flag', async () => {
    const res = await fetch(url(`/goals/${goalId}/diff`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { branch: string; diff: string; dirty: boolean };
    expect(body.diff).toContain('edited by agent');
    expect(body.dirty).toBe(true);
    expect(body.branch).toContain('goal/');
  });

  it('404s for an unknown goal', async () => {
    const res = await fetch(url('/goals/does-not-exist/diff'));
    expect(res.status).toBe(404);
  });
});
