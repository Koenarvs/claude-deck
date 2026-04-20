import { describe, it, expect, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import StatCards from '../../src/components/dashboard/StatCards';
import ActiveGoalsStrip from '../../src/components/dashboard/ActiveGoalsStrip';
import RecentActivityFeed from '../../src/components/dashboard/RecentActivityFeed';
import GoalProgress from '../../src/components/dashboard/GoalProgress';
import QuickActions from '../../src/components/dashboard/QuickActions';
import type { Goal, HookEvent, GoalStatus } from '../../src/shared/types';

// ── Factories ────────────────────────────────────────────────────────────────

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: crypto.randomUUID(),
    title: 'Test Goal',
    description: null,
    cwd: '/tmp/test',
    status: 'active',
    priority: 0,
    tags: [],
    current_session_id: null,
    model: 'sonnet',
    permission_mode: 'supervised',
    plan_json: null,
    kanban_order: 1,
    created_at: Date.now(),
    updated_at: Date.now(),
    completed_at: null,
    ...overrides,
  };
}

function makeHookEvent(overrides: Partial<HookEvent> = {}): HookEvent {
  return {
    id: crypto.randomUUID(),
    session_id: crypto.randomUUID(),
    event_type: 'PreToolUse',
    tool_name: 'Bash',
    payload_json: '{}',
    created_at: Date.now(),
    ...overrides,
  };
}

// ── Mock recharts to avoid SVG rendering issues in jsdom ─────────────────────

vi.mock('recharts', async () => {
  const React = await import('react');
  return {
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', { 'data-testid': 'responsive-container' }, children),
    BarChart: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', { 'data-testid': 'bar-chart' }, children),
    Bar: () => React.createElement('div', { 'data-testid': 'bar' }),
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    Cell: () => null,
  };
});

// ── StatCards ─────────────────────────────────────────────────────────────────

describe('StatCards', () => {
  it('renders all four stat tiles with correct values', () => {
    render(
      <StatCards
        activeGoals={5}
        activeSessions={3}
        pendingApprovals={2}
        totalCompleted={10}
      />,
    );

    expect(screen.getByText('Active Goals')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();

    expect(screen.getByText('Active Sessions')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();

    expect(screen.getByText('Pending Approvals')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();

    expect(screen.getByText('Total Completed')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
  });

  it('renders zero values correctly', () => {
    render(
      <StatCards
        activeGoals={0}
        activeSessions={0}
        pendingApprovals={0}
        totalCompleted={0}
      />,
    );

    const zeros = screen.getAllByText('0');
    expect(zeros).toHaveLength(4);
  });
});

// ── ActiveGoalsStrip ─────────────────────────────────────────────────────────

describe('ActiveGoalsStrip', () => {
  it('renders empty state when no goals', () => {
    render(
      <MemoryRouter>
        <ActiveGoalsStrip goals={[]} />
      </MemoryRouter>,
    );

    expect(screen.getByText(/No active goals/)).toBeInTheDocument();
  });

  it('renders goal cards with titles', () => {
    const goals = [
      makeGoal({ title: 'Fix login bug' }),
      makeGoal({ title: 'Add dashboard' }),
    ];

    render(
      <MemoryRouter>
        <ActiveGoalsStrip goals={goals} />
      </MemoryRouter>,
    );

    expect(screen.getByText('Fix login bug')).toBeInTheDocument();
    expect(screen.getByText('Add dashboard')).toBeInTheDocument();
  });

  it('renders model label on each card', () => {
    const goals = [makeGoal({ model: 'opus', title: 'Opus goal' })];

    render(
      <MemoryRouter>
        <ActiveGoalsStrip goals={goals} />
      </MemoryRouter>,
    );

    expect(screen.getByText('opus')).toBeInTheDocument();
  });

  it('renders "default" when model is null', () => {
    const goals = [makeGoal({ model: null, title: 'No model goal' })];

    render(
      <MemoryRouter>
        <ActiveGoalsStrip goals={goals} />
      </MemoryRouter>,
    );

    expect(screen.getByText('default')).toBeInTheDocument();
  });
});

// ── RecentActivityFeed ───────────────────────────────────────────────────────

describe('RecentActivityFeed', () => {
  it('renders empty state when no events', () => {
    render(<RecentActivityFeed events={[]} />);

    expect(screen.getByText(/No activity yet/)).toBeInTheDocument();
  });

  it('renders event rows with event type and tool name', () => {
    const events = [
      makeHookEvent({ event_type: 'PreToolUse', tool_name: 'Bash' }),
      makeHookEvent({ event_type: 'PostToolUse', tool_name: 'Read' }),
    ];

    render(<RecentActivityFeed events={events} />);

    expect(screen.getByText('Recent Activity')).toBeInTheDocument();
    expect(screen.getByText('PreToolUse')).toBeInTheDocument();
    expect(screen.getByText('Bash')).toBeInTheDocument();
    expect(screen.getByText('PostToolUse')).toBeInTheDocument();
    expect(screen.getByText('Read')).toBeInTheDocument();
  });

  it('limits display to 20 events', () => {
    const events = Array.from({ length: 25 }, (_, i) =>
      makeHookEvent({ event_type: 'PreToolUse', tool_name: `Tool${i}` }),
    );

    render(<RecentActivityFeed events={events} />);

    // Should show first 20, not all 25
    expect(screen.getByText('Tool0')).toBeInTheDocument();
    expect(screen.getByText('Tool19')).toBeInTheDocument();
    expect(screen.queryByText('Tool20')).not.toBeInTheDocument();
  });

  it('renders session short-id (first 8 chars)', () => {
    const sessionId = 'abcdef12-3456-7890-abcd-ef1234567890';
    const events = [makeHookEvent({ session_id: sessionId })];

    render(<RecentActivityFeed events={events} />);

    expect(screen.getByText('abcdef12')).toBeInTheDocument();
  });
});

// ── GoalProgress ─────────────────────────────────────────────────────────────

describe('GoalProgress', () => {
  it('renders empty state when all counts are zero', () => {
    const statusCounts: Record<GoalStatus, number> = {
      planning: 0,
      active: 0,
      waiting: 0,
      complete: 0,
      archived: 0,
    };

    render(<GoalProgress statusCounts={statusCounts} />);

    expect(screen.getByText(/No goals to chart/)).toBeInTheDocument();
  });

  it('renders chart when goals exist', () => {
    const statusCounts: Record<GoalStatus, number> = {
      planning: 2,
      active: 5,
      waiting: 1,
      complete: 8,
      archived: 3,
    };

    render(<GoalProgress statusCounts={statusCounts} />);

    expect(screen.getByText('Goals by Status')).toBeInTheDocument();
    expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
  });
});

// ── QuickActions ─────────────────────────────────────────────────────────────

describe('QuickActions', () => {
  it('renders all three action buttons', () => {
    render(
      <MemoryRouter>
        <QuickActions />
      </MemoryRouter>,
    );

    expect(screen.getByText('New Goal')).toBeInTheDocument();
    expect(screen.getByText('Install Hooks')).toBeInTheDocument();
    expect(screen.getByText('Open Board')).toBeInTheDocument();
  });
});
