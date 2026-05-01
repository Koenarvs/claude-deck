import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { useGoalsStore } from '../../../src/stores/useGoalsStore';
import type { Goal, GoalStatus } from '../../../src/shared/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeGoal(overrides: Partial<Goal> & { id: string; title: string }): Goal {
  return {
    description: null,
    cwd: '/test/project',
    status: 'planning' as GoalStatus,
    priority: 0,
    tags: [],
    current_session_id: null,
    model: null,
    permission_mode: 'supervised',
    plan_json: null,
    kanban_order: 1.0,
    created_at: 1700000000000,
    updated_at: 1700000000000,
    completed_at: null,
    ...overrides,
  };
}

// ── Mock fetch ───────────────────────────────────────────────────────────────

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({}),
  });
  // Reset store
  useGoalsStore.getState().setGoals([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('KanbanBoard', () => {
  it('renders all four visible columns', async () => {
    const { default: KanbanBoard } = await import('../../../src/components/kanban/KanbanBoard');

    render(
      <MemoryRouter>
        <KanbanBoard />
      </MemoryRouter>,
    );

    expect(screen.getByText('Planning')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Waiting')).toBeInTheDocument();
    expect(screen.getByText('Complete')).toBeInTheDocument();
  });

  it('does not render archived column', async () => {
    const { default: KanbanBoard } = await import('../../../src/components/kanban/KanbanBoard');

    render(
      <MemoryRouter>
        <KanbanBoard />
      </MemoryRouter>,
    );

    expect(screen.queryByText('Archived')).not.toBeInTheDocument();
  });

  it('shows empty state for all columns when no goals', async () => {
    const { default: KanbanBoard } = await import('../../../src/components/kanban/KanbanBoard');

    render(
      <MemoryRouter>
        <KanbanBoard />
      </MemoryRouter>,
    );

    const emptyLabels = screen.getAllByText('No goals');
    expect(emptyLabels).toHaveLength(4);
  });

  it('distributes goals into correct columns', async () => {
    const { default: KanbanBoard } = await import('../../../src/components/kanban/KanbanBoard');

    useGoalsStore.getState().setGoals([
      makeGoal({ id: 'g1', title: 'Plan A', status: 'planning', kanban_order: 1 }),
      makeGoal({ id: 'g2', title: 'Active B', status: 'active', kanban_order: 1 }),
      makeGoal({ id: 'g3', title: 'Wait C', status: 'waiting', kanban_order: 1 }),
      makeGoal({ id: 'g4', title: 'Done D', status: 'complete', kanban_order: 1 }),
    ]);

    render(
      <MemoryRouter>
        <KanbanBoard />
      </MemoryRouter>,
    );

    expect(screen.getByText('Plan A')).toBeInTheDocument();
    expect(screen.getByText('Active B')).toBeInTheDocument();
    expect(screen.getByText('Wait C')).toBeInTheDocument();
    expect(screen.getByText('Done D')).toBeInTheDocument();
  });

  it('does not display archived goals on the board', async () => {
    const { default: KanbanBoard } = await import('../../../src/components/kanban/KanbanBoard');

    useGoalsStore.getState().setGoals([
      makeGoal({ id: 'g1', title: 'Visible', status: 'active', kanban_order: 1 }),
      makeGoal({ id: 'g2', title: 'Hidden', status: 'archived', kanban_order: 1 }),
    ]);

    render(
      <MemoryRouter>
        <KanbanBoard />
      </MemoryRouter>,
    );

    expect(screen.getByText('Visible')).toBeInTheDocument();
    expect(screen.queryByText('Hidden')).not.toBeInTheDocument();
  });

  it('sorts goals within a column by kanban_order', async () => {
    const { default: KanbanBoard } = await import('../../../src/components/kanban/KanbanBoard');

    useGoalsStore.getState().setGoals([
      makeGoal({ id: 'g3', title: 'Third', status: 'planning', kanban_order: 3 }),
      makeGoal({ id: 'g1', title: 'First', status: 'planning', kanban_order: 1 }),
      makeGoal({ id: 'g2', title: 'Second', status: 'planning', kanban_order: 2 }),
    ]);

    render(
      <MemoryRouter>
        <KanbanBoard />
      </MemoryRouter>,
    );

    const allCards = screen.getAllByRole('button');
    const goalCards = allCards.filter((el) =>
      el.getAttribute('aria-label')?.startsWith('Goal:'),
    );

    const titles = goalCards.map(
      (card) => card.querySelector('h3')?.textContent,
    );
    expect(titles).toEqual(['First', 'Second', 'Third']);
  });

  it('shows column counts correctly', async () => {
    const { default: KanbanBoard } = await import('../../../src/components/kanban/KanbanBoard');

    useGoalsStore.getState().setGoals([
      makeGoal({ id: 'g1', title: 'A', status: 'active', kanban_order: 1 }),
      makeGoal({ id: 'g2', title: 'B', status: 'active', kanban_order: 2 }),
      makeGoal({ id: 'g3', title: 'C', status: 'active', kanban_order: 3 }),
    ]);

    render(
      <MemoryRouter>
        <KanbanBoard />
      </MemoryRouter>,
    );

    // The Active column should show count 3
    expect(screen.getByText('3')).toBeInTheDocument();
  });
});
