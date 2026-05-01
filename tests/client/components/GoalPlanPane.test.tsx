import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { usePlanStore } from '../../../src/stores/usePlanStore';
import type { PlanJson } from '../../../src/shared/types';

// ── Mock fetch ───────────────────────────────────────────────────────────────

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  // Default: document not found
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ exists: false, content: null, name: 'plan.md' }),
  });
  localStorage.clear();
  usePlanStore.setState({ byGoalId: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makePlan(
  todos: PlanJson['todos'] = [],
  raw = 'raw plan text',
): PlanJson {
  return { todos, raw_content: raw };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('GoalPlanPane', () => {
  it('renders all seven tabs', async () => {
    const { default: GoalPlanPane } = await import('../../../src/components/goal/GoalPlanPane');

    render(<GoalPlanPane goalId="test-goal-1" />);

    expect(screen.getByText('Health')).toBeInTheDocument();
    expect(screen.getByText('Plan')).toBeInTheDocument();
    expect(screen.getByText('Research')).toBeInTheDocument();
    expect(screen.getByText('Notes')).toBeInTheDocument();
    expect(screen.getByText('Handoff')).toBeInTheDocument();
    expect(screen.getByText('To Do')).toBeInTheDocument();
    expect(screen.getByText('Agents')).toBeInTheDocument();
  });

  it('defaults to Health tab', async () => {
    const { default: GoalPlanPane } = await import('../../../src/components/goal/GoalPlanPane');

    render(
      <GoalPlanPane
        goalId="test-goal-1"
        sessionHealth={{ tokensIn: 5000, tokensOut: 2000, cost: 0.50, turnCount: 10 }}
      />,
    );

    // Session Health heading from ContextHealth component
    expect(screen.getByText('Session Health')).toBeInTheDocument();
  });

  it('renders expanded by default', async () => {
    const { default: GoalPlanPane } = await import('../../../src/components/goal/GoalPlanPane');

    render(<GoalPlanPane goalId="test-goal-1" />);

    expect(screen.getByTestId('plan-pane-expanded')).toBeInTheDocument();
  });

  it('collapses and expands on toggle', async () => {
    const user = userEvent.setup();
    const { default: GoalPlanPane } = await import('../../../src/components/goal/GoalPlanPane');

    render(<GoalPlanPane goalId="test-goal-1" />);

    // Initially expanded
    expect(screen.getByTestId('plan-pane-expanded')).toBeInTheDocument();

    // Click collapse
    await user.click(screen.getByLabelText('Collapse pane'));
    expect(screen.getByTestId('plan-pane-collapsed')).toBeInTheDocument();

    // Click expand
    await user.click(screen.getByLabelText('Expand pane'));
    expect(screen.getByTestId('plan-pane-expanded')).toBeInTheDocument();
  });

  it('persists collapse state in localStorage', async () => {
    const user = userEvent.setup();
    const { default: GoalPlanPane } = await import('../../../src/components/goal/GoalPlanPane');

    render(<GoalPlanPane goalId="test-goal-1" />);

    await user.click(screen.getByLabelText('Collapse pane'));
    expect(localStorage.getItem('claude-deck:plan-pane-collapsed')).toBe('true');
  });

  it('starts collapsed when localStorage says so', async () => {
    localStorage.setItem('claude-deck:plan-pane-collapsed', 'true');
    const { default: GoalPlanPane } = await import('../../../src/components/goal/GoalPlanPane');

    render(<GoalPlanPane goalId="test-goal-1" />);

    expect(screen.getByTestId('plan-pane-collapsed')).toBeInTheDocument();
  });

  it('fetches document when switching to Plan tab', async () => {
    const user = userEvent.setup();
    const { default: GoalPlanPane } = await import('../../../src/components/goal/GoalPlanPane');

    render(<GoalPlanPane goalId="test-goal-1" />);

    await user.click(screen.getByText('Plan'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/goals/test-goal-1/document?name=plan.md'),
      );
    });
  });

  it('shows empty state on Plan tab when no document exists', async () => {
    const user = userEvent.setup();
    const { default: GoalPlanPane } = await import('../../../src/components/goal/GoalPlanPane');

    render(<GoalPlanPane goalId="test-goal-1" />);

    await user.click(screen.getByText('Plan'));

    await waitFor(() => {
      expect(screen.getByText(/no plan found/i)).toBeInTheDocument();
    });
  });

  it('renders markdown content when document exists', async () => {
    const user = userEvent.setup();
    const { default: GoalPlanPane } = await import('../../../src/components/goal/GoalPlanPane');

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        exists: true,
        content: '# My Plan\n\nThis is the plan content.',
      }),
    });

    render(<GoalPlanPane goalId="test-goal-1" />);

    await user.click(screen.getByText('Plan'));

    await waitFor(() => {
      expect(screen.getByText('My Plan')).toBeInTheDocument();
    });
    expect(screen.getByText('This is the plan content.')).toBeInTheDocument();
  });

  it('renders todos on To Do tab when plan exists', async () => {
    const user = userEvent.setup();
    const { default: GoalPlanPane } = await import('../../../src/components/goal/GoalPlanPane');

    usePlanStore.getState().setPlan(
      'test-goal-1',
      makePlan([
        { content: 'First task', status: 'completed', priority: 1, children: [] },
        { content: 'Second task', status: 'pending', priority: 2, children: [] },
      ]),
    );

    render(<GoalPlanPane goalId="test-goal-1" />);

    await user.click(screen.getByText('To Do'));

    expect(screen.getByText('First task')).toBeInTheDocument();
    expect(screen.getByText('Second task')).toBeInTheDocument();
  });

  it('shows empty state on To Do tab when no plan', async () => {
    const user = userEvent.setup();
    const { default: GoalPlanPane } = await import('../../../src/components/goal/GoalPlanPane');

    render(<GoalPlanPane goalId="test-goal-1" />);

    await user.click(screen.getByText('To Do'));

    expect(screen.getByText('No tasks yet')).toBeInTheDocument();
  });

  it('fetches research.md when switching to Research tab', async () => {
    const user = userEvent.setup();
    const { default: GoalPlanPane } = await import('../../../src/components/goal/GoalPlanPane');

    render(<GoalPlanPane goalId="test-goal-1" />);

    await user.click(screen.getByText('Research'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/goals/test-goal-1/document?name=research.md'),
      );
    });
  });

  it('fetches notes.md when switching to Notes tab', async () => {
    const user = userEvent.setup();
    const { default: GoalPlanPane } = await import('../../../src/components/goal/GoalPlanPane');

    render(<GoalPlanPane goalId="test-goal-1" />);

    await user.click(screen.getByText('Notes'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/goals/test-goal-1/document?name=notes.md'),
      );
    });
  });

  it('fetches handoff.md when switching to Handoff tab', async () => {
    const user = userEvent.setup();
    const { default: GoalPlanPane } = await import('../../../src/components/goal/GoalPlanPane');

    render(<GoalPlanPane goalId="test-goal-1" />);

    await user.click(screen.getByText('Handoff'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/goals/test-goal-1/document?name=handoff.md'),
      );
    });
  });

  it('renders Agents tab with loading then empty state', async () => {
    const user = userEvent.setup();
    const { default: GoalPlanPane } = await import('../../../src/components/goal/GoalPlanPane');

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [],
    });

    render(<GoalPlanPane goalId="test-goal-1" />);

    await user.click(screen.getByText('Agents'));

    await waitFor(() => {
      expect(screen.getByText('No sessions')).toBeInTheDocument();
    });
  });

  it('passes sessionHealth data to ContextHealth on Health tab', async () => {
    const { default: GoalPlanPane } = await import('../../../src/components/goal/GoalPlanPane');

    render(
      <GoalPlanPane
        goalId="test-goal-1"
        sessionHealth={{ tokensIn: 100000, tokensOut: 50000, cost: 3.25, turnCount: 42 }}
      />,
    );

    // ContextHealth renders these values
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('$3.2500')).toBeInTheDocument();
  });
});
