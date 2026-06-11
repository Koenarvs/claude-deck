import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { makeMigratedDb } from '../helpers/db-fixture';
import { createVerificationService } from '../../../server/services/verification-service';
import { createVerificationRouter } from '../../../server/routes/verification';
import type { Goal } from '../../../src/shared/types';
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
  const svc = createVerificationService(db, {
    resolveDoneCommand: () => null,
    resolveWorkspace: (g: Goal) => g.cwd,
  });
  const base = { command: 'npm test', workspace: '/r', exit_code: 0, output: 'ok', duration_ms: 1 };
  svc.record({ ...base, goal_id: 'g1', session_id: 's1', status: 'pass', model: 'opus' });
  svc.record({ ...base, goal_id: 'g2', session_id: 's2', status: 'fail', exit_code: 1, model: 'sonnet' });

  const app = express();
  app.use('/api', createVerificationRouter(svc));
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

describe('verification routes', () => {
  it('GET /goals/:id/verification returns the latest result', async () => {
    const res = await fetch(url('/goals/g1/verification'));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('pass');
  });

  it('404 when a goal has no verification', async () => {
    const res = await fetch(url('/goals/nope/verification'));
    expect(res.status).toBe(404);
  });

  it('GET /analytics/model-scorecard returns per-model pass rates', async () => {
    const res = await fetch(url('/analytics/model-scorecard'));
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ model: string; passRate: number }>;
    expect(rows.find((r) => r.model === 'opus')?.passRate).toBe(1);
    expect(rows.find((r) => r.model === 'sonnet')?.passRate).toBe(0);
  });
});
