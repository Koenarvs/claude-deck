import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createScheduledRouter } from '../../../server/routes/scheduled';
import { ScheduledTaskService } from '../../../server/services/scheduled-task-service';
import { Scheduler } from '../../../server/scheduler';
import type { GoalTemplate, ScheduledTask } from '../../../src/shared/types';

const MIGRATION_PATH = path.resolve(
  process.cwd(),
  'server',
  'db',
  'migrations',
  '001_init.sql',
);

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(MIGRATION_PATH, 'utf-8'));
  return db;
}

function makeTemplate(overrides?: Partial<GoalTemplate>): GoalTemplate {
  return {
    title: 'Route Test Goal',
    cwd: '/tmp/route-test',
    model: 'sonnet',
    initialPrompt: 'Run route test',
    tags: ['route-test'],
    ...overrides,
  };
}

describe('Scheduled Tasks Routes', () => {
  let db: Database.Database;
  let taskService: ScheduledTaskService;
  let scheduler: Scheduler;
  let app: express.Express;
  let server: http.Server;
  let port: number;
  let goalIdCounter: number;

  beforeEach(async () => {
    db = createTestDb();
    taskService = new ScheduledTaskService(db);

    goalIdCounter = 0;
    const mockCreateGoal = () => {
      goalIdCounter += 1;
      return { id: `goal-${goalIdCounter}` };
    };

    scheduler = new Scheduler(taskService, mockCreateGoal);

    app = express();
    app.use(express.json());
    app.use('/api', createScheduledRouter(taskService, scheduler));

    // Start server on random port
    port = await new Promise<number>((resolve) => {
      server = http.createServer(app);
      server.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          resolve(addr.port);
        }
      });
    });
  });

  afterEach(() => {
    scheduler.stop();
    server.close();
    db.close();
  });

  function url(p: string): string {
    return `http://127.0.0.1:${port}${p}`;
  }

  async function createTask(overrides?: Record<string, unknown>): Promise<ScheduledTask> {
    const body = {
      name: 'Test Task',
      cron_expr: '*/5 * * * *',
      goal_template_json: makeTemplate(),
      ...overrides,
    };
    const res = await fetch(url('/api/scheduled-tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await res.json()) as ScheduledTask;
  }

  describe('POST /api/scheduled-tasks', () => {
    it('creates a task and returns 201', async () => {
      const res = await fetch(url('/api/scheduled-tasks'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'New Task',
          cron_expr: '*/10 * * * *',
          goal_template_json: makeTemplate(),
        }),
      });

      expect(res.status).toBe(201);
      const task = (await res.json()) as ScheduledTask;
      expect(task.name).toBe('New Task');
      expect(task.cron_expr).toBe('*/10 * * * *');
      expect(task.enabled).toBe(true);
      expect(task.id).toBeTruthy();
    });

    it('returns 400 for invalid cron expression', async () => {
      const res = await fetch(url('/api/scheduled-tasks'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Bad Cron',
          cron_expr: 'not a cron',
          goal_template_json: makeTemplate(),
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toContain('Invalid cron');
    });

    it('returns 400 for missing required fields', async () => {
      const res = await fetch(url('/api/scheduled-tasks'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Missing Fields' }),
      });

      expect(res.status).toBe(400);
    });

    it('registers the task in the scheduler', async () => {
      const task = await createTask();
      expect(scheduler.isRegistered(task.id)).toBe(true);
    });
  });

  describe('GET /api/scheduled-tasks', () => {
    it('returns an empty array when no tasks exist', async () => {
      const res = await fetch(url('/api/scheduled-tasks'));
      expect(res.status).toBe(200);
      const tasks = (await res.json()) as ScheduledTask[];
      expect(tasks).toEqual([]);
    });

    it('returns all tasks', async () => {
      await createTask({ name: 'Task A' });
      await createTask({ name: 'Task B' });

      const res = await fetch(url('/api/scheduled-tasks'));
      const tasks = (await res.json()) as ScheduledTask[];
      expect(tasks).toHaveLength(2);
    });
  });

  describe('PATCH /api/scheduled-tasks/:id', () => {
    it('updates the task name', async () => {
      const task = await createTask({ name: 'Original' });

      const res = await fetch(url(`/api/scheduled-tasks/${task.id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      });

      expect(res.status).toBe(200);
      const updated = (await res.json()) as ScheduledTask;
      expect(updated.name).toBe('Updated');
    });

    it('returns 400 for invalid cron on update', async () => {
      const task = await createTask();

      const res = await fetch(url(`/api/scheduled-tasks/${task.id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cron_expr: 'garbage' }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 404 for nonexistent ID', async () => {
      const res = await fetch(url('/api/scheduled-tasks/nonexistent'), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Nope' }),
      });

      expect(res.status).toBe(404);
    });

    it('disabling a task unregisters it from the scheduler', async () => {
      const task = await createTask();
      expect(scheduler.isRegistered(task.id)).toBe(true);

      await fetch(url(`/api/scheduled-tasks/${task.id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });

      expect(scheduler.isRegistered(task.id)).toBe(false);
    });
  });

  describe('DELETE /api/scheduled-tasks/:id', () => {
    it('deletes a task and returns { deleted: true }', async () => {
      const task = await createTask();

      const res = await fetch(url(`/api/scheduled-tasks/${task.id}`), {
        method: 'DELETE',
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.deleted).toBe(true);
    });

    it('unregisters the task from the scheduler', async () => {
      const task = await createTask();
      expect(scheduler.isRegistered(task.id)).toBe(true);

      await fetch(url(`/api/scheduled-tasks/${task.id}`), { method: 'DELETE' });

      expect(scheduler.isRegistered(task.id)).toBe(false);
    });

    it('returns 404 for nonexistent ID', async () => {
      const res = await fetch(url('/api/scheduled-tasks/nonexistent'), {
        method: 'DELETE',
      });

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/scheduled-tasks/:id/run-now', () => {
    it('fires the task immediately and returns { goal_id }', async () => {
      const task = await createTask();

      const res = await fetch(url(`/api/scheduled-tasks/${task.id}/run-now`), {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.goal_id).toBeTruthy();
    });

    it('updates last_run_at on the task', async () => {
      const task = await createTask();
      expect(task.last_run_at).toBeNull();

      const before = Date.now();
      await fetch(url(`/api/scheduled-tasks/${task.id}/run-now`), { method: 'POST' });

      const updated = taskService.get(task.id);
      expect(updated!.last_run_at).toBeGreaterThanOrEqual(before);
    });

    it('returns 404 for nonexistent ID', async () => {
      const res = await fetch(url('/api/scheduled-tasks/nonexistent/run-now'), {
        method: 'POST',
      });

      expect(res.status).toBe(404);
    });
  });
});
