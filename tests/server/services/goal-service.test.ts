import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';
import {
  createGoalService,
  GoalNotFoundError,
  InvalidTransitionError,
} from '../../../server/services/goal-service';
import type { GoalService } from '../../../server/services/goal-service';
import type { CreateGoalInput, PlanJson } from '../../../src/shared/types';

// Mock broadcast to capture WS events
vi.mock('../../../server/ws', () => ({
  broadcast: vi.fn(),
}));

// Mock logger to suppress output during tests
vi.mock('../../../server/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { broadcast } from '../../../server/ws';

const mockedBroadcast = vi.mocked(broadcast);

let db: Database.Database;
let goalService: GoalService;

function makeInput(overrides?: Partial<CreateGoalInput>): CreateGoalInput {
  return {
    title: 'Test Goal',
    cwd: '/tmp/test',
    ...overrides,
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  goalService = createGoalService(db);
  mockedBroadcast.mockClear();
});

afterEach(() => {
  db.close();
});

describe('GoalService', () => {
  // ── create ──────────────────────────────────────────────────────────────

  describe('create', () => {
    it('creates a goal with default values', () => {
      const goal = goalService.create(makeInput());

      expect(goal.id).toBeDefined();
      expect(goal.title).toBe('Test Goal');
      expect(goal.cwd).toBe('/tmp/test');
      expect(goal.status).toBe('planning');
      expect(goal.priority).toBe(0);
      expect(goal.tags).toEqual([]);
      expect(goal.current_session_id).toBeNull();
      expect(goal.model).toBeNull();
      expect(goal.permission_mode).toBe('supervised');
      expect(goal.plan_json).toBeNull();
      expect(goal.kanban_order).toBe(1);
      expect(goal.created_at).toBeGreaterThan(0);
      expect(goal.updated_at).toBeGreaterThan(0);
      expect(goal.completed_at).toBeNull();
    });

    it('creates a goal with optional fields', () => {
      const goal = goalService.create(
        makeInput({
          description: 'A test description',
          model: 'opus',
          permission_mode: 'autonomous',
          tags: ['frontend', 'urgent'],
        }),
      );

      expect(goal.description).toBe('A test description');
      expect(goal.model).toBe('opus');
      expect(goal.permission_mode).toBe('autonomous');
      expect(goal.tags).toEqual(['frontend', 'urgent']);
    });

    it('assigns incrementing kanban_order within planning column', () => {
      const g1 = goalService.create(makeInput({ title: 'Goal 1' }));
      const g2 = goalService.create(makeInput({ title: 'Goal 2' }));
      const g3 = goalService.create(makeInput({ title: 'Goal 3' }));

      expect(g1.kanban_order).toBe(1);
      expect(g2.kanban_order).toBe(2);
      expect(g3.kanban_order).toBe(3);
    });

    it('broadcasts goal:created event', () => {
      const goal = goalService.create(makeInput());

      expect(mockedBroadcast).toHaveBeenCalledWith({
        type: 'goal:created',
        goal,
      });
    });
  });

  // ── get ─────────────────────────────────────────────────────────────────

  describe('get', () => {
    it('returns a goal by ID', () => {
      const created = goalService.create(makeInput());
      const fetched = goalService.get(created.id);

      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.title).toBe(created.title);
    });

    it('returns null for nonexistent ID', () => {
      const result = goalService.get('nonexistent-id');
      expect(result).toBeNull();
    });
  });

  // ── getDetail ───────────────────────────────────────────────────────────

  describe('getDetail', () => {
    it('returns goal detail with empty messages when no sessions exist', () => {
      const created = goalService.create(makeInput());
      const detail = goalService.getDetail(created.id);

      expect(detail).not.toBeNull();
      expect(detail!.goal.id).toBe(created.id);
      expect(detail!.messages).toEqual([]);
      expect(detail!.plan).toBeNull();
    });

    it('returns null for nonexistent goal', () => {
      const detail = goalService.getDetail('nonexistent-id');
      expect(detail).toBeNull();
    });

    it('includes plan_json when set', () => {
      const created = goalService.create(makeInput());
      const plan: PlanJson = {
        todos: [{ content: 'Step 1', status: 'pending', priority: 1, children: [] }],
        raw_content: '- [ ] Step 1',
      };
      goalService.setPlan(created.id, plan);

      const detail = goalService.getDetail(created.id);
      expect(detail!.plan).toEqual(plan);
    });
  });

  // ── list ────────────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns all goals when no filters', () => {
      goalService.create(makeInput({ title: 'A' }));
      goalService.create(makeInput({ title: 'B' }));

      const goals = goalService.list();
      expect(goals).toHaveLength(2);
    });

    it('filters by status', () => {
      goalService.create(makeInput({ title: 'A' }));
      const g2 = goalService.create(makeInput({ title: 'B' }));
      goalService.update(g2.id, { status: 'active' });

      const planning = goalService.list({ status: 'planning' });
      expect(planning).toHaveLength(1);
      expect(planning[0]!.title).toBe('A');

      const active = goalService.list({ status: 'active' });
      expect(active).toHaveLength(1);
      expect(active[0]!.title).toBe('B');
    });

    it('filters by tag', () => {
      goalService.create(makeInput({ title: 'Tagged', tags: ['bug'] }));
      goalService.create(makeInput({ title: 'Untagged' }));

      const bugs = goalService.list({ tag: 'bug' });
      expect(bugs).toHaveLength(1);
      expect(bugs[0]!.title).toBe('Tagged');
    });

    it('filters by both status and tag', () => {
      goalService.create(makeInput({ title: 'Match', tags: ['feat'] }));
      const g2 = goalService.create(makeInput({ title: 'Wrong status', tags: ['feat'] }));
      goalService.update(g2.id, { status: 'active' });
      goalService.create(makeInput({ title: 'Wrong tag', tags: ['bug'] }));

      const results = goalService.list({ status: 'planning', tag: 'feat' });
      expect(results).toHaveLength(1);
      expect(results[0]!.title).toBe('Match');
    });

    it('returns goals ordered by kanban_order', () => {
      const g1 = goalService.create(makeInput({ title: 'First' }));
      const g2 = goalService.create(makeInput({ title: 'Second' }));
      const g3 = goalService.create(makeInput({ title: 'Third' }));

      // Reorder: put g3 first
      goalService.update(g3.id, { kanban_order: 0.5 });

      const goals = goalService.list({ status: 'planning' });
      expect(goals[0]!.id).toBe(g3.id);
      expect(goals[1]!.id).toBe(g1.id);
      expect(goals[2]!.id).toBe(g2.id);
    });

    it('returns empty array when no goals match', () => {
      const goals = goalService.list({ status: 'complete' });
      expect(goals).toEqual([]);
    });
  });

  // ── update ──────────────────────────────────────────────────────────────

  describe('update', () => {
    it('updates title', () => {
      const goal = goalService.create(makeInput());
      const updated = goalService.update(goal.id, { title: 'New Title' });

      expect(updated.title).toBe('New Title');
      expect(updated.updated_at).toBeGreaterThanOrEqual(goal.updated_at);
    });

    it('updates description to a value', () => {
      const goal = goalService.create(makeInput());
      const updated = goalService.update(goal.id, { description: 'Added' });
      expect(updated.description).toBe('Added');
    });

    it('clears description with null', () => {
      const goal = goalService.create(makeInput({ description: 'Has desc' }));
      const updated = goalService.update(goal.id, { description: null });
      expect(updated.description).toBeNull();
    });

    it('updates kanban_order to float for insertion', () => {
      const g1 = goalService.create(makeInput({ title: 'A' }));
      goalService.create(makeInput({ title: 'B' }));
      const g3 = goalService.create(makeInput({ title: 'C' }));

      // Insert g3 between g1 and g2 using float
      goalService.update(g3.id, { kanban_order: 1.5 });

      const goals = goalService.list({ status: 'planning' });
      expect(goals[0]!.id).toBe(g1.id);
      expect(goals[1]!.id).toBe(g3.id);
      expect(goals[1]!.kanban_order).toBe(1.5);
    });

    it('updates tags', () => {
      const goal = goalService.create(makeInput());
      const updated = goalService.update(goal.id, { tags: ['x', 'y'] });
      expect(updated.tags).toEqual(['x', 'y']);
    });

    it('updates model', () => {
      const goal = goalService.create(makeInput());
      const updated = goalService.update(goal.id, { model: 'haiku' });
      expect(updated.model).toBe('haiku');
    });

    it('clears model with null', () => {
      const goal = goalService.create(makeInput({ model: 'opus' }));
      const updated = goalService.update(goal.id, { model: null });
      expect(updated.model).toBeNull();
    });

    it('updates permission_mode', () => {
      const goal = goalService.create(makeInput());
      const updated = goalService.update(goal.id, { permission_mode: 'autonomous' });
      expect(updated.permission_mode).toBe('autonomous');
    });

    it('updates priority', () => {
      const goal = goalService.create(makeInput());
      const updated = goalService.update(goal.id, { priority: 5 });
      expect(updated.priority).toBe(5);
    });

    it('broadcasts goal:updated event', () => {
      const goal = goalService.create(makeInput());
      mockedBroadcast.mockClear();

      goalService.update(goal.id, { title: 'Updated' });

      expect(mockedBroadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'goal:updated' }),
      );
    });

    it('throws GoalNotFoundError for nonexistent ID', () => {
      expect(() => goalService.update('bad-id', { title: 'X' })).toThrow(
        GoalNotFoundError,
      );
    });
  });

  // ── Status transitions ─────────────────────────────────────────────────

  describe('status transitions', () => {
    it('planning → active is valid', () => {
      const goal = goalService.create(makeInput());
      const updated = goalService.update(goal.id, { status: 'active' });
      expect(updated.status).toBe('active');
    });

    it('active → waiting is valid', () => {
      const goal = goalService.create(makeInput());
      goalService.update(goal.id, { status: 'active' });
      const updated = goalService.update(goal.id, { status: 'waiting' });
      expect(updated.status).toBe('waiting');
    });

    it('waiting → active is valid', () => {
      const goal = goalService.create(makeInput());
      goalService.update(goal.id, { status: 'active' });
      goalService.update(goal.id, { status: 'waiting' });
      const updated = goalService.update(goal.id, { status: 'active' });
      expect(updated.status).toBe('active');
    });

    it('active → complete sets completed_at', () => {
      const goal = goalService.create(makeInput());
      goalService.update(goal.id, { status: 'active' });
      const updated = goalService.update(goal.id, { status: 'complete' });
      expect(updated.status).toBe('complete');
      expect(updated.completed_at).toBeGreaterThan(0);
    });

    it('complete → active is valid (reopen)', () => {
      const goal = goalService.create(makeInput());
      goalService.update(goal.id, { status: 'active' });
      goalService.update(goal.id, { status: 'complete' });
      const updated = goalService.update(goal.id, { status: 'active' });
      expect(updated.status).toBe('active');
    });

    it('archived → active throws InvalidTransitionError', () => {
      const goal = goalService.create(makeInput());
      goalService.update(goal.id, { status: 'archived' });

      expect(() => goalService.update(goal.id, { status: 'active' })).toThrow(
        InvalidTransitionError,
      );
    });

    it('planning → waiting throws InvalidTransitionError', () => {
      const goal = goalService.create(makeInput());

      expect(() => goalService.update(goal.id, { status: 'waiting' })).toThrow(
        InvalidTransitionError,
      );
    });

    it('broadcasts goal:status event on status change', () => {
      const goal = goalService.create(makeInput());
      mockedBroadcast.mockClear();

      goalService.update(goal.id, { status: 'active' });

      const statusEvent = mockedBroadcast.mock.calls.find(
        (c) => (c[0] as Record<string, unknown>).type === 'goal:status',
      );
      expect(statusEvent).toBeDefined();
      expect(statusEvent![0]).toEqual(
        expect.objectContaining({
          type: 'goal:status',
          id: goal.id,
          status: 'active',
        }),
      );
    });
  });

  // ── archive ─────────────────────────────────────────────────────────────

  describe('archive', () => {
    it('archives a planning goal', () => {
      const goal = goalService.create(makeInput());
      goalService.archive(goal.id);

      const archived = goalService.get(goal.id);
      expect(archived!.status).toBe('archived');
      expect(archived!.completed_at).toBeGreaterThan(0);
    });

    it('archives an active goal', () => {
      const goal = goalService.create(makeInput());
      goalService.update(goal.id, { status: 'active' });
      goalService.archive(goal.id);

      const archived = goalService.get(goal.id);
      expect(archived!.status).toBe('archived');
    });

    it('throws GoalNotFoundError for nonexistent ID', () => {
      expect(() => goalService.archive('bad-id')).toThrow(GoalNotFoundError);
    });

    it('throws InvalidTransitionError for already-archived goal', () => {
      const goal = goalService.create(makeInput());
      goalService.archive(goal.id);

      expect(() => goalService.archive(goal.id)).toThrow(InvalidTransitionError);
    });

    it('broadcasts goal:updated and goal:status events', () => {
      const goal = goalService.create(makeInput());
      mockedBroadcast.mockClear();

      goalService.archive(goal.id);

      const types = mockedBroadcast.mock.calls.map(
        (c) => (c[0] as Record<string, unknown>).type,
      );
      expect(types).toContain('goal:updated');
      expect(types).toContain('goal:status');
    });
  });

  // ── setCurrentSession ──────────────────────────────────────────────────

  describe('setCurrentSession', () => {
    it('sets the current session ID', () => {
      const goal = goalService.create(makeInput());
      goalService.setCurrentSession(goal.id, 'session-123');

      const updated = goalService.get(goal.id);
      expect(updated!.current_session_id).toBe('session-123');
    });

    it('clears the current session ID with null', () => {
      const goal = goalService.create(makeInput());
      goalService.setCurrentSession(goal.id, 'session-123');
      goalService.setCurrentSession(goal.id, null);

      const updated = goalService.get(goal.id);
      expect(updated!.current_session_id).toBeNull();
    });

    it('broadcasts goal:status event', () => {
      const goal = goalService.create(makeInput());
      mockedBroadcast.mockClear();

      goalService.setCurrentSession(goal.id, 'session-456');

      expect(mockedBroadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'goal:status',
          id: goal.id,
          current_session_id: 'session-456',
        }),
      );
    });

    it('throws GoalNotFoundError for nonexistent ID', () => {
      expect(() => goalService.setCurrentSession('bad', 'x')).toThrow(
        GoalNotFoundError,
      );
    });
  });

  // ── setPlan ─────────────────────────────────────────────────────────────

  describe('setPlan', () => {
    const plan: PlanJson = {
      todos: [
        {
          content: 'Build feature',
          status: 'pending',
          priority: 1,
          children: [
            { content: 'Write tests', status: 'pending', priority: 1, children: [] },
          ],
        },
      ],
      raw_content: '- [ ] Build feature\n  - [ ] Write tests',
    };

    it('stores plan_json in the database', () => {
      const goal = goalService.create(makeInput());
      goalService.setPlan(goal.id, plan);

      const updated = goalService.get(goal.id);
      expect(updated!.plan_json).toEqual(plan);
    });

    it('broadcasts goal:plan-updated event with full plan', () => {
      const goal = goalService.create(makeInput());
      mockedBroadcast.mockClear();

      goalService.setPlan(goal.id, plan);

      expect(mockedBroadcast).toHaveBeenCalledWith({
        type: 'goal:plan-updated',
        id: goal.id,
        plan_json: plan,
      });
    });

    it('throws GoalNotFoundError for nonexistent ID', () => {
      expect(() => goalService.setPlan('bad', plan)).toThrow(GoalNotFoundError);
    });

    it('overwrites existing plan', () => {
      const goal = goalService.create(makeInput());
      goalService.setPlan(goal.id, plan);

      const newPlan: PlanJson = {
        todos: [{ content: 'Revised', status: 'completed', priority: 1, children: [] }],
        raw_content: '- [x] Revised',
      };
      goalService.setPlan(goal.id, newPlan);

      const updated = goalService.get(goal.id);
      expect(updated!.plan_json).toEqual(newPlan);
    });
  });

  // ── adoptSession ────────────────────────────────────────────────────────

  describe('adoptSession', () => {
    it('updates session goal_id and sets current_session_id on goal', () => {
      const goal = goalService.create(makeInput());

      // Insert a session row for adoption
      db.prepare(
        `INSERT INTO sessions (id, goal_id, origin, cwd, started_at)
         VALUES (?, NULL, 'external', '/tmp', ?)`,
      ).run('ext-session-1', Date.now());

      const updated = goalService.adoptSession(goal.id, 'ext-session-1');

      expect(updated.current_session_id).toBe('ext-session-1');

      // Verify session row was updated
      const session = db
        .prepare('SELECT goal_id FROM sessions WHERE id = ?')
        .get('ext-session-1') as { goal_id: string | null };
      expect(session.goal_id).toBe(goal.id);
    });

    it('broadcasts goal:updated event', () => {
      const goal = goalService.create(makeInput());
      db.prepare(
        `INSERT INTO sessions (id, goal_id, origin, cwd, started_at)
         VALUES (?, NULL, 'external', '/tmp', ?)`,
      ).run('ext-session-2', Date.now());
      mockedBroadcast.mockClear();

      goalService.adoptSession(goal.id, 'ext-session-2');

      expect(mockedBroadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'goal:updated' }),
      );
    });

    it('throws GoalNotFoundError for nonexistent goal', () => {
      expect(() => goalService.adoptSession('bad', 'session')).toThrow(
        GoalNotFoundError,
      );
    });
  });

  // ── kanban_order float insertion ────────────────────────────────────────

  describe('kanban_order float insertion', () => {
    it('inserting 2.5 places goal between 2 and 3 without renumbering', () => {
      const g1 = goalService.create(makeInput({ title: 'A' })); // order 1
      const g2 = goalService.create(makeInput({ title: 'B' })); // order 2
      const g3 = goalService.create(makeInput({ title: 'C' })); // order 3

      // Move g3 between g2 and original position
      goalService.update(g3.id, { kanban_order: 2.5 });

      const goals = goalService.list({ status: 'planning' });
      expect(goals.map((g) => g.id)).toEqual([g1.id, g2.id, g3.id]);
      expect(goals.map((g) => g.kanban_order)).toEqual([1, 2, 2.5]);
    });
  });
});
