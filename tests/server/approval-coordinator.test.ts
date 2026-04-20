import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ApprovalCoordinator } from '../../server/approval-coordinator';
import type { ApprovalRequest } from '../../server/approval-coordinator';
import { runMigrations } from '../../server/db/migrate';

// Mock the broadcast function
vi.mock('../../server/ws', () => ({
  broadcast: vi.fn(),
}));

// Mock the logger to suppress output during tests
vi.mock('../../server/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { broadcast } from '../../server/ws';

const mockedBroadcast = vi.mocked(broadcast);

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function makeRequest(overrides?: Partial<ApprovalRequest>): ApprovalRequest {
  return {
    session_id: 'test-session-1',
    goal_id: 'test-goal-1',
    tool_name: 'Bash',
    tool_args: '{"command":"ls"}',
    ...overrides,
  };
}

describe('ApprovalCoordinator', () => {
  let db: Database.Database;
  let coordinator: ApprovalCoordinator;

  beforeEach(() => {
    db = createTestDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (coordinator) coordinator.shutdown();
    db.close();
  });

  describe('autonomous mode', () => {
    it('immediately resolves with allow', async () => {
      coordinator = new ApprovalCoordinator(db, 100);
      const req = makeRequest();

      const decision = await coordinator.request(req, true);

      expect(decision).toEqual({ decision: 'allow' });
    });

    it('resolves in under 50ms', async () => {
      coordinator = new ApprovalCoordinator(db, 100);
      const req = makeRequest();

      const start = Date.now();
      await coordinator.request(req, true);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(50);
    });

    it('inserts approval row with status=approved', async () => {
      coordinator = new ApprovalCoordinator(db, 100);
      const req = makeRequest();

      await coordinator.request(req, true);

      const row = db.prepare(`SELECT * FROM approvals`).get() as Record<string, unknown>;
      expect(row['status']).toBe('approved');
      expect(row['tool_name']).toBe('Bash');
      expect(row['resolved_at']).not.toBeNull();
    });

    it('broadcasts approval:pending then approval:resolved', async () => {
      coordinator = new ApprovalCoordinator(db, 100);
      const req = makeRequest();

      await coordinator.request(req, true);

      expect(mockedBroadcast).toHaveBeenCalledTimes(2);

      const pendingCall = mockedBroadcast.mock.calls[0]![0];
      expect(pendingCall.type).toBe('approval:pending');

      const resolvedCall = mockedBroadcast.mock.calls[1]![0];
      expect(resolvedCall.type).toBe('approval:resolved');
      if (resolvedCall.type === 'approval:resolved') {
        expect(resolvedCall.decision).toBe('approved');
      }
    });

    it('does not leave pending entries', async () => {
      coordinator = new ApprovalCoordinator(db, 100);
      const req = makeRequest();

      await coordinator.request(req, true);

      expect(coordinator.pendingCount).toBe(0);
    });
  });

  describe('supervised mode — UI resolve', () => {
    it('blocks until resolve is called, then returns allow', async () => {
      coordinator = new ApprovalCoordinator(db, 5000);
      const req = makeRequest();

      // Start the request (it blocks)
      const resultPromise = coordinator.request(req, false);

      // Find the pending approval ID
      const row = db.prepare(`SELECT id FROM approvals WHERE status = 'pending'`).get() as {
        id: string;
      };

      // Resolve it
      coordinator.resolve(row.id, 'approved', 'looks good');

      const decision = await resultPromise;
      expect(decision).toEqual({ decision: 'allow' });
    });

    it('blocks until resolve is called, then returns deny', async () => {
      coordinator = new ApprovalCoordinator(db, 5000);
      const req = makeRequest();

      const resultPromise = coordinator.request(req, false);

      const row = db.prepare(`SELECT id FROM approvals WHERE status = 'pending'`).get() as {
        id: string;
      };

      coordinator.resolve(row.id, 'denied', 'not safe');

      const decision = await resultPromise;
      expect(decision).toEqual({ decision: 'deny', reason: 'not safe' });
    });

    it('updates DB row on resolve', async () => {
      coordinator = new ApprovalCoordinator(db, 5000);
      const req = makeRequest();

      const resultPromise = coordinator.request(req, false);

      const pending = db.prepare(`SELECT id FROM approvals WHERE status = 'pending'`).get() as {
        id: string;
      };

      coordinator.resolve(pending.id, 'approved', 'user approved');
      await resultPromise;

      const row = db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(pending.id) as Record<
        string,
        unknown
      >;
      expect(row['status']).toBe('approved');
      expect(row['decided_reason']).toBe('user approved');
      expect(row['resolved_at']).not.toBeNull();
    });

    it('decrements pending count on resolve', async () => {
      coordinator = new ApprovalCoordinator(db, 5000);
      const req = makeRequest();

      const resultPromise = coordinator.request(req, false);
      expect(coordinator.pendingCount).toBe(1);

      const row = db.prepare(`SELECT id FROM approvals WHERE status = 'pending'`).get() as {
        id: string;
      };
      coordinator.resolve(row.id, 'approved');
      await resultPromise;

      expect(coordinator.pendingCount).toBe(0);
    });
  });

  describe('timeout', () => {
    it('auto-denies after timeout', async () => {
      coordinator = new ApprovalCoordinator(db, 50); // 50ms timeout
      const req = makeRequest();

      const decision = await coordinator.request(req, false);

      expect(decision).toEqual({ decision: 'deny', reason: 'timeout' });
    });

    it('sets row status to timeout', async () => {
      coordinator = new ApprovalCoordinator(db, 50);
      const req = makeRequest();

      await coordinator.request(req, false);

      const row = db.prepare(`SELECT * FROM approvals`).get() as Record<string, unknown>;
      expect(row['status']).toBe('timeout');
      expect(row['decided_reason']).toBe('timeout');
    });

    it('broadcasts approval:resolved with timeout decision', async () => {
      coordinator = new ApprovalCoordinator(db, 50);
      const req = makeRequest();

      await coordinator.request(req, false);

      const resolvedCalls = mockedBroadcast.mock.calls.filter(
        (call) => call[0].type === 'approval:resolved',
      );
      expect(resolvedCalls.length).toBe(1);

      const event = resolvedCalls[0]![0];
      if (event.type === 'approval:resolved') {
        expect(event.decision).toBe('timeout');
      }
    });

    it('clears from pending map after timeout', async () => {
      coordinator = new ApprovalCoordinator(db, 50);
      const req = makeRequest();

      await coordinator.request(req, false);

      expect(coordinator.pendingCount).toBe(0);
    });
  });

  describe('duplicate resolution', () => {
    it('ignores resolve for already-resolved approval', async () => {
      coordinator = new ApprovalCoordinator(db, 5000);
      const req = makeRequest();

      const resultPromise = coordinator.request(req, false);

      const row = db.prepare(`SELECT id FROM approvals WHERE status = 'pending'`).get() as {
        id: string;
      };

      const first = coordinator.resolve(row.id, 'approved');
      const second = coordinator.resolve(row.id, 'denied');

      expect(first).toBe(true);
      expect(second).toBe(false);

      const decision = await resultPromise;
      expect(decision).toEqual({ decision: 'allow' });
    });

    it('returns false for nonexistent approval ID', () => {
      coordinator = new ApprovalCoordinator(db, 100);

      const result = coordinator.resolve('nonexistent-id', 'approved');
      expect(result).toBe(false);
    });
  });

  describe('concurrent requests', () => {
    it('handles multiple simultaneous approvals independently', async () => {
      coordinator = new ApprovalCoordinator(db, 5000);

      const promises = Array.from({ length: 5 }, (_, i) =>
        coordinator.request(
          makeRequest({ tool_name: `Tool${i}`, session_id: `session-${i}` }),
          false,
        ),
      );

      expect(coordinator.pendingCount).toBe(5);

      // Resolve each one
      const rows = db
        .prepare(`SELECT id, tool_name FROM approvals WHERE status = 'pending' ORDER BY tool_name`)
        .all() as Array<{ id: string; tool_name: string }>;

      expect(rows.length).toBe(5);

      // Approve first 3, deny last 2
      for (let i = 0; i < 3; i++) {
        coordinator.resolve(rows[i]!.id, 'approved');
      }
      for (let i = 3; i < 5; i++) {
        coordinator.resolve(rows[i]!.id, 'denied', 'unsafe');
      }

      const decisions = await Promise.all(promises);

      // First 3 sorted by tool name (Tool0, Tool1, Tool2) should be allow
      const allowCount = decisions.filter((d) => d.decision === 'allow').length;
      const denyCount = decisions.filter((d) => d.decision === 'deny').length;

      expect(allowCount).toBe(3);
      expect(denyCount).toBe(2);
      expect(coordinator.pendingCount).toBe(0);
    });
  });

  describe('shutdown', () => {
    it('resolves all pending with deny/shutdown', async () => {
      coordinator = new ApprovalCoordinator(db, 60000);

      const promises = Array.from({ length: 3 }, (_, i) =>
        coordinator.request(makeRequest({ tool_name: `Tool${i}` }), false),
      );

      expect(coordinator.pendingCount).toBe(3);

      coordinator.shutdown();

      const decisions = await Promise.all(promises);
      for (const d of decisions) {
        expect(d.decision).toBe('deny');
        expect(d.reason).toBe('server shutdown');
      }

      expect(coordinator.pendingCount).toBe(0);

      // DB rows should be denied
      const rows = db.prepare(`SELECT status FROM approvals`).all() as Array<{
        status: string;
      }>;
      for (const row of rows) {
        expect(row.status).toBe('denied');
      }
    });
  });
});
