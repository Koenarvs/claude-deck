import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeMigratedDb } from '../helpers/db-fixture';
import { createSystemRouter } from '../../../server/routes/system';
import type Database from 'better-sqlite3';

vi.mock('../../../server/ws', () => ({ broadcast: vi.fn() }));
vi.mock('../../../server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let db: Database.Database;
let server: http.Server;
let port: number;
let dir: string;
const url = (p: string) => `http://127.0.0.1:${port}/api${p}`;
const post = (p: string, body: unknown) =>
  fetch(url(p), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'docwrite-')));
  db = makeMigratedDb();
  db.prepare(
    `INSERT INTO goals (id, title, cwd, status, priority, permission_mode, kanban_order, created_at, updated_at)
     VALUES ('g1', 'G', ?, 'active', 0, 'supervised', 1, 0, 0)`,
  ).run(dir);

  const app = express();
  app.use(express.json());
  app.locals.db = db;
  app.use('/api', createSystemRouter());
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
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('POST /api/goals/:id/document (5F attributed write)', () => {
  it('writes a document with an attribution trailer', async () => {
    const res = await post('/goals/g1/document', {
      name: 'handoff.md',
      content: 'hello\n',
      baseHash: '',
      author: 'goal-1/claude',
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { written: boolean }).written).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'handoff.md'), 'utf-8')).toMatch(
      /— written by goal-1\/claude @/,
    );
  });

  it('returns 409 on a stale base hash (conflict)', async () => {
    fs.writeFileSync(path.join(dir, 'handoff.md'), 'original\n');
    const res = await post('/goals/g1/document', {
      name: 'handoff.md',
      content: 'mine\n',
      baseHash: 'deadbeef',
      author: 'goal-1/claude',
    });
    expect(res.status).toBe(409);
    expect(fs.readFileSync(path.join(dir, 'handoff.md'), 'utf-8')).toBe('original\n');
  });

  it('rejects a traversal filename (400)', async () => {
    const res = await post('/goals/g1/document', { name: '../evil.md', content: 'x', baseHash: '' });
    expect(res.status).toBe(400);
  });

  it('404 for an unknown goal', async () => {
    const res = await post('/goals/nope/document', { name: 'a.md', content: 'x', baseHash: '' });
    expect(res.status).toBe(404);
  });
});
