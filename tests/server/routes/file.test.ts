import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';
import { createFileRouter } from '../../../server/routes/file';

vi.mock('../../../server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let db: Database.Database;
let server: http.Server;
let port: number;
let root: string; // realpathed temp dir registered as a goal cwd (an editable root)
let docPath: string;
let outsideDir: string;

function url(p: string): string {
  return `http://127.0.0.1:${port}/api${p}`;
}
async function putFile(body: Record<string, unknown>): Promise<Response> {
  return fetch(url('/file'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'file-root-')));
  outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'file-out-')));
  docPath = path.join(root, 'doc.md');
  fs.writeFileSync(docPath, 'v1', 'utf-8');

  // Register `root` as an editable root via a goal cwd.
  db.prepare(
    `INSERT INTO goals (id, title, cwd, status, priority, permission_mode, kanban_order, created_at, updated_at)
     VALUES ('g1', 'g', ?, 'planning', 0, 'supervised', 0, 0, 0)`,
  ).run(root);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.locals.db = db;
  app.use('/api', createFileRouter());

  server = http.createServer(app);
  port = await new Promise<number>((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') resolve(addr.port);
    });
  });
});

afterEach(() => {
  server.close();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
});

describe('PUT /api/file', () => {
  it('writes a valid edit to a file under an editable root', async () => {
    const res = await putFile({ path: docPath, content: 'v2 updated' });
    expect(res.status).toBe(200);
    expect(fs.readFileSync(docPath, 'utf-8')).toBe('v2 updated');
  });

  it('rejects a path outside every editable root (403)', async () => {
    const outside = path.join(outsideDir, 'evil.md');
    fs.writeFileSync(outside, 'x', 'utf-8');
    const res = await putFile({ path: outside, content: 'nope' });
    expect(res.status).toBe(403);
    expect(fs.readFileSync(outside, 'utf-8')).toBe('x'); // untouched
  });

  it('rejects traversal that escapes the root (403)', async () => {
    const res = await putFile({ path: path.join(root, '..', 'escape.md'), content: 'nope' });
    expect(res.status).toBe(403);
  });

  it('rejects a non-existent file — edit-only, no create (404)', async () => {
    const res = await putFile({ path: path.join(root, 'missing.md'), content: 'x' });
    expect(res.status).toBe(404);
    expect(fs.existsSync(path.join(root, 'missing.md'))).toBe(false);
  });

  it('rejects a non-.md/.txt extension (400)', async () => {
    const jsonPath = path.join(root, 'data.json');
    fs.writeFileSync(jsonPath, '{}', 'utf-8');
    const res = await putFile({ path: jsonPath, content: '{"a":1}' });
    expect(res.status).toBe(400);
  });

  it('rejects oversized content (>1 MB) (400)', async () => {
    const huge = 'a'.repeat(1_000_001);
    const res = await putFile({ path: docPath, content: huge });
    expect(res.status).toBe(400);
    expect(fs.readFileSync(docPath, 'utf-8')).toBe('v1'); // untouched
  });

  it('returns 409 when the on-disk mtime differs from baseModifiedMs', async () => {
    const res = await putFile({ path: docPath, content: 'v2', baseModifiedMs: 1 });
    expect(res.status).toBe(409);
    expect(fs.readFileSync(docPath, 'utf-8')).toBe('v1'); // untouched
  });

  it('accepts a write when baseModifiedMs matches the current mtime', async () => {
    const mtime = fs.statSync(docPath).mtimeMs;
    const res = await putFile({ path: docPath, content: 'v2 ok', baseModifiedMs: mtime });
    expect(res.status).toBe(200);
    expect(fs.readFileSync(docPath, 'utf-8')).toBe('v2 ok');
  });
});
