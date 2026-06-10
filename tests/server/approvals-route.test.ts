import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/db/migrate';
import { ApprovalCoordinator } from '../../server/approval-coordinator';
import { createApprovalsRouter } from '../../server/routes/approvals';

// broadcast/logger touch real sockets — stub them.
vi.mock('../../server/ws', () => ({ broadcast: vi.fn() }));
vi.mock('../../server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let db: Database.Database;
let coord: ApprovalCoordinator;
let server: http.Server;
let port: number;

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  coord = new ApprovalCoordinator(db, 5_000);

  const app = express();
  app.use(express.json());
  app.use('/api', createApprovalsRouter(db, coord));

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
  coord.shutdown();
  db.close();
});

describe('POST /approvals/:id/decide resolves a blocking request()', () => {
  it('approve resolves the pending deferred with allow', async () => {
    // Start a blocking request (the deferred the hook awaits).
    const pending = coord.request(
      { session_id: 's', goal_id: 'g', tool_name: 'Bash', tool_args: '{}' },
      false,
    );

    const row = db.prepare(`SELECT id FROM approvals WHERE status='pending'`).get() as {
      id: string;
    };
    expect(row).toBeDefined();

    const res = await fetch(`http://127.0.0.1:${port}/api/approvals/${row.id}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approved' }),
    });
    expect(res.status).toBe(200);

    await expect(pending).resolves.toEqual({ decision: 'allow' });
  });

  it('deny resolves the pending deferred with deny + reason', async () => {
    const pending = coord.request(
      { session_id: 's', goal_id: 'g', tool_name: 'Bash', tool_args: '{}' },
      false,
    );
    const row = db.prepare(`SELECT id FROM approvals WHERE status='pending'`).get() as {
      id: string;
    };

    const res = await fetch(`http://127.0.0.1:${port}/api/approvals/${row.id}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'denied', reason: 'nope' }),
    });
    expect(res.status).toBe(200);

    await expect(pending).resolves.toEqual({ decision: 'deny', reason: 'nope' });
  });
});
