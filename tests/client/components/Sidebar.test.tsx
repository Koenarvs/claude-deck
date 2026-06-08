import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { useApprovalsStore } from '../../../src/stores/useApprovalsStore';
import { useSessionsStore } from '../../../src/stores/useSessionsStore';
import type { Approval } from '../../../src/shared/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: `approval-${Math.random().toString(36).slice(2)}`,
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
    json: async () => [],
  });
  // Reset stores
  useApprovalsStore.setState({ pending: [], resolved: [] });
  useSessionsStore.setState({ sessions: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Sidebar', () => {
  it('renders brand name and version', async () => {
    const { default: Sidebar } = await import('../../../src/components/Sidebar');

    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );

    expect(screen.getByText('Claude Deck')).toBeInTheDocument();
    expect(screen.getByText(/v0\.1\.0/)).toBeInTheDocument();
  });

  it('renders all navigation links', async () => {
    const { default: Sidebar } = await import('../../../src/components/Sidebar');

    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );

    expect(screen.getByText('Board')).toBeInTheDocument();
    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.getByText('Analytics')).toBeInTheDocument();
    expect(screen.getByText('Scheduled')).toBeInTheDocument();
    expect(screen.getByText('Skills')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('renders NavLinks with correct destinations', async () => {
    const { default: Sidebar } = await import('../../../src/components/Sidebar');

    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );

    const links = screen.getAllByRole('link');
    const hrefs = links.map((l) => l.getAttribute('href'));
    expect(hrefs).toContain('/board');
    expect(hrefs).toContain('/sessions');
    expect(hrefs).toContain('/analytics');
    expect(hrefs).toContain('/scheduled');
    expect(hrefs).toContain('/skills');
    expect(hrefs).toContain('/settings');
  });

  it('highlights active route', async () => {
    const { default: Sidebar } = await import('../../../src/components/Sidebar');

    render(
      <MemoryRouter initialEntries={['/board']}>
        <Sidebar />
      </MemoryRouter>,
    );

    const boardLink = screen.getByText('Board').closest('a');
    expect(boardLink?.className).toContain('font-medium');
  });

  it('shows pending approvals badge on Board link', async () => {
    const { default: Sidebar } = await import('../../../src/components/Sidebar');

    useApprovalsStore.getState().addPending(makeApproval());
    useApprovalsStore.getState().addPending(makeApproval());

    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );

    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('does not show badge when no pending approvals', async () => {
    const { default: Sidebar } = await import('../../../src/components/Sidebar');

    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );

    // No numeric badges should render
    const boardLink = screen.getByText('Board').closest('a');
    const badge = boardLink?.querySelector('.rounded-full');
    expect(badge).toBeNull();
  });

  it('renders search button with shortcut hint', async () => {
    const { default: Sidebar } = await import('../../../src/components/Sidebar');

    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );

    expect(screen.getByText('Search…')).toBeInTheDocument();
  });

  it('renders UsageStrip in footer with "Today" label', async () => {
    const { default: Sidebar } = await import('../../../src/components/Sidebar');

    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );

    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('$0.00')).toBeInTheDocument();
  });

  it('renders ConnectedStrip showing local connection', async () => {
    const { default: Sidebar } = await import('../../../src/components/Sidebar');

    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );

    expect(screen.getByText('Local')).toBeInTheDocument();
  });

  it('renders brand logo with C letter', async () => {
    const { default: Sidebar } = await import('../../../src/components/Sidebar');

    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );

    expect(screen.getByText('C')).toBeInTheDocument();
  });

  it('UsageStrip fetches and displays session usage data', async () => {
    const { default: Sidebar } = await import('../../../src/components/Sidebar');

    // Mock sessions list fetch
    const sessionData = [
      { id: 'sess-1', started_at: Date.now() },
    ];
    const usageData = {
      estimatedCostUsd: 1.5,
      inputTokens: 5000,
      cacheCreationTokens: 0,
      outputTokens: 2000,
      cacheReadTokens: 10000,
    };

    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => sessionData })   // /api/sessions
      .mockResolvedValueOnce({ ok: true, json: async () => usageData });    // /api/sessions/sess-1/usage

    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('$1.50')).toBeInTheDocument();
    });

    expect(screen.getByText('7.0K new')).toBeInTheDocument();
    expect(screen.getByText('10.0K cached')).toBeInTheDocument();
  });
});
