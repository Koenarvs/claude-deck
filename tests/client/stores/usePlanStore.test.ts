import { describe, it, expect, beforeEach } from 'vitest';
import { usePlanStore } from '../../../src/stores/usePlanStore';
import type { PlanJson, PlanTodo } from '../../../src/shared/types';

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeTodo(overrides: Partial<PlanTodo> = {}): PlanTodo {
  return {
    content: 'Implement feature',
    status: 'pending',
    priority: 1,
    children: [],
    ...overrides,
  };
}

function makePlan(overrides: Partial<PlanJson> = {}): PlanJson {
  return {
    todos: [makeTodo()],
    raw_content: '# Plan\n- [ ] Implement feature',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('usePlanStore', () => {
  beforeEach(() => {
    usePlanStore.setState({ byGoalId: {} });
  });

  // ── Initial state ──────────────────────────────────────────────────────────

  it('starts with empty byGoalId map', () => {
    expect(usePlanStore.getState().byGoalId).toEqual({});
  });

  // ── setPlan ────────────────────────────────────────────────────────────────

  describe('setPlan', () => {
    it('sets a plan for a goal', () => {
      const plan = makePlan();
      usePlanStore.getState().setPlan('goal-1', plan);
      expect(usePlanStore.getState().byGoalId['goal-1']).toEqual(plan);
    });

    it('tracks multiple goals independently', () => {
      const plan1 = makePlan({ raw_content: 'Plan 1' });
      const plan2 = makePlan({ raw_content: 'Plan 2' });

      usePlanStore.getState().setPlan('goal-1', plan1);
      usePlanStore.getState().setPlan('goal-2', plan2);

      expect(usePlanStore.getState().byGoalId['goal-1'].raw_content).toBe('Plan 1');
      expect(usePlanStore.getState().byGoalId['goal-2'].raw_content).toBe('Plan 2');
    });

    it('overwrites previous plan for same goal', () => {
      usePlanStore.getState().setPlan('goal-1', makePlan({ raw_content: 'Old' }));
      usePlanStore.getState().setPlan('goal-1', makePlan({ raw_content: 'New' }));

      expect(usePlanStore.getState().byGoalId['goal-1'].raw_content).toBe('New');
    });

    it('does not affect other goals when updating one', () => {
      usePlanStore.getState().setPlan('goal-1', makePlan({ raw_content: 'Plan 1' }));
      usePlanStore.getState().setPlan('goal-2', makePlan({ raw_content: 'Plan 2' }));
      usePlanStore.getState().setPlan('goal-1', makePlan({ raw_content: 'Updated' }));

      expect(usePlanStore.getState().byGoalId['goal-2'].raw_content).toBe('Plan 2');
    });

    it('handles plan with empty todos', () => {
      const plan = makePlan({ todos: [] });
      usePlanStore.getState().setPlan('goal-1', plan);
      expect(usePlanStore.getState().byGoalId['goal-1'].todos).toEqual([]);
    });

    it('handles plan with nested children', () => {
      const plan = makePlan({
        todos: [
          makeTodo({
            content: 'Parent',
            children: [
              makeTodo({ content: 'Child 1' }),
              makeTodo({
                content: 'Child 2',
                children: [makeTodo({ content: 'Grandchild' })],
              }),
            ],
          }),
        ],
      });

      usePlanStore.getState().setPlan('goal-1', plan);
      const stored = usePlanStore.getState().byGoalId['goal-1'];
      expect(stored.todos[0].children).toHaveLength(2);
      expect(stored.todos[0].children[1].children[0].content).toBe('Grandchild');
    });

    it('handles plan with all todo statuses', () => {
      const plan = makePlan({
        todos: [
          makeTodo({ content: 'Pending', status: 'pending' }),
          makeTodo({ content: 'In Progress', status: 'in_progress' }),
          makeTodo({ content: 'Done', status: 'completed' }),
        ],
      });

      usePlanStore.getState().setPlan('goal-1', plan);
      const todos = usePlanStore.getState().byGoalId['goal-1'].todos;
      expect(todos[0].status).toBe('pending');
      expect(todos[1].status).toBe('in_progress');
      expect(todos[2].status).toBe('completed');
    });

    it('returns undefined for non-existent goal', () => {
      expect(usePlanStore.getState().byGoalId['nonexistent']).toBeUndefined();
    });
  });
});
