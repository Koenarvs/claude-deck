import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { useUIConfigStore } from '../../../src/stores/useUIConfigStore';

// Mock TerminalPanel — xterm.js requires real browser APIs unavailable in jsdom
vi.mock('@/components/goal/TerminalPanel', () => ({
  default: ({ goalId }: { goalId: string }) => <div data-testid="terminal-panel">Terminal: {goalId}</div>,
}));

// ── Mock fetch ───────────────────────────────────────────────────────────────

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => [],
  });
  // Reset UI config to defaults
  useUIConfigStore.setState({
    aesthetic: 'mission',
    theme: 'dark',
    boardLayout: 'columns',
    liveActivity: 'on',
    tweaksOpen: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AppShell', () => {
  it('renders Sidebar alongside main content area', async () => {
    const { default: AppShell } = await import('../../../src/components/AppShell');

    render(
      <MemoryRouter>
        <AppShell>
          <div data-testid="child-content">Page Content</div>
        </AppShell>
      </MemoryRouter>,
    );

    // Sidebar brand
    expect(screen.getByText('Claude Deck')).toBeInTheDocument();
    // Children rendered in main area
    expect(screen.getByTestId('child-content')).toBeInTheDocument();
    expect(screen.getByText('Page Content')).toBeInTheDocument();
  });

  it('renders children inside a main element', async () => {
    const { default: AppShell } = await import('../../../src/components/AppShell');

    render(
      <MemoryRouter>
        <AppShell>
          <div>Test Child</div>
        </AppShell>
      </MemoryRouter>,
    );

    const main = screen.getByRole('main');
    expect(main).toBeInTheDocument();
    expect(main).toHaveTextContent('Test Child');
  });

  it('renders navigation links from Sidebar', async () => {
    const { default: AppShell } = await import('../../../src/components/AppShell');

    render(
      <MemoryRouter>
        <AppShell>
          <div>Content</div>
        </AppShell>
      </MemoryRouter>,
    );

    expect(screen.getByText('Board')).toBeInTheDocument();
    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('renders global overlays (ConnectionIndicator, ToastContainer)', async () => {
    const { default: AppShell } = await import('../../../src/components/AppShell');
    const { useConnectionStore } = await import('../../../src/stores/useConnectionStore');
    useConnectionStore.getState().setStatus('open');

    render(
      <MemoryRouter>
        <AppShell>
          <div>Content</div>
        </AppShell>
      </MemoryRouter>,
    );

    // ConnectionIndicator renders a status element
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it('does not render TweaksPanel when tweaksOpen is false', async () => {
    const { default: AppShell } = await import('../../../src/components/AppShell');

    useUIConfigStore.setState({ tweaksOpen: false });

    render(
      <MemoryRouter>
        <AppShell>
          <div>Content</div>
        </AppShell>
      </MemoryRouter>,
    );

    // TweaksPanel should not be in the DOM
    expect(screen.queryByText('UI Tweaks')).not.toBeInTheDocument();
  });

  it('applies UI config data attributes to document root', async () => {
    const { default: AppShell } = await import('../../../src/components/AppShell');

    useUIConfigStore.setState({
      aesthetic: 'console',
      theme: 'dark',
      liveActivity: 'subtle',
    });

    render(
      <MemoryRouter>
        <AppShell>
          <div>Content</div>
        </AppShell>
      </MemoryRouter>,
    );

    const root = document.documentElement;
    expect(root.getAttribute('data-aesthetic')).toBe('console');
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(root.getAttribute('data-live')).toBe('subtle');
  });

  describe('global approval queue', () => {
    function approval(over: Record<string, unknown> = {}) {
      return {
        id: 'ap-1',
        session_id: 's1',
        goal_id: 'g1abcdef99',
        tool_name: 'Bash',
        tool_args: JSON.stringify({ command: 'ls' }),
        status: 'pending' as const,
        decided_reason: null,
        requested_at: Date.now(),
        resolved_at: null,
        ...over,
      };
    }

    it('does not render the queue when there are no pending approvals', async () => {
      const { default: AppShell } = await import('../../../src/components/AppShell');
      const { useApprovalsStore } = await import('../../../src/stores/useApprovalsStore');
      useApprovalsStore.setState({ pending: [], resolved: [] });

      render(
        <MemoryRouter>
          <AppShell>
            <div>child</div>
          </AppShell>
        </MemoryRouter>,
      );
      expect(screen.queryByText(/approval.*pending/i)).toBeNull();
    });

    it('renders the queue when an approval is pending', async () => {
      const { default: AppShell } = await import('../../../src/components/AppShell');
      const { useApprovalsStore } = await import('../../../src/stores/useApprovalsStore');
      useApprovalsStore.setState({ pending: [approval()], resolved: [] });

      render(
        <MemoryRouter>
          <AppShell>
            <div>child</div>
          </AppShell>
        </MemoryRouter>,
      );
      expect(screen.getByText(/1 approval pending/i)).toBeInTheDocument();
      expect(screen.getByText('Bash')).toBeInTheDocument();

      useApprovalsStore.setState({ pending: [], resolved: [] });
    });
  });
});
