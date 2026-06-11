import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { makeMigratedDb } from '../helpers/db-fixture';
import { createProjectService } from '../../../server/services/project-service';
import { createProjectsRouter } from '../../../server/routes/projects';
import type Database from 'better-sqlite3';

vi.mock('../../../server/ws', () => ({ broadcast: vi.fn() }));
vi.mock('../../../server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let db: Database.Database;
let server: http.Server;
let port: number;
const url = (p: string) => `http://127.0.0.1:${port}/api${p}`;

beforeEach(async () => {
  db = makeMigratedDb();
  const app = express();
  app.use(express.json());
  app.use('/api', createProjectsRouter(createProjectService(db)));
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
});

describe('/api/projects', () => {
  it('POST creates, GET lists, PATCH updates, DELETE removes', async () => {
    const created = await fetch(url('/projects'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Deck', root_path: 'C:/github/claude-deck' }),
    });
    expect(created.status).toBe(201);
    const p = (await created.json()) as { id: string };

    const listed = (await (await fetch(url('/projects'))).json()) as unknown[];
    expect(listed.length).toBe(1);

    const patched = await fetch(url(`/projects/${p.id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ done_command: 'npm test' }),
    });
    expect(((await patched.json()) as { done_command: string }).done_command).toBe('npm test');

    const del = await fetch(url(`/projects/${p.id}`), { method: 'DELETE' });
    expect(del.status).toBe(200);
  });

  it('409 on duplicate root', async () => {
    const body = JSON.stringify({ name: 'A', root_path: 'C:/repo' });
    await fetch(url('/projects'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const dup = await fetch(url('/projects'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'B', root_path: 'C:/repo' }),
    });
    expect(dup.status).toBe(409);
  });

  it('404 reading a missing project', async () => {
    const res = await fetch(url('/projects/nope'));
    expect(res.status).toBe(404);
  });
});
