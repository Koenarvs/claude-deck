import { describe, it, expect } from 'vitest';
import http from 'node:http';
import express from 'express';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';
import { createGoalService } from '../../../server/services/goal-service';
import { createGoalsRouter } from '../../../server/routes/goals';
import { createCwdValidator } from '../../../server/security/path-allow';

function appWith(allowedRoots: string[]): { server: http.Server; portP: Promise<number> } {
  const db = new Database(':memory:');
  runMigrations(db);
  const goalService = createGoalService(db);
  const validateCwd = createCwdValidator({ allowedRoots });
  const router = createGoalsRouter(goalService, undefined, undefined, { validateCwd });
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const server = http.createServer(app);
  const portP = new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const a = server.address();
      resolve(typeof a === 'object' && a ? a.port : 0);
    }),
  );
  return { server, portP };
}

describe('POST /goals cwd containment', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'goals-root-')));
  const inside = fs.mkdtempSync(path.join(root, 'g-'));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'goals-out-')));

  it('201s a goal whose cwd is inside an allowed root', async () => {
    const { server, portP } = appWith([root]);
    const port = await portP;
    const res = await fetch(`http://127.0.0.1:${port}/api/goals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'ok-goal', cwd: inside }),
    });
    expect(res.status).toBe(201);
    server.close();
  });

  it('400s a goal whose cwd is outside all allowed roots', async () => {
    const { server, portP } = appWith([root]);
    const port = await portP;
    const res = await fetch(`http://127.0.0.1:${port}/api/goals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'bad-goal', cwd: outside }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/allowed/i);
    server.close();
  });

  it('400s a relative cwd', async () => {
    const { server, portP } = appWith([root]);
    const port = await portP;
    const res = await fetch(`http://127.0.0.1:${port}/api/goals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'rel-goal', cwd: 'relative/path' }),
    });
    expect(res.status).toBe(400);
    server.close();
  });
});
