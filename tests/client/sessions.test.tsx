import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { Session, SessionOrigin } from '../../src/shared/types';
import SessionsTable from '../../src/components/sessions/SessionsTable';
import SessionFilters from '../../src/components/sessions/SessionFilters';
import SessionDetailHeader from '../../src/components/sessions/SessionDetailHeader';
import TraceDownloadPanel from '../../src/components/sessions/TraceDownloadPanel';
import MessageStream from '../../src/components/sessions/MessageStream';
import { OriginBadge } from '../../src/components/sessions/OriginBadge';
import type { SessionFiltersState } from '../../src/components/sessions/SessionFilters';

// ── Mock navigate ────────────────────────────────────────────────────────────

const mockNavigate = vi.fn();
vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-001',
    goal_id: null,
    origin: 'external' as SessionOrigin,
    cwd: '/home/user/project',
    model: 'sonnet',
    trace_dir: null,
    display_name: null,
    parent_session_id: null,
    stream_event_count: 42,
    hook_event_count: 10,
    stderr_bytes: 0,
    total_cost_usd: 0.0523,
    total_tokens_in: 15000,
    total_tokens_out: 3200,
    started_at: 1700000000000,
    ended_at: 1700003600000,
    ...overrides,
  };
}

function makeSessions(count: number): Session[] {
  return Array.from({ length: count }, (_, i) =>
    makeSession({
      id: `sess-${String(i).padStart(3, '0')}`,
      started_at: 1700000000000 + i * 60000,
      ended_at: 1700000000000 + i * 60000 + 300000,
      total_cost_usd: Math.random() * 0.1,
      total_tokens_in: Math.floor(Math.random() * 50000),
      total_tokens_out: Math.floor(Math.random() * 10000),
      origin: (i % 3 === 0 ? 'dashboard' : 'external') as SessionOrigin,
    }),
  );
}

// ── OriginBadge ──────────────────────────────────────────────────────────────

describe('OriginBadge', () => {
  it('renders dashboard badge', () => {
    render(<OriginBadge origin="dashboard" />);
    expect(screen.getByText('Dashboard')).toBeDefined();
  });

  it('renders external badge', () => {
    render(<OriginBadge origin="external" />);
    expect(screen.getByText('External')).toBeDefined();
  });
});

// ── SessionsTable ────────────────────────────────────────────────────────────

describe('SessionsTable', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
  });

  it('renders column headers', () => {
    render(
      <MemoryRouter>
        <SessionsTable sessions={[]} originFilter="all" activeOnly={false} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Origin')).toBeDefined();
    expect(screen.getByText('Session ID')).toBeDefined();
    expect(screen.getByText('Working Dir')).toBeDefined();
    expect(screen.getByText('Model')).toBeDefined();
    expect(screen.getByText(/Started/)).toBeDefined();
    expect(screen.getByText(/Duration/)).toBeDefined();
    expect(screen.getByText(/Cost/)).toBeDefined();
    expect(screen.getByText('Status')).toBeDefined();
  });

  it('shows empty state when no sessions', () => {
    render(
      <MemoryRouter>
        <SessionsTable sessions={[]} originFilter="all" activeOnly={false} />
      </MemoryRouter>,
    );
    expect(screen.getByText('No sessions found.')).toBeDefined();
  });

  it('renders session rows', () => {
    const sessions = [makeSession({ id: 'test-session-1' })];
    render(
      <MemoryRouter>
        <SessionsTable sessions={sessions} originFilter="all" activeOnly={false} />
      </MemoryRouter>,
    );
    expect(screen.getByText('test-session...')).toBeDefined();
  });

  it('renders 500 rows without error', () => {
    const sessions = makeSessions(500);
    const { container } = render(
      <MemoryRouter>
        <SessionsTable sessions={sessions} originFilter="all" activeOnly={false} />
      </MemoryRouter>,
    );
    const rows = container.querySelectorAll('tbody tr');
    expect(rows.length).toBe(500);
  });

  it('navigates to session detail on row click', async () => {
    const user = userEvent.setup();
    const sessions = [makeSession({ id: 'nav-test-session' })];
    render(
      <MemoryRouter>
        <SessionsTable sessions={sessions} originFilter="all" activeOnly={false} />
      </MemoryRouter>,
    );

    // The first tbody row (skip header row at index 0)
    const rows = screen.getAllByRole('row');
    const dataRow = rows[1]; // skip header row
    await user.click(dataRow);
    expect(mockNavigate).toHaveBeenCalledWith('/sessions/nav-test-session');
  });

  it('filters by origin', () => {
    const sessions = [
      makeSession({ id: 'dash-1', origin: 'dashboard' }),
      makeSession({ id: 'ext-1', origin: 'external' }),
    ];
    const { container } = render(
      <MemoryRouter>
        <SessionsTable sessions={sessions} originFilter="external" activeOnly={false} />
      </MemoryRouter>,
    );
    const rows = container.querySelectorAll('tbody tr');
    expect(rows.length).toBe(1);
    expect(screen.getByText('External')).toBeDefined();
  });

  it('filters active only', () => {
    const sessions = [
      makeSession({ id: 'active-1', ended_at: null }),
      makeSession({ id: 'ended-1', ended_at: 1700003600000 }),
    ];
    const { container } = render(
      <MemoryRouter>
        <SessionsTable sessions={sessions} originFilter="all" activeOnly={true} />
      </MemoryRouter>,
    );
    const rows = container.querySelectorAll('tbody tr');
    expect(rows.length).toBe(1);
    expect(screen.getByText('Active')).toBeDefined();
  });

  it('sorts by cost descending by default after click', async () => {
    const user = userEvent.setup();
    const sessions = [
      makeSession({ id: 'cheap', total_cost_usd: 0.01, started_at: 1700000000000 }),
      makeSession({ id: 'expensive', total_cost_usd: 0.99, started_at: 1700000001000 }),
    ];
    render(
      <MemoryRouter>
        <SessionsTable sessions={sessions} originFilter="all" activeOnly={false} />
      </MemoryRouter>,
    );

    // Click Cost header to sort by cost descending
    const costHeader = screen.getByText(/^Cost/);
    await user.click(costHeader);

    const rows = screen.getAllByRole('row');
    // First data row should be the expensive one
    const firstRow = rows[1];
    expect(within(firstRow).getByText('$0.9900')).toBeDefined();
  });

  it('toggles sort direction on second click', async () => {
    const user = userEvent.setup();
    const sessions = [
      makeSession({ id: 'cheap', total_cost_usd: 0.01 }),
      makeSession({ id: 'expensive', total_cost_usd: 0.99 }),
    ];
    render(
      <MemoryRouter>
        <SessionsTable sessions={sessions} originFilter="all" activeOnly={false} />
      </MemoryRouter>,
    );

    const costHeader = screen.getByText(/^Cost/);
    await user.click(costHeader); // desc
    await user.click(costHeader); // asc

    const rows = screen.getAllByRole('row');
    const firstRow = rows[1];
    expect(within(firstRow).getByText('$0.0100')).toBeDefined();
  });

  it('shows active badge for sessions without ended_at', () => {
    const sessions = [makeSession({ id: 'active-session', ended_at: null })];
    render(
      <MemoryRouter>
        <SessionsTable sessions={sessions} originFilter="all" activeOnly={false} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Active')).toBeDefined();
  });

  it('shows ended badge for completed sessions', () => {
    const sessions = [makeSession({ id: 'ended-session', ended_at: 1700003600000 })];
    render(
      <MemoryRouter>
        <SessionsTable sessions={sessions} originFilter="all" activeOnly={false} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Ended')).toBeDefined();
  });

  it('has role="grid" on table', () => {
    render(
      <MemoryRouter>
        <SessionsTable sessions={[]} originFilter="all" activeOnly={false} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('grid')).toBeDefined();
  });
});

// ── SessionFilters ───────────────────────────────────────────────────────────

describe('SessionFilters', () => {
  const defaultFilters: SessionFiltersState = {
    origin: 'all',
    activeOnly: false,
    dateRange: 'all',
  };

  it('renders filter controls', () => {
    render(
      <SessionFilters filters={defaultFilters} onChange={vi.fn()} sessionCount={10} />,
    );
    expect(screen.getByText('Filters')).toBeDefined();
    expect(screen.getByText('10 sessions')).toBeDefined();
  });

  it('calls onChange when origin filter changes', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <SessionFilters filters={defaultFilters} onChange={onChange} sessionCount={10} />,
    );

    const originSelect = screen.getAllByRole('combobox')[0];
    await user.selectOptions(originSelect, 'external');
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'external' }),
    );
  });

  it('calls onChange when active-only toggled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <SessionFilters filters={defaultFilters} onChange={onChange} sessionCount={5} />,
    );

    const checkbox = screen.getByRole('checkbox');
    await user.click(checkbox);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ activeOnly: true }),
    );
  });

  it('shows reset button when filters active', () => {
    const activeFilters: SessionFiltersState = {
      origin: 'external',
      activeOnly: false,
      dateRange: 'all',
    };
    render(
      <SessionFilters filters={activeFilters} onChange={vi.fn()} sessionCount={3} />,
    );
    expect(screen.getByText('Reset')).toBeDefined();
  });

  it('does not show reset button when filters at default', () => {
    render(
      <SessionFilters filters={defaultFilters} onChange={vi.fn()} sessionCount={3} />,
    );
    expect(screen.queryByText('Reset')).toBeNull();
  });

  it('shows singular "session" for count of 1', () => {
    render(
      <SessionFilters filters={defaultFilters} onChange={vi.fn()} sessionCount={1} />,
    );
    expect(screen.getByText('1 session')).toBeDefined();
  });
});

// ── SessionDetailHeader ─────────────────────────────────────────────────────

describe('SessionDetailHeader', () => {
  it('renders session ID', () => {
    const session = makeSession({ id: 'header-test-id' });
    render(
      <MemoryRouter>
        <SessionDetailHeader session={session} />
      </MemoryRouter>,
    );
    expect(screen.getByText('header-test-id')).toBeDefined();
  });

  it('shows origin badge', () => {
    const session = makeSession({ origin: 'dashboard' });
    render(
      <MemoryRouter>
        <SessionDetailHeader session={session} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Dashboard')).toBeDefined();
  });

  it('shows goal link when goal_id is set', () => {
    const session = makeSession({ goal_id: 'goal-abc-123' });
    render(
      <MemoryRouter>
        <SessionDetailHeader session={session} />
      </MemoryRouter>,
    );
    const link = screen.getByText('goal-abc-123');
    expect(link).toBeDefined();
    expect(link.closest('a')?.getAttribute('href')).toBe('/goals/goal-abc-123');
  });

  it('does not show goal link when goal_id is null', () => {
    const session = makeSession({ goal_id: null });
    render(
      <MemoryRouter>
        <SessionDetailHeader session={session} />
      </MemoryRouter>,
    );
    expect(screen.queryByText('Goal:')).toBeNull();
  });

  it('shows active badge for running sessions', () => {
    const session = makeSession({ ended_at: null });
    render(
      <MemoryRouter>
        <SessionDetailHeader session={session} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Active')).toBeDefined();
  });

  it('displays model name', () => {
    const session = makeSession({ model: 'opus' });
    render(
      <MemoryRouter>
        <SessionDetailHeader session={session} />
      </MemoryRouter>,
    );
    expect(screen.getByText('opus')).toBeDefined();
  });

  it('displays cost', () => {
    const session = makeSession({ total_cost_usd: 0.0523 });
    render(
      <MemoryRouter>
        <SessionDetailHeader session={session} />
      </MemoryRouter>,
    );
    expect(screen.getByText('$0.0523')).toBeDefined();
  });

  it('displays working directory', () => {
    const session = makeSession({ cwd: '/home/user/my-project' });
    render(
      <MemoryRouter>
        <SessionDetailHeader session={session} />
      </MemoryRouter>,
    );
    expect(screen.getByText('/home/user/my-project')).toBeDefined();
  });
});

// ── TraceDownloadPanel ───────────────────────────────────────────────────────

describe('TraceDownloadPanel', () => {
  it('renders three download buttons', () => {
    const session = makeSession({ id: 'trace-test' });
    render(<TraceDownloadPanel session={session} />);

    expect(screen.getByText('Stream Events')).toBeDefined();
    expect(screen.getByText('Hook Events')).toBeDefined();
    expect(screen.getByText('Full Bundle')).toBeDefined();
  });

  it('links stream download to correct URL', () => {
    const session = makeSession({ id: 'trace-url-test' });
    render(<TraceDownloadPanel session={session} />);

    const streamLink = screen.getByText('Stream Events').closest('a');
    expect(streamLink?.getAttribute('href')).toBe('/api/sessions/trace-url-test/trace/stream');
  });

  it('links hooks download to correct URL', () => {
    const session = makeSession({ id: 'trace-url-test' });
    render(<TraceDownloadPanel session={session} />);

    const hooksLink = screen.getByText('Hook Events').closest('a');
    expect(hooksLink?.getAttribute('href')).toBe('/api/sessions/trace-url-test/trace/hooks');
  });

  it('links bundle download to correct URL', () => {
    const session = makeSession({ id: 'trace-url-test' });
    render(<TraceDownloadPanel session={session} />);

    const bundleLink = screen.getByText('Full Bundle').closest('a');
    expect(bundleLink?.getAttribute('href')).toBe('/api/sessions/trace-url-test/trace/bundle');
  });

  it('displays stream event count', () => {
    const session = makeSession({ stream_event_count: 42 });
    render(<TraceDownloadPanel session={session} />);
    expect(screen.getByText('42')).toBeDefined();
  });

  it('displays hook event count', () => {
    const session = makeSession({ hook_event_count: 10 });
    render(<TraceDownloadPanel session={session} />);
    expect(screen.getByText('10')).toBeDefined();
  });

  it('opens download links in new tab', () => {
    const session = makeSession({ id: 'newtab-test' });
    render(<TraceDownloadPanel session={session} />);

    const links = screen.getAllByRole('link');
    for (const link of links) {
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toContain('noopener');
    }
  });
});

// ── MessageStream ────────────────────────────────────────────────────────────

describe('MessageStream', () => {
  it('shows empty state when no messages', () => {
    render(<MessageStream messages={[]} readOnly />);
    expect(screen.getByText('No messages in this session.')).toBeDefined();
  });

  it('renders user message', () => {
    const messages = [
      {
        id: 'msg-1',
        session_id: 'sess-1',
        role: 'user' as const,
        content: 'Hello Claude',
        tool_name: null,
        tool_args: null,
        tool_result: null,
        tool_use_id: null,
        token_in: 10,
        token_out: 0,
        created_at: 1700000000000,
      },
    ];
    render(<MessageStream messages={messages} readOnly />);
    expect(screen.getByText('Hello Claude')).toBeDefined();
    expect(screen.getByText('User')).toBeDefined();
  });

  it('renders assistant message', () => {
    const messages = [
      {
        id: 'msg-2',
        session_id: 'sess-1',
        role: 'assistant' as const,
        content: 'I can help with that.',
        tool_name: null,
        tool_args: null,
        tool_result: null,
        tool_use_id: null,
        token_in: 0,
        token_out: 25,
        created_at: 1700000001000,
      },
    ];
    render(<MessageStream messages={messages} readOnly />);
    expect(screen.getByText('I can help with that.')).toBeDefined();
    expect(screen.getByText('Assistant')).toBeDefined();
  });

  it('renders tool_use message with tool name badge', () => {
    const messages = [
      {
        id: 'msg-3',
        session_id: 'sess-1',
        role: 'tool_use' as const,
        content: null,
        tool_name: 'Bash',
        tool_args: '{"command":"ls -la"}',
        tool_result: null,
        tool_use_id: 'tu-1',
        token_in: null,
        token_out: null,
        created_at: 1700000002000,
      },
    ];
    render(<MessageStream messages={messages} readOnly />);
    expect(screen.getByText('Bash')).toBeDefined();
    expect(screen.getByText('Tool Use')).toBeDefined();
  });

  it('renders tool_result message', () => {
    const messages = [
      {
        id: 'msg-4',
        session_id: 'sess-1',
        role: 'tool_result' as const,
        content: null,
        tool_name: 'Bash',
        tool_args: null,
        tool_result: 'total 42\ndrwxr-xr-x  2 user',
        tool_use_id: 'tu-1',
        token_in: null,
        token_out: null,
        created_at: 1700000003000,
      },
    ];
    render(<MessageStream messages={messages} readOnly />);
    expect(screen.getByText('Tool Result')).toBeDefined();
    expect(screen.getByText(/total 42/)).toBeDefined();
  });

  it('renders multiple messages in order', () => {
    const messages = [
      {
        id: 'msg-a',
        session_id: 'sess-1',
        role: 'user' as const,
        content: 'First message',
        tool_name: null,
        tool_args: null,
        tool_result: null,
        tool_use_id: null,
        token_in: 10,
        token_out: 0,
        created_at: 1700000000000,
      },
      {
        id: 'msg-b',
        session_id: 'sess-1',
        role: 'assistant' as const,
        content: 'Second message',
        tool_name: null,
        tool_args: null,
        tool_result: null,
        tool_use_id: null,
        token_in: 0,
        token_out: 20,
        created_at: 1700000001000,
      },
    ];
    render(<MessageStream messages={messages} readOnly />);
    expect(screen.getByText('First message')).toBeDefined();
    expect(screen.getByText('Second message')).toBeDefined();
  });
});
