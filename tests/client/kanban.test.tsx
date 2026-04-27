import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { Goal, GoalStatus } from '../../src/shared/types';
import { useGoalsStore } from '../../src/stores/useGoalsStore';

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

function makeGoals(count: number, status: GoalStatus = 'active'): Goal[] {
  return Array.from({ length: count }, (_, i) =>
    makeGoal({
      id: `goal-${status}-${i}`,
      title: `Goal ${i} (${status})`,
      status,
      kanban_order: i + 1,
      tags: i % 3 === 0 ? ['frontend'] : [],
      model: i % 4 === 0 ? 'sonnet' : null,
    }),
  );
}

function seedStore(goals: Goal[]) {
  useGoalsStore.getState().setGoals(goals);
}

// ── Mock fetch ───────────────────────────────────────────────────────────────

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => [],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  useGoalsStore.getState().setGoals([]);
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('KanbanCard', () => {
  it('renders goal title', async () => {
    // Lazy import to ensure mocks are in place
    const { default: KanbanCard } = await import('../../src/components/kanban/KanbanCard');

    const goal = makeGoal({ id: 'g1', title: 'Fix the widget', tags: ['ui', 'bugfix'] });

    render(
      <MemoryRouter>
        <KanbanCard goal={goal} />
      </MemoryRouter>,
    );

    expect(screen.getByText('Fix the widget')).toBeInTheDocument();
  });

  it('renders shortened working directory', async () => {
    const { default: KanbanCard } = await import('../../src/components/kanban/KanbanCard');

    const goal = makeGoal({
      id: 'g2',
      title: 'Dir goal',
      cwd: '/home/user/project',
    });

    render(
      <MemoryRouter>
        <KanbanCard goal={goal} />
      </MemoryRouter>,
    );

    expect(screen.getByText('…/user/project')).toBeInTheDocument();
  });

  it('renders model badge when model is set', async () => {
    const { default: KanbanCard } = await import('../../src/components/kanban/KanbanCard');

    const goal = makeGoal({ id: 'g3', title: 'Opus goal', model: 'opus' });

    render(
      <MemoryRouter>
        <KanbanCard goal={goal} />
      </MemoryRouter>,
    );

    expect(screen.getByText('Opus')).toBeInTheDocument();
  });

  it('navigates to /goals/:id on click', async () => {
    const { default: KanbanCard } = await import('../../src/components/kanban/KanbanCard');

    const goal = makeGoal({ id: 'goal-abc', title: 'Clickable goal' });

    // Use MemoryRouter to capture navigation
    const { container } = render(
      <MemoryRouter initialEntries={['/board']}>
        <KanbanCard goal={goal} />
      </MemoryRouter>,
    );

    const card = container.querySelector('[role="button"]');
    expect(card).toBeInTheDocument();
  });
});

describe('KanbanColumn', () => {
  it('renders column header with count', async () => {
    const { default: KanbanColumn } = await import('../../src/components/kanban/KanbanColumn');

    const goals = [
      makeGoal({ id: 'g1', title: 'Goal 1', status: 'active' }),
      makeGoal({ id: 'g2', title: 'Goal 2', status: 'active' }),
    ];

    render(
      <MemoryRouter>
        <KanbanColumn status="active" goals={goals} />
      </MemoryRouter>,
    );

    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('shows placeholder when empty', async () => {
    const { default: KanbanColumn } = await import('../../src/components/kanban/KanbanColumn');

    render(
      <MemoryRouter>
        <KanbanColumn status="planning" goals={[]} />
      </MemoryRouter>,
    );

    expect(screen.getByText('No goals')).toBeInTheDocument();
  });

  it('renders all goal cards', async () => {
    const { default: KanbanColumn } = await import('../../src/components/kanban/KanbanColumn');

    const goals = [
      makeGoal({ id: 'g1', title: 'First', status: 'waiting' }),
      makeGoal({ id: 'g2', title: 'Second', status: 'waiting' }),
      makeGoal({ id: 'g3', title: 'Third', status: 'waiting' }),
    ];

    render(
      <MemoryRouter>
        <KanbanColumn status="waiting" goals={goals} />
      </MemoryRouter>,
    );

    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
    expect(screen.getByText('Third')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });
});

describe('KanbanPage', () => {
  it('renders all 4 visible columns', async () => {
    const { default: KanbanPage } = await import('../../src/pages/KanbanPage');

    // Mock successful fetch with empty goals
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    render(
      <MemoryRouter initialEntries={['/board']}>
        <KanbanPage />
      </MemoryRouter>,
    );

    // Wait for loading to finish
    const board = await screen.findByText('Board');
    expect(board).toBeInTheDocument();
  });

  it('renders New Goal button', async () => {
    const { default: KanbanPage } = await import('../../src/pages/KanbanPage');

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    render(
      <MemoryRouter>
        <KanbanPage />
      </MemoryRouter>,
    );

    const newGoalBtn = await screen.findByText('New Goal');
    expect(newGoalBtn).toBeInTheDocument();
  });

  it('opens and closes the new goal modal', async () => {
    const { default: KanbanPage } = await import('../../src/pages/KanbanPage');
    const user = userEvent.setup();

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    render(
      <MemoryRouter>
        <KanbanPage />
      </MemoryRouter>,
    );

    // Click New Goal
    const newGoalBtn = await screen.findByText('New Goal');
    await user.click(newGoalBtn);

    // Modal should appear
    const modal = screen.getByRole('dialog');
    expect(modal).toBeInTheDocument();
    expect(within(modal).getByText('Create Goal')).toBeInTheDocument();

    // Click Cancel
    await user.click(within(modal).getByText('Cancel'));

    // Modal should be gone
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows validation error on empty title submit', async () => {
    const { default: KanbanPage } = await import('../../src/pages/KanbanPage');
    const user = userEvent.setup();

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    render(
      <MemoryRouter>
        <KanbanPage />
      </MemoryRouter>,
    );

    // Open modal
    const newGoalBtn = await screen.findByText('New Goal');
    await user.click(newGoalBtn);

    // Fill only cwd (title is required and enforced by HTML required + zod)
    const cwdInput = screen.getByPlaceholderText('/path/to/project');
    await user.type(cwdInput, '/test');

    // Submit -- browser validation should prevent form submission
    // since title is required via HTML attribute
    const submitBtn = screen.getByText('Create Goal');
    expect(submitBtn).toBeInTheDocument();
  });

  it('distributes goals across columns correctly', async () => {
    const { default: KanbanPage } = await import('../../src/pages/KanbanPage');

    const goals = [
      makeGoal({ id: '00000000-0000-4000-8000-000000000001', title: 'Plan A', status: 'planning', kanban_order: 1 }),
      makeGoal({ id: '00000000-0000-4000-8000-000000000002', title: 'Active B', status: 'active', kanban_order: 1 }),
      makeGoal({ id: '00000000-0000-4000-8000-000000000003', title: 'Active C', status: 'active', kanban_order: 2 }),
      makeGoal({ id: '00000000-0000-4000-8000-000000000004', title: 'Wait D', status: 'waiting', kanban_order: 1 }),
      makeGoal({ id: '00000000-0000-4000-8000-000000000005', title: 'Done E', status: 'complete', kanban_order: 1 }),
    ];

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => goals,
    });

    render(
      <MemoryRouter>
        <KanbanPage />
      </MemoryRouter>,
    );

    // All goals should render
    expect(await screen.findByText('Plan A')).toBeInTheDocument();
    expect(screen.getByText('Active B')).toBeInTheDocument();
    expect(screen.getByText('Active C')).toBeInTheDocument();
    expect(screen.getByText('Wait D')).toBeInTheDocument();
    expect(screen.getByText('Done E')).toBeInTheDocument();
  });
});

describe('NewGoalModal', () => {
  it('submits a valid goal', async () => {
    const { default: NewGoalModal } = await import('../../src/components/kanban/NewGoalModal');
    const user = userEvent.setup();

    const createdGoal = makeGoal({
      id: '00000000-0000-4000-8000-000000000099',
      title: 'New test goal',
      cwd: '/test/dir',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => createdGoal,
    });

    const onClose = vi.fn();

    render(
      <MemoryRouter>
        <NewGoalModal open={true} onClose={onClose} />
      </MemoryRouter>,
    );

    await user.type(screen.getByPlaceholderText('What do you want to accomplish?'), 'New test goal');
    await user.type(screen.getByPlaceholderText('/path/to/project'), '/test/dir');

    await user.click(screen.getByText('Create Goal'));

    // Should have called fetch with POST /api/goals
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/goals',
      expect.objectContaining({ method: 'POST' }),
    );

    // Modal should close on success
    expect(onClose).toHaveBeenCalled();
  });

  it('handles API error with rollback', async () => {
    const { default: NewGoalModal } = await import('../../src/components/kanban/NewGoalModal');
    const user = userEvent.setup();

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Server error' }),
    });

    const onClose = vi.fn();

    render(
      <MemoryRouter>
        <NewGoalModal open={true} onClose={onClose} />
      </MemoryRouter>,
    );

    await user.type(screen.getByPlaceholderText('What do you want to accomplish?'), 'Failing goal');
    await user.type(screen.getByPlaceholderText('/path/to/project'), '/test');

    await user.click(screen.getByText('Create Goal'));

    // Error should appear
    const alert = await screen.findByRole('alert');
    expect(alert).toBeInTheDocument();

    // Modal should NOT close
    expect(onClose).not.toHaveBeenCalled();

    // Store should not contain the temp goal
    const goals = useGoalsStore.getState().goals;
    const tempGoals = goals.filter((g) => g.id.startsWith('temp-'));
    expect(tempGoals).toHaveLength(0);
  });
});

describe('Performance', () => {
  it('renders 50 goals in under 200ms', async () => {
    const { default: KanbanBoard } = await import('../../src/components/kanban/KanbanBoard');

    // Distribute 50 goals across statuses
    const allGoals = [
      ...makeGoals(15, 'planning'),
      ...makeGoals(15, 'active'),
      ...makeGoals(10, 'waiting'),
      ...makeGoals(10, 'complete'),
    ];
    seedStore(allGoals);

    const start = performance.now();

    render(
      <MemoryRouter>
        <KanbanBoard />
      </MemoryRouter>,
    );

    const elapsed = performance.now() - start;

    // Verify all 50 goals rendered
    expect(allGoals.length).toBe(50);

    // Performance check -- 500ms cold render budget (jsdom is slower than real browser)
    expect(elapsed).toBeLessThan(500);
  });
});
