import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/db/migrate';
import { ApprovalCoordinator } from '../../server/approval-coordinator';
import { HookIngest } from '../../server/hook-ingest';

// Mock broadcast and logger
vi.mock('../../server/ws', () => ({
  broadcast: vi.fn(),
}));

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

describe('HookIngest', () => {
  let db: Database.Database;
  let coordinator: ApprovalCoordinator;
  let ingest: HookIngest;

  beforeEach(() => {
    db = createTestDb();
    coordinator = new ApprovalCoordinator(db, 100); // 100ms timeout
    ingest = new HookIngest(db, coordinator);
    vi.clearAllMocks();
  });

  afterEach(() => {
    coordinator.shutdown();
    db.close();
  });

  describe('onSessionStart', () => {
    it('creates a sessions row with origin=external for new session', () => {
      ingest.onSessionStart({ session_id: 'new-sess-1', cwd: '/home/user' });

      const row = db.prepare(`SELECT * FROM sessions WHERE id = 'new-sess-1'`).get() as Record<
        string,
        unknown
      >;
      expect(row).toBeDefined();
      expect(row['origin']).toBe('external');
      expect(row['cwd']).toBe('/home/user');
    });

    it('does not overwrite an existing dashboard session', () => {
      const now = Date.now();
      db.prepare(
        `INSERT INTO sessions (id, goal_id, origin, cwd, started_at, stream_event_count, hook_event_count, stderr_bytes)
         VALUES ('existing-1', NULL, 'dashboard', '/original', ?, 0, 0, 0)`,
      ).run(now);

      ingest.onSessionStart({ session_id: 'existing-1', cwd: '/different' });

      const row = db.prepare(`SELECT * FROM sessions WHERE id = 'existing-1'`).get() as Record<
        string,
        unknown
      >;
      expect(row['origin']).toBe('dashboard');
      expect(row['cwd']).toBe('/original');
    });

    it('persists a hook_events row', () => {
      ingest.onSessionStart({ session_id: 'hook-evt-sess-1' });

      const row = db
        .prepare(`SELECT * FROM hook_events WHERE event_type = 'SessionStart' AND session_id = 'hook-evt-sess-1'`)
        .get();
      expect(row).toBeDefined();
    });

    it('broadcasts session:observed for new external session', () => {
      ingest.onSessionStart({ session_id: 'broadcast-sess-1', cwd: '/tmp' });

      const sessionObserved = mockedBroadcast.mock.calls.find(
        (call) => call[0].type === 'session:observed',
      );
      expect(sessionObserved).toBeDefined();
    });

    it('increments hook_event_count on session', () => {
      ingest.onSessionStart({ session_id: 'count-sess-1', cwd: '/tmp' });

      const row = db.prepare(`SELECT hook_event_count FROM sessions WHERE id = 'count-sess-1'`).get() as {
        hook_event_count: number;
      };
      // The session was just created with hook_event_count=0, then the persistEvent increments it.
      // But the INSERT happens before the UPDATE, so it depends on order.
      // persistEvent does: INSERT into hook_events, then UPDATE sessions SET hook_event_count + 1
      // onSessionStart does: persistEvent (which creates the hook_event row and increments count),
      // The INSERT sets hook_event_count=1 because the session was created by a hook event
      expect(row.hook_event_count).toBe(1);
    });
  });

  describe('onUserPromptSubmit', () => {
    it('persists to hook_events', () => {
      ingest.onUserPromptSubmit({ session_id: 'prompt-sess-1' });

      const row = db
        .prepare(`SELECT * FROM hook_events WHERE event_type = 'UserPromptSubmit' AND session_id = 'prompt-sess-1'`)
        .get();
      expect(row).toBeDefined();
    });
  });

  describe('onPreToolUse', () => {
    it('returns allow immediately (pass-through to terminal)', async () => {
      const decision = await ingest.onPreToolUse({
        session_id: 'pre-tool-1',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /' },
      });

      expect(decision.decision).toBe('allow');
    });

    it('returns allow for autonomous goal', async () => {
      const goalId = 'auto-goal-pre';
      const sessionId = 'auto-sess-pre';
      const now = Date.now();

      db.prepare(
        `INSERT INTO goals (id, title, cwd, status, priority, tags, permission_mode, kanban_order, created_at, updated_at)
         VALUES (?, 'Auto Goal', '/tmp', 'active', 0, '[]', 'autonomous', 1.0, ?, ?)`,
      ).run(goalId, now, now);

      db.prepare(
        `INSERT INTO sessions (id, goal_id, origin, started_at, stream_event_count, hook_event_count, stderr_bytes)
         VALUES (?, ?, 'dashboard', ?, 0, 0, 0)`,
      ).run(sessionId, goalId, now);

      const decision = await ingest.onPreToolUse({
        session_id: sessionId,
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/test.txt' },
      });

      expect(decision.decision).toBe('allow');
    });

    it('persists hook_event and creates approval row', async () => {
      await ingest.onPreToolUse({
        session_id: 'pre-tool-persist',
        tool_name: 'Write',
      });

      const hookEvent = db
        .prepare(`SELECT * FROM hook_events WHERE session_id = 'pre-tool-persist' AND event_type = 'PreToolUse'`)
        .get();
      expect(hookEvent).toBeDefined();

      const approval = db.prepare(`SELECT * FROM approvals WHERE session_id = 'pre-tool-persist'`).get() as Record<
        string,
        unknown
      >;
      expect(approval).toBeDefined();
      expect(approval['tool_name']).toBe('Write');
    });
  });

  describe('onPostToolUse', () => {
    it('persists to hook_events', () => {
      ingest.onPostToolUse({
        session_id: 'post-tool-1',
        tool_name: 'Bash',
        tool_input: { command: 'echo hi' },
      });

      const row = db
        .prepare(`SELECT * FROM hook_events WHERE session_id = 'post-tool-1' AND event_type = 'PostToolUse'`)
        .get();
      expect(row).toBeDefined();
    });

    it('extracts plan from TodoWrite and updates goal', () => {
      const goalId = 'plan-extract-goal';
      const sessionId = 'plan-extract-sess';
      const now = Date.now();

      db.prepare(
        `INSERT INTO goals (id, title, cwd, status, priority, tags, permission_mode, kanban_order, created_at, updated_at)
         VALUES (?, 'Plan Goal', '/tmp', 'active', 0, '[]', 'supervised', 3.0, ?, ?)`,
      ).run(goalId, now, now);

      db.prepare(
        `INSERT INTO sessions (id, goal_id, origin, started_at, stream_event_count, hook_event_count, stderr_bytes)
         VALUES (?, ?, 'dashboard', ?, 0, 0, 0)`,
      ).run(sessionId, goalId, now);

      ingest.onPostToolUse({
        session_id: sessionId,
        tool_name: 'TodoWrite',
        tool_input: {
          todos: [
            { id: '1', content: 'Implement feature', status: 'in_progress' },
            { id: '2', content: 'Write tests', status: 'pending' },
          ],
        },
      });

      const goal = db.prepare(`SELECT plan_json, updated_at FROM goals WHERE id = ?`).get(goalId) as {
        plan_json: string;
        updated_at: number;
      };
      expect(goal.plan_json).not.toBeNull();

      const plan = JSON.parse(goal.plan_json);
      expect(plan.todos).toHaveLength(2);
      expect(plan.todos[0].content).toBe('Implement feature');
      expect(plan.todos[0].status).toBe('in_progress');
      expect(plan.todos[1].content).toBe('Write tests');
      expect(plan.todos[1].status).toBe('pending');
    });

    it('broadcasts goal:plan-updated on TodoWrite', () => {
      const goalId = 'broadcast-plan-goal';
      const sessionId = 'broadcast-plan-sess';
      const now = Date.now();

      db.prepare(
        `INSERT INTO goals (id, title, cwd, status, priority, tags, permission_mode, kanban_order, created_at, updated_at)
         VALUES (?, 'Broadcast Plan', '/tmp', 'active', 0, '[]', 'supervised', 4.0, ?, ?)`,
      ).run(goalId, now, now);

      db.prepare(
        `INSERT INTO sessions (id, goal_id, origin, started_at, stream_event_count, hook_event_count, stderr_bytes)
         VALUES (?, ?, 'dashboard', ?, 0, 0, 0)`,
      ).run(sessionId, goalId, now);

      ingest.onPostToolUse({
        session_id: sessionId,
        tool_name: 'TodoWrite',
        tool_input: {
          todos: [{ id: '1', content: 'Task', status: 'pending' }],
        },
      });

      const planUpdate = mockedBroadcast.mock.calls.find(
        (call) => call[0].type === 'goal:plan-updated',
      );
      expect(planUpdate).toBeDefined();
      if (planUpdate) {
        const event = planUpdate[0];
        if (event.type === 'goal:plan-updated') {
          expect(event.id).toBe(goalId);
          expect(event.plan_json.todos).toHaveLength(1);
        }
      }
    });

    it('skips plan extraction for non-TodoWrite tools', () => {
      ingest.onPostToolUse({
        session_id: 'post-bash-1',
        tool_name: 'Bash',
        tool_input: { command: 'echo hi' },
      });

      const planUpdate = mockedBroadcast.mock.calls.find(
        (call) => call[0].type === 'goal:plan-updated',
      );
      expect(planUpdate).toBeUndefined();
    });

    it('skips plan update when session has no goal', () => {
      ingest.onPostToolUse({
        session_id: 'no-goal-sess',
        tool_name: 'TodoWrite',
        tool_input: {
          todos: [{ id: '1', content: 'Orphan task', status: 'pending' }],
        },
      });

      const planUpdate = mockedBroadcast.mock.calls.find(
        (call) => call[0].type === 'goal:plan-updated',
      );
      expect(planUpdate).toBeUndefined();
    });
  });

  describe('onStop', () => {
    it('marks session ended_at', () => {
      const sessionId = 'stop-sess-1';
      db.prepare(
        `INSERT INTO sessions (id, origin, started_at, stream_event_count, hook_event_count, stderr_bytes)
         VALUES (?, 'external', ?, 0, 0, 0)`,
      ).run(sessionId, Date.now());

      ingest.onStop({ session_id: sessionId });

      const row = db.prepare(`SELECT ended_at FROM sessions WHERE id = ?`).get(sessionId) as {
        ended_at: number | null;
      };
      expect(row.ended_at).not.toBeNull();
    });

    it('broadcasts session:ended', () => {
      const sessionId = 'stop-broadcast-1';
      db.prepare(
        `INSERT INTO sessions (id, origin, started_at, stream_event_count, hook_event_count, stderr_bytes)
         VALUES (?, 'external', ?, 0, 0, 0)`,
      ).run(sessionId, Date.now());

      ingest.onStop({ session_id: sessionId });

      const ended = mockedBroadcast.mock.calls.find(
        (call) => call[0].type === 'session:ended',
      );
      expect(ended).toBeDefined();
      if (ended) {
        const event = ended[0];
        if (event.type === 'session:ended') {
          expect(event.id).toBe(sessionId);
        }
      }
    });

    it('does not update ended_at if already set', () => {
      const sessionId = 'stop-idempotent-1';
      const firstEnd = Date.now() - 10000;
      db.prepare(
        `INSERT INTO sessions (id, origin, started_at, ended_at, stream_event_count, hook_event_count, stderr_bytes)
         VALUES (?, 'external', ?, ?, 0, 0, 0)`,
      ).run(sessionId, Date.now() - 20000, firstEnd);

      ingest.onStop({ session_id: sessionId });

      const row = db.prepare(`SELECT ended_at FROM sessions WHERE id = ?`).get(sessionId) as {
        ended_at: number;
      };
      expect(row.ended_at).toBe(firstEnd);
    });

    it('persists to hook_events', () => {
      const sessionId = 'stop-events-1';
      db.prepare(
        `INSERT INTO sessions (id, origin, started_at, stream_event_count, hook_event_count, stderr_bytes)
         VALUES (?, 'external', ?, 0, 0, 0)`,
      ).run(sessionId, Date.now());

      ingest.onStop({ session_id: sessionId });

      const row = db
        .prepare(`SELECT * FROM hook_events WHERE session_id = ? AND event_type = 'Stop'`)
        .get(sessionId);
      expect(row).toBeDefined();
    });
  });
});
