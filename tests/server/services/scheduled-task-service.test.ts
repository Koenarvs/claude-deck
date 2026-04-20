import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { ScheduledTaskService } from '../../../server/services/scheduled-task-service';
import type { CreateScheduledTaskInput, GoalTemplate } from '../../../src/shared/types';

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
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf-8');
  db.exec(sql);
  return db;
}

function makeTemplate(overrides?: Partial<GoalTemplate>): GoalTemplate {
  return {
    title: 'Test Goal',
    cwd: '/tmp/test',
    model: 'sonnet',
    initialPrompt: 'Do the thing',
    tags: ['test'],
    ...overrides,
  };
}

function makeInput(overrides?: Partial<CreateScheduledTaskInput>): CreateScheduledTaskInput {
  return {
    name: 'Test Task',
    cron_expr: '*/5 * * * *',
    goal_template_json: makeTemplate(),
    ...overrides,
  };
}

describe('ScheduledTaskService', () => {
  let db: Database.Database;
  let service: ScheduledTaskService;

  beforeEach(() => {
    db = createTestDb();
    service = new ScheduledTaskService(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('create', () => {
    it('creates a scheduled task with correct fields', () => {
      const input = makeInput({ name: 'My Scheduled Task' });
      const task = service.create(input);

      expect(task.id).toBeTruthy();
      expect(task.name).toBe('My Scheduled Task');
      expect(task.cron_expr).toBe('*/5 * * * *');
      expect(task.enabled).toBe(true);
      expect(task.last_run_at).toBeNull();
      expect(task.next_run_at).toBeNull();
      expect(typeof task.created_at).toBe('number');
    });

    it('serializes goal_template_json as a JSON string', () => {
      const template = makeTemplate({ title: 'Scheduled Goal' });
      const task = service.create(makeInput({ goal_template_json: template }));

      const parsed = JSON.parse(task.goal_template_json) as GoalTemplate;
      expect(parsed.title).toBe('Scheduled Goal');
      expect(parsed.cwd).toBe('/tmp/test');
      expect(parsed.model).toBe('sonnet');
    });

    it('respects enabled=false on create', () => {
      const task = service.create(makeInput({ enabled: false }));
      expect(task.enabled).toBe(false);
    });

    it('defaults enabled to true when not specified', () => {
      const task = service.create(makeInput());
      expect(task.enabled).toBe(true);
    });
  });

  describe('get', () => {
    it('returns a task by ID', () => {
      const created = service.create(makeInput({ name: 'Lookup Test' }));
      const found = service.get(created.id);

      expect(found).not.toBeNull();
      expect(found!.name).toBe('Lookup Test');
    });

    it('returns null for a nonexistent ID', () => {
      const found = service.get('nonexistent-id');
      expect(found).toBeNull();
    });
  });

  describe('list', () => {
    it('returns all tasks', () => {
      service.create(makeInput({ name: 'First' }));
      service.create(makeInput({ name: 'Second' }));
      service.create(makeInput({ name: 'Third' }));

      const tasks = service.list();
      expect(tasks).toHaveLength(3);
      const names = tasks.map((t) => t.name);
      expect(names).toContain('First');
      expect(names).toContain('Second');
      expect(names).toContain('Third');
    });

    it('returns an empty array when no tasks exist', () => {
      const tasks = service.list();
      expect(tasks).toEqual([]);
    });
  });

  describe('update', () => {
    it('updates the name', () => {
      const task = service.create(makeInput({ name: 'Original' }));
      const updated = service.update(task.id, { name: 'Renamed' });

      expect(updated).not.toBeNull();
      expect(updated!.name).toBe('Renamed');
      expect(updated!.cron_expr).toBe('*/5 * * * *'); // unchanged
    });

    it('updates the cron expression', () => {
      const task = service.create(makeInput());
      const updated = service.update(task.id, { cron_expr: '0 * * * *' });

      expect(updated!.cron_expr).toBe('0 * * * *');
    });

    it('updates enabled to false', () => {
      const task = service.create(makeInput());
      const updated = service.update(task.id, { enabled: false });

      expect(updated!.enabled).toBe(false);
    });

    it('updates goal_template_json', () => {
      const task = service.create(makeInput());
      const newTemplate = makeTemplate({ title: 'Updated Goal Title' });
      const updated = service.update(task.id, { goal_template_json: newTemplate });

      const parsed = JSON.parse(updated!.goal_template_json) as GoalTemplate;
      expect(parsed.title).toBe('Updated Goal Title');
    });

    it('returns the existing task unchanged when no fields are provided', () => {
      const task = service.create(makeInput({ name: 'No Change' }));
      const updated = service.update(task.id, {});

      expect(updated!.name).toBe('No Change');
    });

    it('returns null for a nonexistent ID', () => {
      const updated = service.update('nonexistent', { name: 'Nope' });
      expect(updated).toBeNull();
    });
  });

  describe('delete', () => {
    it('removes a task and returns true', () => {
      const task = service.create(makeInput());
      const result = service.delete(task.id);

      expect(result).toBe(true);
      expect(service.get(task.id)).toBeNull();
    });

    it('returns false for a nonexistent ID', () => {
      const result = service.delete('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('recordRun', () => {
    it('updates last_run_at and next_run_at', () => {
      const task = service.create(makeInput());
      const now = Date.now();
      const next = now + 60000;

      service.recordRun(task.id, now, next);
      const updated = service.get(task.id);

      expect(updated!.last_run_at).toBe(now);
      expect(updated!.next_run_at).toBe(next);
    });

    it('accepts null for next_run_at', () => {
      const task = service.create(makeInput());
      service.recordRun(task.id, Date.now(), null);
      const updated = service.get(task.id);

      expect(updated!.next_run_at).toBeNull();
    });
  });

  describe('parseTemplate', () => {
    it('deserializes goal_template_json into a GoalTemplate', () => {
      const template = makeTemplate({ title: 'Parse Test', model: 'opus' });
      const task = service.create(makeInput({ goal_template_json: template }));

      const parsed = service.parseTemplate(task);
      expect(parsed.title).toBe('Parse Test');
      expect(parsed.cwd).toBe('/tmp/test');
      expect(parsed.model).toBe('opus');
      expect(parsed.initialPrompt).toBe('Do the thing');
      expect(parsed.tags).toEqual(['test']);
    });
  });
});
