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
import { createModelValidator } from '../../../server/security/model-allow';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gm-root-')));
const cwd = fs.mkdtempSync(path.join(root, 'g-'));

function app(): Promise<number> {
  const db = new Database(':memory:');
  runMigrations(db);
  const router = createGoalsRouter(createGoalService(db), undefined, undefined, {
    validateCwd: createCwdValidator({ allowedRoots: [root] }),
    validateModel: createModelValidator(),
  });
  const a = express();
  a.use(express.json());
  a.use('/api', router);
  const srv = http.createServer(a);
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => {
    const ad = srv.address();
    resolve(typeof ad === 'object' && ad ? ad.port : 0);
  }));
}

describe('POST /goals model containment', () => {
  it('400s an unknown model', async () => {
    const port = await app();
    const res = await fetch(`http://127.0.0.1:${port}/api/goals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'm1', cwd, model: 'evil; rm -rf /' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/model/i);
  });

  it('201s a known model', async () => {
    const port = await app();
    const res = await fetch(`http://127.0.0.1:${port}/api/goals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'm2', cwd, model: 'claude-opus-4-8' }),
    });
    expect(res.status).toBe(201);
  });
});
