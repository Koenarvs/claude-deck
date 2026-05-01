import { describe, it, expect, beforeEach } from 'vitest';
import { useGoalsStore } from '../../../src/stores/useGoalsStore';
import type { Goal, GoalStatus } from '../../../src/shared/types';

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: 'goal-1',
    title: 'Test goal',
    description: null,
    cwd: '/home/user/project',
    status: 'planning',
    priority: 1,
    tags: [],
    current_session_id: null,
    model: 'sonnet',
    permission_mode: 'supervised',
    plan_json: null,
    kanban_order: 0,
    created_at: 1700000000000,
    updated_at: 1700000000000,
    completed_at: null,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('useGoalsStore', () => {
  beforeEach(() => {
    useGoalsStore.setState({ goals: [] });
  });

  // ── Initial state ──────────────────────────────────────────────────────────

  it('starts with empty goals array', () => {
    expect(useGoalsStore.getState().goals).toEqual([]);
  });

  // ── setGoals ───────────────────────────────────────────────────────────────

  describe('setGoals', () => {
    it('replaces the goals array', () => {
      const goals = [makeGoal({ id: 'g1' }), makeGoal({ id: 'g2' })];
      useGoalsStore.getState().setGoals(goals);
      expect(useGoalsStore.getState().goals).toEqual(goals);
    });

    it('clears goals when set to empty array', () => {
      useGoalsStore.getState().setGoals([makeGoal()]);
      useGoalsStore.getState().setGoals([]);
      expect(useGoalsStore.getState().goals).toEqual([]);
    });

    it('overwrites previous goals completely', () => {
      useGoalsStore.getState().setGoals([makeGoal({ id: 'old' })]);
      useGoalsStore.getState().setGoals([makeGoal({ id: 'new' })]);
      expect(useGoalsStore.getState().goals).toHaveLength(1);
      expect(useGoalsStore.getState().goals[0].id).toBe('new');
    });
  });

  // ── upsertGoal ─────────────────────────────────────────────────────────────

  describe('upsertGoal', () => {
    it('inserts a new goal when id does not exist', () => {
      const goal = makeGoal({ id: 'new-goal' });
      useGoalsStore.getState().upsertGoal(goal);
      expect(useGoalsStore.getState().goals).toHaveLength(1);
      expect(useGoalsStore.getState().goals[0].id).toBe('new-goal');
    });

    it('updates an existing goal by id', () => {
      const original = makeGoal({ id: 'g1', title: 'Original' });
      useGoalsStore.getState().setGoals([original]);

      const updated = makeGoal({ id: 'g1', title: 'Updated' });
      useGoalsStore.getState().upsertGoal(updated);

      expect(useGoalsStore.getState().goals).toHaveLength(1);
      expect(useGoalsStore.getState().goals[0].title).toBe('Updated');
    });

    it('preserves other goals when upserting', () => {
      useGoalsStore.getState().setGoals([
        makeGoal({ id: 'g1', title: 'First' }),
        makeGoal({ id: 'g2', title: 'Second' }),
      ]);

      useGoalsStore.getState().upsertGoal(makeGoal({ id: 'g1', title: 'Updated' }));

      const goals = useGoalsStore.getState().goals;
      expect(goals).toHaveLength(2);
      expect(goals[0].title).toBe('Updated');
      expect(goals[1].title).toBe('Second');
    });

    it('appends to end when inserting new goal', () => {
      useGoalsStore.getState().setGoals([makeGoal({ id: 'g1' })]);
      useGoalsStore.getState().upsertGoal(makeGoal({ id: 'g2' }));

      const goals = useGoalsStore.getState().goals;
      expect(goals).toHaveLength(2);
      expect(goals[0].id).toBe('g1');
      expect(goals[1].id).toBe('g2');
    });

    it('replaces the exact index position on update', () => {
      useGoalsStore.getState().setGoals([
        makeGoal({ id: 'g1' }),
        makeGoal({ id: 'g2' }),
        makeGoal({ id: 'g3' }),
      ]);

      useGoalsStore.getState().upsertGoal(makeGoal({ id: 'g2', title: 'Middle updated' }));

      const goals = useGoalsStore.getState().goals;
      expect(goals[1].title).toBe('Middle updated');
      expect(goals[0].id).toBe('g1');
      expect(goals[2].id).toBe('g3');
    });
  });

  // ── removeGoal ─────────────────────────────────────────────────────────────

  describe('removeGoal', () => {
    it('removes a goal by id', () => {
      useGoalsStore.getState().setGoals([
        makeGoal({ id: 'g1' }),
        makeGoal({ id: 'g2' }),
      ]);

      useGoalsStore.getState().removeGoal('g1');
      expect(useGoalsStore.getState().goals).toHaveLength(1);
      expect(useGoalsStore.getState().goals[0].id).toBe('g2');
    });

    it('does nothing when id not found', () => {
      useGoalsStore.getState().setGoals([makeGoal({ id: 'g1' })]);
      useGoalsStore.getState().removeGoal('nonexistent');
      expect(useGoalsStore.getState().goals).toHaveLength(1);
    });

    it('removes from empty array without error', () => {
      useGoalsStore.getState().removeGoal('anything');
      expect(useGoalsStore.getState().goals).toEqual([]);
    });

    it('removes the only goal leaving empty array', () => {
      useGoalsStore.getState().setGoals([makeGoal({ id: 'sole' })]);
      useGoalsStore.getState().removeGoal('sole');
      expect(useGoalsStore.getState().goals).toEqual([]);
    });
  });

  // ── goalsByStatus ──────────────────────────────────────────────────────────

  describe('goalsByStatus', () => {
    it('returns empty array when no goals match', () => {
      useGoalsStore.getState().setGoals([makeGoal({ status: 'active' })]);
      expect(useGoalsStore.getState().goalsByStatus('complete')).toEqual([]);
    });

    it('returns empty array when store is empty', () => {
      expect(useGoalsStore.getState().goalsByStatus('planning')).toEqual([]);
    });

    it('filters goals by status', () => {
      useGoalsStore.getState().setGoals([
        makeGoal({ id: 'g1', status: 'planning' }),
        makeGoal({ id: 'g2', status: 'active' }),
        makeGoal({ id: 'g3', status: 'planning' }),
      ]);

      const planning = useGoalsStore.getState().goalsByStatus('planning');
      expect(planning).toHaveLength(2);
      expect(planning.map((g) => g.id)).toEqual(['g1', 'g3']);
    });

    it('sorts results by kanban_order ascending', () => {
      useGoalsStore.getState().setGoals([
        makeGoal({ id: 'g1', status: 'active', kanban_order: 3 }),
        makeGoal({ id: 'g2', status: 'active', kanban_order: 1 }),
        makeGoal({ id: 'g3', status: 'active', kanban_order: 2 }),
      ]);

      const active = useGoalsStore.getState().goalsByStatus('active');
      expect(active.map((g) => g.id)).toEqual(['g2', 'g3', 'g1']);
    });

    it('handles all statuses', () => {
      const statuses: GoalStatus[] = ['planning', 'active', 'waiting', 'complete', 'archived'];

      const goals = statuses.map((status, i) =>
        makeGoal({ id: `g${i}`, status, kanban_order: i }),
      );
      useGoalsStore.getState().setGoals(goals);

      for (const status of statuses) {
        const result = useGoalsStore.getState().goalsByStatus(status);
        expect(result).toHaveLength(1);
        expect(result[0].status).toBe(status);
      }
    });

    it('preserves kanban_order sort with same order values', () => {
      useGoalsStore.getState().setGoals([
        makeGoal({ id: 'g1', status: 'planning', kanban_order: 0 }),
        makeGoal({ id: 'g2', status: 'planning', kanban_order: 0 }),
      ]);

      const result = useGoalsStore.getState().goalsByStatus('planning');
      expect(result).toHaveLength(2);
    });
  });
});
