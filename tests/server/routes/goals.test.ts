import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';
import { createGoalService } from '../../../server/services/goal-service';
import { createGoalsRouter } from '../../../server/routes/goals';
import { createInterGoalMessageService } from '../../../server/services/inter-goal-message-service';
import type { GoalService } from '../../../server/services/goal-service';
import type { InterGoalMessageService } from '../../../server/services/inter-goal-message-service';
import type { Goal, GoalDetail, InterGoalMessage } from '../../../src/shared/types';

// Mock broadcast and logger
vi.mock('../../../server/ws', () => ({
  broadcast: vi.fn(),
}));

vi.mock('../../../server/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

let db: Database.Database;
let goalService: GoalService;
let server: http.Server;
let port: number;

function url(path: string): string {
  return `http://127.0.0.1:${port}/api${path}`;
}

async function postJson(path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(url(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function patchJson(path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(url(path), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  goalService = createGoalService(db);

  const app = express();
  app.use(express.json());
  app.use('/api', createGoalsRouter(goalService));
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });

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
});

describe('Goals API routes', () => {
  // ── POST /api/goals ────────────────────────────────────────────────────

  describe('POST /api/goals', () => {
    it('creates a goal and returns 201', async () => {
      const res = await postJson('/goals', {
        title: 'New Goal',
        cwd: '/home/user/project',
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as Goal;
      expect(body.title).toBe('New Goal');
      expect(body.cwd).toBe('/home/user/project');
      expect(body.status).toBe('planning');
      expect(body.id).toBeDefined();
    });

    it('creates a goal with optional fields', async () => {
      const res = await postJson('/goals', {
        title: 'Full Goal',
        cwd: '/tmp',
        description: 'With description',
        model: 'opus',
        permission_mode: 'autonomous',
        tags: ['test', 'demo'],
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as Goal;
      expect(body.description).toBe('With description');
      expect(body.model).toBe('opus');
      expect(body.permission_mode).toBe('autonomous');
      expect(body.tags).toEqual(['test', 'demo']);
    });

    it('returns 400 for missing title', async () => {
      const res = await postJson('/goals', { cwd: '/tmp' });
      expect(res.status).toBe(400);
    });

    it('returns 400 for missing cwd', async () => {
      const res = await postJson('/goals', { title: 'No CWD' });
      expect(res.status).toBe(400);
    });

    it('returns 400 for empty title', async () => {
      const res = await postJson('/goals', { title: '', cwd: '/tmp' });
      expect(res.status).toBe(400);
    });

    it('accepts arbitrary model strings', async () => {
      const res = await postJson('/goals', {
        title: 'Custom Model',
        cwd: '/tmp',
        model: 'gpt-4',
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Goal;
      expect(body.model).toBe('gpt-4');
    });
  });

  // ── GET /api/goals ─────────────────────────────────────────────────────

  describe('GET /api/goals', () => {
    it('returns all goals', async () => {
      goalService.create({ title: 'A', cwd: '/tmp' });
      goalService.create({ title: 'B', cwd: '/tmp' });

      const res = await fetch(url('/goals'));
      expect(res.status).toBe(200);

      const body = (await res.json()) as Goal[];
      expect(body).toHaveLength(2);
    });

    it('filters by status query param', async () => {
      goalService.create({ title: 'Planning', cwd: '/tmp' });
      const g = goalService.create({ title: 'Active', cwd: '/tmp' });
      goalService.update(g.id, { status: 'active' });

      const res = await fetch(url('/goals?status=active'));
      const body = (await res.json()) as Goal[];
      expect(body).toHaveLength(1);
      expect(body[0]!.title).toBe('Active');
    });

    it('filters by tag query param', async () => {
      goalService.create({ title: 'Tagged', cwd: '/tmp', tags: ['frontend'] });
      goalService.create({ title: 'Other', cwd: '/tmp' });

      const res = await fetch(url('/goals?tag=frontend'));
      const body = (await res.json()) as Goal[];
      expect(body).toHaveLength(1);
      expect(body[0]!.title).toBe('Tagged');
    });

    it('returns empty array when nothing matches', async () => {
      const res = await fetch(url('/goals?status=complete'));
      const body = (await res.json()) as Goal[];
      expect(body).toEqual([]);
    });

    it('returns 400 for invalid status value', async () => {
      const res = await fetch(url('/goals?status=invalid'));
      expect(res.status).toBe(400);
    });
  });

  // ── GET /api/goals/:id ─────────────────────────────────────────────────

  describe('GET /api/goals/:id', () => {
    it('returns goal detail', async () => {
      const goal = goalService.create({ title: 'Detail', cwd: '/tmp' });

      const res = await fetch(url(`/goals/${goal.id}`));
      expect(res.status).toBe(200);

      const body = (await res.json()) as GoalDetail;
      expect(body.goal.id).toBe(goal.id);
      expect(body.messages).toEqual([]);
      expect(body.plan).toBeNull();
    });

    it('returns 404 for nonexistent goal', async () => {
      const res = await fetch(url('/goals/nonexistent'));
      expect(res.status).toBe(404);
    });
  });

  // ── PATCH /api/goals/:id ───────────────────────────────────────────────

  describe('PATCH /api/goals/:id', () => {
    it('updates title', async () => {
      const goal = goalService.create({ title: 'Original', cwd: '/tmp' });

      const res = await patchJson(`/goals/${goal.id}`, { title: 'Updated' });
      expect(res.status).toBe(200);

      const body = (await res.json()) as Goal;
      expect(body.title).toBe('Updated');
    });

    it('updates kanban_order to float', async () => {
      const goal = goalService.create({ title: 'Drag Me', cwd: '/tmp' });

      const res = await patchJson(`/goals/${goal.id}`, { kanban_order: 2.5 });
      expect(res.status).toBe(200);

      const body = (await res.json()) as Goal;
      expect(body.kanban_order).toBe(2.5);
    });

    it('returns 400 for invalid status transition', async () => {
      const goal = goalService.create({ title: 'Test', cwd: '/tmp' });
      // planning → waiting is invalid
      const res = await patchJson(`/goals/${goal.id}`, { status: 'waiting' });
      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string; from: string; to: string };
      expect(body.from).toBe('planning');
      expect(body.to).toBe('waiting');
    });

    it('allows archived → active (restart)', async () => {
      const goal = goalService.create({ title: 'Test', cwd: '/tmp' });
      goalService.update(goal.id, { status: 'archived' });

      const res = await patchJson(`/goals/${goal.id}`, { status: 'active' });
      expect(res.status).toBe(200);
    });

    it('returns 404 for nonexistent goal', async () => {
      const res = await patchJson('/goals/nonexistent', { title: 'X' });
      expect(res.status).toBe(404);
    });

    it('returns 400 for empty title', async () => {
      const goal = goalService.create({ title: 'Test', cwd: '/tmp' });
      const res = await patchJson(`/goals/${goal.id}`, { title: '' });
      expect(res.status).toBe(400);
    });
  });

  // ── DELETE /api/goals/:id ──────────────────────────────────────────────

  describe('DELETE /api/goals/:id', () => {
    it('soft-deletes (archives) a goal', async () => {
      const goal = goalService.create({ title: 'Delete Me', cwd: '/tmp' });

      const res = await fetch(url(`/goals/${goal.id}`), { method: 'DELETE' });
      expect(res.status).toBe(200);

      const body = (await res.json()) as { archived: boolean };
      expect(body.archived).toBe(true);

      const archived = goalService.get(goal.id);
      expect(archived!.status).toBe('archived');
    });

    it('returns 404 for nonexistent goal', async () => {
      const res = await fetch(url('/goals/nonexistent'), { method: 'DELETE' });
      expect(res.status).toBe(404);
    });

    it('returns 400 for already-archived goal', async () => {
      const goal = goalService.create({ title: 'Already', cwd: '/tmp' });
      goalService.archive(goal.id);

      const res = await fetch(url(`/goals/${goal.id}`), { method: 'DELETE' });
      expect(res.status).toBe(400);
    });
  });

  // ── POST /api/goals/:id/messages ───────────────────────────────────────

  describe('POST /api/goals/:id/messages', () => {
    it('returns session_id (placeholder for B1)', async () => {
      const goal = goalService.create({ title: 'Msg Test', cwd: '/tmp' });

      const res = await postJson(`/goals/${goal.id}/messages`, {
        prompt: 'Hello Claude',
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as { session_id: string | null };
      expect(body).toHaveProperty('session_id');
    });

    it('returns 404 for nonexistent goal', async () => {
      const res = await postJson('/goals/nonexistent/messages', {
        prompt: 'Hello',
      });
      expect(res.status).toBe(404);
    });

    it('returns 400 for missing prompt', async () => {
      const goal = goalService.create({ title: 'Test', cwd: '/tmp' });
      const res = await postJson(`/goals/${goal.id}/messages`, {});
      expect(res.status).toBe(400);
    });

    it('returns 400 for empty prompt', async () => {
      const goal = goalService.create({ title: 'Test', cwd: '/tmp' });
      const res = await postJson(`/goals/${goal.id}/messages`, { prompt: '' });
      expect(res.status).toBe(400);
    });
  });

  // ── POST /api/goals/:id/interrupt ──────────────────────────────────────

  describe('POST /api/goals/:id/interrupt', () => {
    it('returns killed:false when no runner is live', async () => {
      const goal = goalService.create({ title: 'Interrupt', cwd: '/tmp' });

      const res = await fetch(url(`/goals/${goal.id}/interrupt`), {
        method: 'POST',
      });
      expect(res.status).toBe(200);

      // No PTY runner is registered for this goal, so nothing is killed.
      // (The runner-present killed:true path is covered by goals-interrupt.test.ts.)
      const body = (await res.json()) as { killed: boolean };
      expect(body.killed).toBe(false);
    });

    it('returns 404 for nonexistent goal', async () => {
      const res = await fetch(url('/goals/nonexistent/interrupt'), {
        method: 'POST',
      });
      expect(res.status).toBe(404);
    });
  });

  // ── POST /api/goals/:id/adopt-session ──────────────────────────────────

  describe('POST /api/goals/:id/adopt-session', () => {
    it('adopts a session into a goal', async () => {
      const goal = goalService.create({ title: 'Adopt', cwd: '/tmp' });

      // Create an external session to adopt
      db.prepare(
        `INSERT INTO sessions (id, goal_id, origin, cwd, started_at)
         VALUES (?, NULL, 'external', '/tmp', ?)`,
      ).run('ext-sess-1', Date.now());

      const res = await postJson(`/goals/${goal.id}/adopt-session`, {
        session_id: 'ext-sess-1',
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as Goal;
      expect(body.current_session_id).toBe('ext-sess-1');
    });

    it('returns 404 for nonexistent goal', async () => {
      const res = await postJson('/goals/nonexistent/adopt-session', {
        session_id: 'x',
      });
      expect(res.status).toBe(404);
    });

    it('returns 400 for missing session_id', async () => {
      const goal = goalService.create({ title: 'Test', cwd: '/tmp' });
      const res = await postJson(`/goals/${goal.id}/adopt-session`, {});
      expect(res.status).toBe(400);
    });
  });

  // ── Input validation ───────────────────────────────────────────────────

  describe('zod input validation', () => {
    it('rejects invalid permission_mode in POST', async () => {
      const res = await postJson('/goals', {
        title: 'Test',
        cwd: '/tmp',
        permission_mode: 'yolo',
      });
      expect(res.status).toBe(400);
    });

    it('rejects invalid status in PATCH', async () => {
      const goal = goalService.create({ title: 'Test', cwd: '/tmp' });
      const res = await patchJson(`/goals/${goal.id}`, { status: 'invalid' });
      expect(res.status).toBe(400);
    });

    it('rejects non-integer priority in PATCH', async () => {
      const goal = goalService.create({ title: 'Test', cwd: '/tmp' });
      const res = await patchJson(`/goals/${goal.id}`, { priority: 1.5 });
      expect(res.status).toBe(400);
    });
  });

  // ── POST /api/goals/create-and-instruct (without service) ─────────────

  describe('POST /api/goals/create-and-instruct (no inter-goal service)', () => {
    it('returns 501 when inter-goal messaging is not available', async () => {
      const sourceGoal = goalService.create({ title: 'Source', cwd: '/tmp' });
      const res = await postJson('/goals/create-and-instruct', {
        title: 'New Goal',
        cwd: '/tmp',
        instruction: 'Do something',
        source_goal_id: sourceGoal.id,
      });
      expect(res.status).toBe(501);
    });
  });
});

// ── POST /api/goals/create-and-instruct (with service) ──────────────────────

describe('Goals API routes (with inter-goal messaging)', () => {
  let db2: Database.Database;
  let goalService2: GoalService;
  let interGoalService: InterGoalMessageService;
  let server2: http.Server;
  let port2: number;

  function url2(path: string): string {
    return `http://127.0.0.1:${port2}/api${path}`;
  }

  async function postJson2(path: string, body: Record<string, unknown>): Promise<Response> {
    return fetch(url2(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  beforeEach(async () => {
    db2 = new Database(':memory:');
    db2.pragma('journal_mode = WAL');
    db2.pragma('foreign_keys = ON');
    runMigrations(db2);
    goalService2 = createGoalService(db2);
    interGoalService = createInterGoalMessageService(db2);

    const app = express();
    app.use(express.json());
    app.use('/api', createGoalsRouter(goalService2, undefined, interGoalService));
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err.message });
    });

    server2 = http.createServer(app);
    port2 = await new Promise<number>((resolve) => {
      server2.listen(0, () => {
        const addr = server2.address();
        if (addr && typeof addr === 'object') resolve(addr.port);
      });
    });
  });

  afterEach(() => {
    server2.close();
    db2.close();
  });

  describe('POST /api/goals/create-and-instruct', () => {
    it('creates a goal and sends instruction atomically', async () => {
      const sourceGoal = goalService2.create({ title: 'Orchestrator', cwd: '/tmp' });

      const res = await postJson2('/goals/create-and-instruct', {
        title: 'Worker Goal',
        cwd: '/home/user/project',
        instruction: 'Build the feature',
        source_goal_id: sourceGoal.id,
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        goal: Goal;
        instruction: InterGoalMessage;
        session_id: string | null;
      };

      expect(body.goal.title).toBe('Worker Goal');
      expect(body.goal.cwd).toBe('/home/user/project');
      expect(body.goal.status).toBe('planning');
      expect(body.instruction.from_goal_id).toBe(sourceGoal.id);
      expect(body.instruction.to_goal_id).toBe(body.goal.id);
      expect(body.instruction.content).toBe('Build the feature');
      expect(body.instruction.message_type).toBe('instruction');
      expect(body.instruction.status).toBe('pending');
      expect(body.session_id).toBeNull();
    });

    it('accepts optional fields (description, model, tags)', async () => {
      const sourceGoal = goalService2.create({ title: 'Orchestrator', cwd: '/tmp' });

      const res = await postJson2('/goals/create-and-instruct', {
        title: 'Full Goal',
        cwd: '/tmp',
        description: 'A detailed goal',
        model: 'opus',
        tags: ['test', 'demo'],
        instruction: 'Do the thing',
        source_goal_id: sourceGoal.id,
        spawn_session: false,
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        goal: Goal;
        instruction: InterGoalMessage;
        session_id: string | null;
      };

      expect(body.goal.description).toBe('A detailed goal');
      expect(body.goal.model).toBe('opus');
      expect(body.goal.tags).toEqual(['test', 'demo']);
    });

    it('returns 404 when source goal does not exist', async () => {
      const res = await postJson2('/goals/create-and-instruct', {
        title: 'Worker Goal',
        cwd: '/tmp',
        instruction: 'Build the feature',
        source_goal_id: 'nonexistent',
      });

      expect(res.status).toBe(404);
    });

    it('returns 400 for missing required fields', async () => {
      const sourceGoal = goalService2.create({ title: 'Orchestrator', cwd: '/tmp' });

      // Missing title
      const res1 = await postJson2('/goals/create-and-instruct', {
        cwd: '/tmp',
        instruction: 'Do it',
        source_goal_id: sourceGoal.id,
      });
      expect(res1.status).toBe(400);

      // Missing instruction
      const res2 = await postJson2('/goals/create-and-instruct', {
        title: 'Goal',
        cwd: '/tmp',
        source_goal_id: sourceGoal.id,
      });
      expect(res2.status).toBe(400);

      // Missing source_goal_id
      const res3 = await postJson2('/goals/create-and-instruct', {
        title: 'Goal',
        cwd: '/tmp',
        instruction: 'Do it',
      });
      expect(res3.status).toBe(400);
    });

    it('creates instruction that can be retrieved via GET /instructions', async () => {
      const sourceGoal = goalService2.create({ title: 'Orchestrator', cwd: '/tmp' });

      const createRes = await postJson2('/goals/create-and-instruct', {
        title: 'Worker',
        cwd: '/tmp',
        instruction: 'Check the logs',
        source_goal_id: sourceGoal.id,
      });

      expect(createRes.status).toBe(201);
      const body = (await createRes.json()) as {
        goal: Goal;
        instruction: InterGoalMessage;
        session_id: string | null;
      };

      // Verify the instruction is retrievable
      const instrRes = await fetch(url2(`/goals/${body.goal.id}/instructions`));
      expect(instrRes.status).toBe(200);
      const instructions = (await instrRes.json()) as InterGoalMessage[];
      expect(instructions).toHaveLength(1);
      expect(instructions[0]!.content).toBe('Check the logs');
    });
  });
});
