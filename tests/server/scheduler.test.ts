import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { Scheduler } from '../../server/scheduler';
import type { GoalCreator } from '../../server/scheduler';
import { ScheduledTaskService } from '../../server/services/scheduled-task-service';
import type { CreateScheduledTaskInput, GoalTemplate, CreateGoalInput } from '../../src/shared/types';

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
    title: 'Scheduled Goal',
    cwd: '/tmp/test',
    model: 'sonnet',
    initialPrompt: 'Run this',
    tags: ['scheduled'],
    ...overrides,
  };
}

function makeInput(overrides?: Partial<CreateScheduledTaskInput>): CreateScheduledTaskInput {
  return {
    name: 'Test Task',
    cron_expr: '* * * * *',
    goal_template_json: makeTemplate(),
    ...overrides,
  };
}

describe('Scheduler', () => {
  let db: Database.Database;
  let taskService: ScheduledTaskService;
  let mockCreateGoal: ReturnType<typeof vi.fn<GoalCreator>>;
  let scheduler: Scheduler;

  beforeEach(() => {
    db = createTestDb();
    taskService = new ScheduledTaskService(db);
    mockCreateGoal = vi.fn<GoalCreator>(() => ({ id: 'goal-123' }));
    scheduler = new Scheduler(taskService, mockCreateGoal);
  });

  afterEach(() => {
    scheduler.stop();
    db.close();
  });

  describe('start / stop', () => {
    it('registers cron jobs for all enabled tasks on start', () => {
      taskService.create(makeInput({ name: 'Enabled1' }));
      taskService.create(makeInput({ name: 'Enabled2' }));
      taskService.create(makeInput({ name: 'Disabled', enabled: false }));

      scheduler.start();

      // 2 enabled tasks should be registered, 1 disabled should not
      expect(scheduler.registeredCount).toBe(2);
    });

    it('unregisters all jobs on stop', () => {
      taskService.create(makeInput());
      scheduler.start();
      expect(scheduler.registeredCount).toBe(1);

      scheduler.stop();
      expect(scheduler.registeredCount).toBe(0);
    });

    it('start with no tasks registers zero jobs', () => {
      scheduler.start();
      expect(scheduler.registeredCount).toBe(0);
    });
  });

  describe('refresh', () => {
    it('registers a newly created enabled task', () => {
      scheduler.start();
      const task = taskService.create(makeInput());

      scheduler.refresh(task.id);
      expect(scheduler.isRegistered(task.id)).toBe(true);
    });

    it('unregisters a task when it is disabled', () => {
      const task = taskService.create(makeInput());
      scheduler.start();
      expect(scheduler.isRegistered(task.id)).toBe(true);

      taskService.update(task.id, { enabled: false });
      scheduler.refresh(task.id);
      expect(scheduler.isRegistered(task.id)).toBe(false);
    });

    it('re-enables a previously disabled task', () => {
      const task = taskService.create(makeInput({ enabled: false }));
      scheduler.start();
      expect(scheduler.isRegistered(task.id)).toBe(false);

      taskService.update(task.id, { enabled: true });
      scheduler.refresh(task.id);
      expect(scheduler.isRegistered(task.id)).toBe(true);
    });

    it('unregisters a deleted task', () => {
      const task = taskService.create(makeInput());
      scheduler.start();
      expect(scheduler.isRegistered(task.id)).toBe(true);

      taskService.delete(task.id);
      scheduler.refresh(task.id);
      expect(scheduler.isRegistered(task.id)).toBe(false);
    });

    it('replaces the cron job when cron_expr changes', () => {
      const task = taskService.create(makeInput({ cron_expr: '*/5 * * * *' }));
      scheduler.start();
      expect(scheduler.isRegistered(task.id)).toBe(true);

      taskService.update(task.id, { cron_expr: '*/10 * * * *' });
      scheduler.refresh(task.id);
      expect(scheduler.isRegistered(task.id)).toBe(true);
    });

    it('is safe to call for a nonexistent task ID', () => {
      scheduler.start();
      // Should not throw
      scheduler.refresh('nonexistent-id');
      expect(scheduler.registeredCount).toBe(0);
    });
  });

  describe('runNow', () => {
    it('creates a goal from the task template immediately', () => {
      const task = taskService.create(
        makeInput({
          name: 'Run Now Test',
          goal_template_json: makeTemplate({ title: 'Immediate Goal' }),
        }),
      );

      const result = scheduler.runNow(task.id);

      expect(result.goal_id).toBe('goal-123');
      expect(mockCreateGoal).toHaveBeenCalledOnce();

      // Verify the goal input
      const callArg = mockCreateGoal.mock.calls[0][0] as CreateGoalInput;
      expect(callArg.title).toContain('Immediate Goal');
      expect(callArg.title).toMatch(/\(\d{4}-\d{2}-\d{2}T/); // has ISO timestamp
      expect(callArg.cwd).toBe('/tmp/test');
      expect(callArg.model).toBe('sonnet');
      expect(callArg.tags).toEqual(['scheduled']);
    });

    it('updates last_run_at on the task', () => {
      const task = taskService.create(makeInput());
      expect(task.last_run_at).toBeNull();

      const before = Date.now();
      scheduler.runNow(task.id);
      const after = Date.now();

      const updated = taskService.get(task.id);
      expect(updated!.last_run_at).toBeGreaterThanOrEqual(before);
      expect(updated!.last_run_at).toBeLessThanOrEqual(after);
    });

    it('throws for a nonexistent task ID', () => {
      expect(() => scheduler.runNow('nonexistent')).toThrow('not found');
    });

    it('works even when the task is disabled', () => {
      const task = taskService.create(makeInput({ enabled: false }));

      // runNow fires regardless of enabled status
      const result = scheduler.runNow(task.id);
      expect(result.goal_id).toBe('goal-123');
      expect(mockCreateGoal).toHaveBeenCalledOnce();
    });
  });

  describe('cron firing', () => {
    it('calls createGoal when a cron job fires', async () => {
      // Use per-second cron (6-field syntax supported by node-cron v4)
      const task = taskService.create(
        makeInput({
          cron_expr: '* * * * * *',
          goal_template_json: makeTemplate({ title: 'Cron Fire Test' }),
        }),
      );

      scheduler.start();
      scheduler.refresh(task.id);

      // Wait for at least one fire
      await new Promise((resolve) => setTimeout(resolve, 1500));

      expect(mockCreateGoal).toHaveBeenCalled();
      const callArg = mockCreateGoal.mock.calls[0][0] as CreateGoalInput;
      expect(callArg.title).toContain('Cron Fire Test');
    }, 5000);

    it('does not fire for disabled tasks', async () => {
      taskService.create(
        makeInput({
          cron_expr: '* * * * * *',
          enabled: false,
        }),
      );

      scheduler.start();

      await new Promise((resolve) => setTimeout(resolve, 1500));

      expect(mockCreateGoal).not.toHaveBeenCalled();
    }, 5000);
  });
});
