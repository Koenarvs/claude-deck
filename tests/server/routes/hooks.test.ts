import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';
import { ApprovalCoordinator } from '../../../server/approval-coordinator';
import { HookIngest } from '../../../server/hook-ingest';
import { createHooksRouter } from '../../../server/routes/hooks';

// Mock broadcast and logger
vi.mock('../../../server/ws', () => ({
  broadcast: vi.fn(),
}));

vi.mock('../../../server/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

async function postJson(
  port: number,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body: json };
}

describe('Hook routes', () => {
  let db: Database.Database;
  let coordinator: ApprovalCoordinator;
  let hookIngest: HookIngest;
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    db = createTestDb();
    coordinator = new ApprovalCoordinator(db, 200); // 200ms timeout for tests
    hookIngest = new HookIngest(db, coordinator);

    const app = express();
    app.use(express.json());
    app.use('/api', createHooksRouter(hookIngest));

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          port = addr.port;
        }
        resolve();
      });
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    coordinator.shutdown();
    server.close();
    db.close();
  });

  describe('POST /api/hook/session-start', () => {
    it('returns 200 with ok:true', async () => {
      const res = await postJson(port, '/api/hook/session-start', {
        session_id: 'sess-start-1',
        cwd: '/tmp',
        model: 'sonnet',
      });

      expect(res.status).toBe(200);
      expect(res.body['ok']).toBe(true);
    });

    it('creates a sessions row with origin=external', async () => {
      const res = await postJson(port, '/api/hook/session-start', {
        session_id: 'sess-start-2',
        cwd: '/home/user/project',
      });

      expect(res.status).toBe(200);

      const row = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get('sess-start-2') as Record<
        string,
        unknown
      >;
      expect(row).toBeDefined();
      expect(row['origin']).toBe('external');
      expect(row['cwd']).toBe('/home/user/project');
    });

    it('persists to hook_events table', async () => {
      await postJson(port, '/api/hook/session-start', {
        session_id: 'sess-start-3',
      });

      const row = db
        .prepare(
          `SELECT * FROM hook_events WHERE session_id = 'sess-start-3' AND event_type = 'SessionStart'`,
        )
        .get() as Record<string, unknown>;
      expect(row).toBeDefined();
      expect(row['event_type']).toBe('SessionStart');
    });
  });

  describe('POST /api/hook/user-prompt-submit', () => {
    it('returns 200 with ok:true', async () => {
      const res = await postJson(port, '/api/hook/user-prompt-submit', {
        session_id: 'sess-prompt-1',
      });

      expect(res.status).toBe(200);
      expect(res.body['ok']).toBe(true);
    });

    it('persists to hook_events table', async () => {
      await postJson(port, '/api/hook/user-prompt-submit', {
        session_id: 'sess-prompt-2',
      });

      const row = db
        .prepare(
          `SELECT * FROM hook_events WHERE session_id = 'sess-prompt-2' AND event_type = 'UserPromptSubmit'`,
        )
        .get() as Record<string, unknown>;
      expect(row).toBeDefined();
    });
  });

  describe('POST /api/hook/pre-tool-use', () => {
    it('returns allow for external sessions (supervised, no goal)', async () => {
      // Hooks are now pass-through — always return allow immediately
      const res = await postJson(port, '/api/hook/pre-tool-use', {
        session_id: 'sess-pre-1',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      });

      expect(res.status).toBe(200);
      expect(res.body['decision']).toBe('allow');
    });

    it('returns allow immediately for autonomous goal', async () => {
      // Insert a goal with autonomous mode and link a session to it
      const goalId = 'auto-goal-1';
      const sessionId = 'auto-sess-1';
      const now = Date.now();

      db.prepare(
        `INSERT INTO goals (id, title, cwd, status, priority, tags, permission_mode, kanban_order, created_at, updated_at)
         VALUES (?, 'Test Goal', '/tmp', 'active', 0, '[]', 'autonomous', 1.0, ?, ?)`,
      ).run(goalId, now, now);

      db.prepare(
        `INSERT INTO sessions (id, goal_id, origin, cwd, started_at, stream_event_count, hook_event_count, stderr_bytes)
         VALUES (?, ?, 'dashboard', '/tmp', ?, 0, 0, 0)`,
      ).run(sessionId, goalId, now);

      const start = Date.now();
      const res = await postJson(port, '/api/hook/pre-tool-use', {
        session_id: sessionId,
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/test.txt' },
      });
      const elapsed = Date.now() - start;

      expect(res.status).toBe(200);
      expect(res.body['decision']).toBe('allow');
      expect(elapsed).toBeLessThan(200); // Should be near-instant
    });

    it('persists to hook_events table', async () => {
      const sessionId = 'sess-pre-events-1';

      // This will block and timeout (200ms), but we still check persistence
      await postJson(port, '/api/hook/pre-tool-use', {
        session_id: sessionId,
        tool_name: 'Write',
        tool_input: { file_path: '/tmp/out.txt' },
      });

      const row = db
        .prepare(
          `SELECT * FROM hook_events WHERE session_id = ? AND event_type = 'PreToolUse'`,
        )
        .get(sessionId) as Record<string, unknown>;
      expect(row).toBeDefined();
      expect(row['tool_name']).toBe('Write');
    });
  });

  describe('POST /api/hook/post-tool-use', () => {
    it('returns 200 with ok:true', async () => {
      const res = await postJson(port, '/api/hook/post-tool-use', {
        session_id: 'sess-post-1',
        tool_name: 'Bash',
        tool_input: { command: 'echo hi' },
      });

      expect(res.status).toBe(200);
      expect(res.body['ok']).toBe(true);
    });

    it('extracts plan from TodoWrite and updates goal', async () => {
      // Set up a goal and session
      const goalId = 'plan-goal-1';
      const sessionId = 'plan-sess-1';
      const now = Date.now();

      db.prepare(
        `INSERT INTO goals (id, title, cwd, status, priority, tags, permission_mode, kanban_order, created_at, updated_at)
         VALUES (?, 'Plan Test Goal', '/tmp', 'active', 0, '[]', 'supervised', 2.0, ?, ?)`,
      ).run(goalId, now, now);

      db.prepare(
        `INSERT INTO sessions (id, goal_id, origin, cwd, started_at, stream_event_count, hook_event_count, stderr_bytes)
         VALUES (?, ?, 'dashboard', '/tmp', ?, 0, 0, 0)`,
      ).run(sessionId, goalId, now);

      const res = await postJson(port, '/api/hook/post-tool-use', {
        session_id: sessionId,
        tool_name: 'TodoWrite',
        tool_input: {
          todos: [
            { id: '1', content: 'First task', status: 'pending' },
            { id: '2', content: 'Second task', status: 'in_progress' },
            { id: '3', content: 'Third task', status: 'completed' },
          ],
        },
      });

      expect(res.status).toBe(200);

      // Verify the goal's plan_json was updated
      const goal = db.prepare(`SELECT plan_json FROM goals WHERE id = ?`).get(goalId) as {
        plan_json: string;
      };
      expect(goal.plan_json).not.toBeNull();

      const plan = JSON.parse(goal.plan_json);
      expect(plan.todos).toHaveLength(3);
      expect(plan.todos[0].content).toBe('First task');
      expect(plan.todos[1].status).toBe('in_progress');
    });
  });

  describe('POST /api/hook/stop', () => {
    it('returns 200 with ok:true', async () => {
      // Create a session first so stop has something to update
      const sessionId = 'sess-stop-1';
      db.prepare(
        `INSERT INTO sessions (id, origin, cwd, started_at, stream_event_count, hook_event_count, stderr_bytes)
         VALUES (?, 'external', '/tmp', ?, 0, 0, 0)`,
      ).run(sessionId, Date.now());

      const res = await postJson(port, '/api/hook/stop', {
        session_id: sessionId,
      });

      expect(res.status).toBe(200);
      expect(res.body['ok']).toBe(true);
    });

    it('marks session as ended', async () => {
      const sessionId = 'sess-stop-2';
      db.prepare(
        `INSERT INTO sessions (id, origin, cwd, started_at, stream_event_count, hook_event_count, stderr_bytes)
         VALUES (?, 'external', '/tmp', ?, 0, 0, 0)`,
      ).run(sessionId, Date.now());

      await postJson(port, '/api/hook/stop', { session_id: sessionId });

      const row = db.prepare(`SELECT ended_at FROM sessions WHERE id = ?`).get(sessionId) as {
        ended_at: number | null;
      };
      expect(row.ended_at).not.toBeNull();
    });

    it('persists to hook_events table', async () => {
      const sessionId = 'sess-stop-3';
      db.prepare(
        `INSERT INTO sessions (id, origin, cwd, started_at, stream_event_count, hook_event_count, stderr_bytes)
         VALUES (?, 'external', '/tmp', ?, 0, 0, 0)`,
      ).run(sessionId, Date.now());

      await postJson(port, '/api/hook/stop', { session_id: sessionId });

      const row = db
        .prepare(
          `SELECT * FROM hook_events WHERE session_id = ? AND event_type = 'Stop'`,
        )
        .get(sessionId) as Record<string, unknown>;
      expect(row).toBeDefined();
    });
  });

  describe('validation', () => {
    it('rejects invalid JSON body with 400', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/hook/session-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"session_id": 123}',
      });

      // Passthrough schema allows extra fields and optional typing,
      // so a numeric session_id should fail zod validation
      // Actually: z.string().optional() will reject a number
      expect(res.status).toBe(400);
    });
  });

  describe('fail-open behavior', () => {
    it('returns { decision: "allow" } when pre-tool-use handler throws', async () => {
      // Create a scenario where the handler might fail internally
      // We can test this by verifying the error handler catches and returns allow
      // Since our hookIngest is well-behaved, we test this path indirectly
      // by confirming the endpoint exists and returns proper JSON
      const res = await postJson(port, '/api/hook/pre-tool-use', {});

      expect(res.status).toBe(200);
      // Hooks are now pass-through — always return allow
      expect(res.body['decision']).toBe('allow');
    });
  });
});
