import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { useApprovalsStore } from '../../../src/stores/useApprovalsStore';
import { useActiveToolStore } from '../../../src/stores/useActiveToolStore';
import type { Goal, GoalStatus, Approval } from '../../../src/shared/types';

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

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: 'approval-1',
    session_id: 'sess-1',
    goal_id: 'goal-1',
    tool_name: 'Bash',
    tool_args: '{}',
    status: 'pending',
    decided_reason: null,
    requested_at: Date.now(),
    resolved_at: null,
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
  // Reset stores
  useApprovalsStore.setState({ pending: [], resolved: [] });
  useActiveToolStore.setState({ bySessionId: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('KanbanCard', () => {
  it('renders goal title', async () => {
    const { default: KanbanCard } = await import('../../../src/components/kanban/KanbanCard');
    const goal = makeGoal({ id: 'g1', title: 'Fix the widget' });

    render(
      <MemoryRouter>
        <KanbanCard goal={goal} />
      </MemoryRouter>,
    );

    expect(screen.getByText('Fix the widget')).toBeInTheDocument();
  });

  it('renders shortened cwd', async () => {
    const { default: KanbanCard } = await import('../../../src/components/kanban/KanbanCard');
    const goal = makeGoal({ id: 'g2', title: 'Dir goal', cwd: '/home/user/project' });

    render(
      <MemoryRouter>
        <KanbanCard goal={goal} />
      </MemoryRouter>,
    );

    expect(screen.getByText('…/user/project')).toBeInTheDocument();
  });

  it('shortens Windows-style paths', async () => {
    const { default: KanbanCard } = await import('../../../src/components/kanban/KanbanCard');
    const goal = makeGoal({ id: 'g-win', title: 'Win path', cwd: 'C:\\Users\\dev\\project' });

    render(
      <MemoryRouter>
        <KanbanCard goal={goal} />
      </MemoryRouter>,
    );

    expect(screen.getByText('…/dev/project')).toBeInTheDocument();
  });

  it('renders model badge for opus', async () => {
    const { default: KanbanCard } = await import('../../../src/components/kanban/KanbanCard');
    const goal = makeGoal({ id: 'g3', title: 'Opus goal', model: 'opus' });

    render(
      <MemoryRouter>
        <KanbanCard goal={goal} />
      </MemoryRouter>,
    );

    expect(screen.getByText('Opus')).toBeInTheDocument();
  });

  it('renders model badge for sonnet', async () => {
    const { default: KanbanCard } = await import('../../../src/components/kanban/KanbanCard');
    const goal = makeGoal({ id: 'g4', title: 'Sonnet goal', model: 'sonnet' });

    render(
      <MemoryRouter>
        <KanbanCard goal={goal} />
      </MemoryRouter>,
    );

    expect(screen.getByText('Sonnet')).toBeInTheDocument();
  });

  it('renders model badge for haiku', async () => {
    const { default: KanbanCard } = await import('../../../src/components/kanban/KanbanCard');
    const goal = makeGoal({ id: 'g5', title: 'Haiku goal', model: 'haiku' });

    render(
      <MemoryRouter>
        <KanbanCard goal={goal} />
      </MemoryRouter>,
    );

    expect(screen.getByText('Haiku')).toBeInTheDocument();
  });

  it('does not render model badge for default model', async () => {
    const { default: KanbanCard } = await import('../../../src/components/kanban/KanbanCard');
    const goal = makeGoal({ id: 'g6', title: 'Default model', model: 'default' });

    render(
      <MemoryRouter>
        <KanbanCard goal={goal} />
      </MemoryRouter>,
    );

    expect(screen.queryByText('Default')).not.toBeInTheDocument();
  });

  it('does not render model badge when model is null', async () => {
    const { default: KanbanCard } = await import('../../../src/components/kanban/KanbanCard');
    const goal = makeGoal({ id: 'g7', title: 'No model', model: null });

    render(
      <MemoryRouter>
        <KanbanCard goal={goal} />
      </MemoryRouter>,
    );

    expect(screen.queryByText('Opus')).not.toBeInTheDocument();
    expect(screen.queryByText('Sonnet')).not.toBeInTheDocument();
    expect(screen.queryByText('Haiku')).not.toBeInTheDocument();
  });

  it('renders approval indicator when pending approval exists for the goal', async () => {
    const { default: KanbanCard } = await import('../../../src/components/kanban/KanbanCard');
    const goal = makeGoal({ id: 'goal-with-approval', title: 'Needs approval' });

    useApprovalsStore.getState().addPending(makeApproval({
      goal_id: 'goal-with-approval',
      tool_name: 'Write',
    }));

    render(
      <MemoryRouter>
        <KanbanCard goal={goal} />
      </MemoryRouter>,
    );

    expect(screen.getByText('Write')).toBeInTheDocument();
  });

  it('does not show approval indicator when no pending approval', async () => {
    const { default: KanbanCard } = await import('../../../src/components/kanban/KanbanCard');
    const goal = makeGoal({ id: 'goal-clean', title: 'Clean goal' });

    render(
      <MemoryRouter>
        <KanbanCard goal={goal} />
      </MemoryRouter>,
    );

    // No approval tool name should appear
    expect(screen.queryByText('Write')).not.toBeInTheDocument();
    expect(screen.queryByText('Bash')).not.toBeInTheDocument();
  });

  it('shows "Running" for active goal without active tool', async () => {
    const { default: KanbanCard } = await import('../../../src/components/kanban/KanbanCard');
    const goal = makeGoal({
      id: 'g-active',
      title: 'Active goal',
      status: 'active',
      current_session_id: 'sess-1',
    });

    render(
      <MemoryRouter>
        <KanbanCard goal={goal} />
      </MemoryRouter>,
    );

    expect(screen.getByText('Running')).toBeInTheDocument();
  });

  it('shows active tool name for active goal', async () => {
    const { default: KanbanCard } = await import('../../../src/components/kanban/KanbanCard');
    const goal = makeGoal({
      id: 'g-tool',
      title: 'Active with tool',
      status: 'active',
      current_session_id: 'sess-tool',
    });

    useActiveToolStore.setState({ bySessionId: { 'sess-tool': 'Read' } });

    render(
      <MemoryRouter>
        <KanbanCard goal={goal} />
      </MemoryRouter>,
    );

    expect(screen.getByText('Read')).toBeInTheDocument();
  });

  it('shows "Idle" for waiting goal without pending approval', async () => {
    const { default: KanbanCard } = await import('../../../src/components/kanban/KanbanCard');
    const goal = makeGoal({ id: 'g-idle', title: 'Idle goal', status: 'waiting' });

    render(
      <MemoryRouter>
        <KanbanCard goal={goal} />
      </MemoryRouter>,
    );

    expect(screen.getByText('Idle')).toBeInTheDocument();
  });

  it('has correct aria-label for accessibility', async () => {
    const { default: KanbanCard } = await import('../../../src/components/kanban/KanbanCard');
    const goal = makeGoal({ id: 'g-aria', title: 'Accessible goal' });

    render(
      <MemoryRouter>
        <KanbanCard goal={goal} />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: 'Goal: Accessible goal' })).toBeInTheDocument();
  });

  it('renders archive button', async () => {
    const { default: KanbanCard } = await import('../../../src/components/kanban/KanbanCard');
    const goal = makeGoal({ id: 'g-archive', title: 'Archive me' });

    render(
      <MemoryRouter>
        <KanbanCard goal={goal} />
      </MemoryRouter>,
    );

    expect(screen.getByLabelText('Archive goal')).toBeInTheDocument();
  });

  it('fetches and displays session stats for active goal', async () => {
    const { default: KanbanCard } = await import('../../../src/components/kanban/KanbanCard');
    const goal = makeGoal({
      id: 'g-stats',
      title: 'Stats goal',
      status: 'active',
      current_session_id: 'sess-stats',
    });

    // Mock goal detail fetch
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ goal: { current_session_id: 'sess-stats' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ stream_event_count: 15 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          inputTokens: 50000,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 10000,
          estimatedCostUsd: 2.50,
          currentContextTokens: 30000,
        }),
      });

    render(
      <MemoryRouter>
        <KanbanCard goal={goal} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('15t')).toBeInTheDocument();
    });

    expect(screen.getByText('$2.50')).toBeInTheDocument();
    expect(screen.getByText('60.0K')).toBeInTheDocument();
  });
});
