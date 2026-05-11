import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { usePlanStore } from '../../../src/stores/usePlanStore';
import type { PlanJson } from '../../../src/shared/types';

// ── Mock fetch ───────────────────────────────────────────────────────────────

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/documents')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ files: ['plan.md', 'conversation.md'] }),
      });
    }
    return Promise.resolve({
      ok: true,
      json: async () => ({ exists: false, content: null, name: 'plan.md' }),
    });
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
  it('renders all four tabs', async () => {
    const { default: GoalPlanPane } = await import('../../../src/components/goal/GoalPlanPane');

    render(<GoalPlanPane goalId="test-goal-1" />);

    expect(screen.getByText('Health')).toBeInTheDocument();
    expect(screen.getByText('Documents')).toBeInTheDocument();
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

    expect(screen.getByTestId('plan-pane-expanded')).toBeInTheDocument();

    await user.click(screen.getByLabelText('Collapse pane'));
    expect(screen.getByTestId('plan-pane-collapsed')).toBeInTheDocument();

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

  it('fetches file list when switching to Documents tab', async () => {
    const user = userEvent.setup();
    const { default: GoalPlanPane } = await import('../../../src/components/goal/GoalPlanPane');

    render(<GoalPlanPane goalId="test-goal-1" />);

    await user.click(screen.getByText('Documents'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/goals/test-goal-1/documents'),
      );
    });
  });

  it('shows empty state on Documents tab when no files exist', async () => {
    const user = userEvent.setup();
    const { default: GoalPlanPane } = await import('../../../src/components/goal/GoalPlanPane');

    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/documents')) {
        return Promise.resolve({ ok: true, json: async () => ({ files: [] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ exists: false, content: null }) });
    });

    render(<GoalPlanPane goalId="test-goal-1" />);

    await user.click(screen.getByText('Documents'));

    await waitFor(() => {
      expect(screen.getByText('No documents found')).toBeInTheDocument();
    });
  });

  it('renders markdown content when document is selected', async () => {
    const user = userEvent.setup();
    const { default: GoalPlanPane } = await import('../../../src/components/goal/GoalPlanPane');

    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/documents')) {
        return Promise.resolve({ ok: true, json: async () => ({ files: ['plan.md'] }) });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ exists: true, content: '# My Plan\n\nThis is the plan content.' }),
      });
    });

    render(<GoalPlanPane goalId="test-goal-1" />);

    await user.click(screen.getByText('Documents'));

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

  it('renders Agents tab with loading then empty state', async () => {
    const user = userEvent.setup();
    const { default: GoalPlanPane } = await import('../../../src/components/goal/GoalPlanPane');

    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/sessions')) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      return Promise.resolve({ ok: true, json: async () => ({ files: [] }) });
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

    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('$3.2500')).toBeInTheDocument();
  });
});
