import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { Approval } from '../../src/shared/types';

// ── Utility: mock approval factory ──────────────────────────────────────────

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: 'approval-1',
    session_id: 'sess-1',
    goal_id: 'goal-1',
    tool_name: 'Bash',
    tool_args: JSON.stringify({ command: 'ls -la', description: 'list files' }),
    status: 'pending',
    decided_reason: null,
    requested_at: Date.now(),
    resolved_at: null,
    ...overrides,
  };
}

// ── notifications.ts ────────────────────────────────────────────────────────

describe('notifications', () => {
  // We need to mock Notification at the window level
  let originalNotification: typeof Notification;

  beforeEach(() => {
    originalNotification = globalThis.Notification;
  });

  afterEach(() => {
    globalThis.Notification = originalNotification;
  });

  it('requestPermission wraps Notification.requestPermission', async () => {
    const mockRequestPermission = vi.fn().mockResolvedValue('granted');
    // @ts-expect-error -- mock Notification constructor
    globalThis.Notification = class {
      static permission = 'default';
      static requestPermission = mockRequestPermission;
    };

    const { requestPermission } = await import('../../src/lib/notifications');
    const result = await requestPermission();
    expect(mockRequestPermission).toHaveBeenCalled();
    expect(result).toBe('granted');
  });

  it('notify creates a Notification when permission is granted', async () => {
    const instances: { title: string; options: NotificationOptions }[] = [];
    // @ts-expect-error -- mock Notification constructor
    globalThis.Notification = class {
      static permission = 'granted';
      static requestPermission = vi.fn();
      onclick: (() => void) | null = null;
      constructor(title: string, options: NotificationOptions) {
        instances.push({ title, options });
      }
    };

    // Re-import to pick up mock
    const mod = await import('../../src/lib/notifications');
    const result = mod.notify('Test', 'body text');
    expect(result).not.toBeNull();
    expect(instances).toHaveLength(1);
    expect(instances[0].title).toBe('Test');
    expect(instances[0].options.body).toBe('body text');
  });

  it('notify is a no-op when permission is denied', async () => {
    // @ts-expect-error -- mock Notification constructor
    globalThis.Notification = class {
      static permission = 'denied';
      static requestPermission = vi.fn();
    };

    const mod = await import('../../src/lib/notifications');
    const result = mod.notify('Test', 'body');
    expect(result).toBeNull();
  });

  it('notify is a no-op when permission is default', async () => {
    // @ts-expect-error -- mock Notification constructor
    globalThis.Notification = class {
      static permission = 'default';
      static requestPermission = vi.fn();
    };

    const mod = await import('../../src/lib/notifications');
    const result = mod.notify('Test', 'body');
    expect(result).toBeNull();
  });

  it('getPermission returns denied if Notification API is unavailable', async () => {
    // @ts-expect-error -- remove Notification
    delete globalThis.Notification;

    const mod = await import('../../src/lib/notifications');
    expect(mod.getPermission()).toBe('denied');
  });
});

// ── tab-badge.ts ────────────────────────────────────────────────────────────

describe('tab-badge', () => {
  let originalTitle: string;

  beforeEach(async () => {
    originalTitle = document.title;
    document.title = 'claude-deck';
    const mod = await import('../../src/lib/tab-badge');
    mod._resetForTesting();
  });

  afterEach(() => {
    document.title = originalTitle;
  });

  it('setBadge prefixes document.title with (N)', async () => {
    const { setBadge } = await import('../../src/lib/tab-badge');
    setBadge(3);
    expect(document.title).toBe('(3) claude-deck');
  });

  it('clearBadge restores original title', async () => {
    const { setBadge, clearBadge } = await import('../../src/lib/tab-badge');
    setBadge(5);
    expect(document.title).toBe('(5) claude-deck');
    clearBadge();
    expect(document.title).toBe('claude-deck');
  });

  it('setBadge(0) clears the badge', async () => {
    const { setBadge } = await import('../../src/lib/tab-badge');
    setBadge(3);
    setBadge(0);
    expect(document.title).toBe('claude-deck');
  });

  it('multiple setBadge calls update without stacking prefixes', async () => {
    const { setBadge } = await import('../../src/lib/tab-badge');
    setBadge(1);
    expect(document.title).toBe('(1) claude-deck');
    setBadge(5);
    expect(document.title).toBe('(5) claude-deck');
    setBadge(10);
    expect(document.title).toBe('(10) claude-deck');
  });
});

// ── toast-store.ts ──────────────────────────────────────────────────────────

describe('toast-store', () => {
  beforeEach(async () => {
    const { useToastStore } = await import('../../src/lib/toast-store');
    useToastStore.getState().clearAll();
  });

  it('addToast adds a toast and auto-removes after duration', async () => {
    vi.useFakeTimers();
    const { useToastStore } = await import('../../src/lib/toast-store');

    useToastStore.getState().addToast('info', 'test message', 1000);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(useToastStore.getState().toasts[0].message).toBe('test message');

    vi.advanceTimersByTime(1100);
    expect(useToastStore.getState().toasts).toHaveLength(0);
    vi.useRealTimers();
  });

  it('limits visible toasts to 5', async () => {
    const { useToastStore } = await import('../../src/lib/toast-store');

    for (let i = 0; i < 7; i++) {
      useToastStore.getState().addToast('info', `toast ${i}`, 0);
    }

    expect(useToastStore.getState().toasts).toHaveLength(5);
  });

  it('removeToast removes specific toast', async () => {
    const { useToastStore } = await import('../../src/lib/toast-store');

    const id = useToastStore.getState().addToast('error', 'remove me', 0);
    expect(useToastStore.getState().toasts).toHaveLength(1);

    useToastStore.getState().removeToast(id);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('convenience helpers work', async () => {
    const { toast, useToastStore } = await import('../../src/lib/toast-store');

    toast.info('info msg', 0);
    toast.success('success msg', 0);
    toast.warn('warn msg', 0);
    toast.error('error msg', 0);

    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(4);
    expect(toasts[0].type).toBe('info');
    expect(toasts[1].type).toBe('success');
    expect(toasts[2].type).toBe('warn');
    expect(toasts[3].type).toBe('error');
  });
});

// ── Toast component ─────────────────────────────────────────────────────────

describe('Toast component', () => {
  it('renders message and dismiss button', async () => {
    const ToastComponent = (await import('../../src/components/global/Toast')).default;
    const onDismiss = vi.fn();
    const toastData = {
      id: 'toast-1',
      type: 'error' as const,
      message: 'Something went wrong',
      duration: 5000,
    };

    render(<ToastComponent toast={toastData} onDismiss={onDismiss} />);

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();

    const dismissBtn = screen.getByLabelText('Dismiss notification');
    fireEvent.click(dismissBtn);
    expect(onDismiss).toHaveBeenCalledWith('toast-1');
  });
});

// ── ToastContainer ──────────────────────────────────────────────────────────

describe('ToastContainer', () => {
  it('renders nothing when no toasts exist', async () => {
    const { useToastStore } = await import('../../src/lib/toast-store');
    useToastStore.getState().clearAll();

    const ToastContainer = (await import('../../src/components/global/ToastContainer')).default;
    const { container } = render(<ToastContainer />);
    expect(container.firstChild).toBeNull();
  });

  it('renders toasts when they exist', async () => {
    const { useToastStore } = await import('../../src/lib/toast-store');
    useToastStore.getState().clearAll();
    useToastStore.getState().addToast('info', 'Hello world', 0);

    const ToastContainer = (await import('../../src/components/global/ToastContainer')).default;
    render(<ToastContainer />);

    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });
});

// ── ApprovalCard ────────────────────────────────────────────────────────────

describe('ApprovalCard', () => {
  it('renders tool name and formatted args', async () => {
    const ApprovalCard = (await import('../../src/components/global/ApprovalCard')).default;
    const approval = makeApproval();

    render(
      <ApprovalCard approval={approval} onAllow={vi.fn()} onDeny={vi.fn()} />,
    );

    expect(screen.getByText('Bash')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveAttribute(
      'aria-label',
      'Approval request for Bash',
    );
  });

  it('calls onAllow when Allow button clicked', async () => {
    const ApprovalCard = (await import('../../src/components/global/ApprovalCard')).default;
    const onAllow = vi.fn();
    const approval = makeApproval();

    render(
      <ApprovalCard approval={approval} onAllow={onAllow} onDeny={vi.fn()} />,
    );

    fireEvent.click(screen.getByLabelText('Allow this tool use'));
    expect(onAllow).toHaveBeenCalledWith('approval-1');
  });

  it('calls onDeny when Deny button clicked', async () => {
    const ApprovalCard = (await import('../../src/components/global/ApprovalCard')).default;
    const onDeny = vi.fn();
    const approval = makeApproval();

    render(
      <ApprovalCard approval={approval} onAllow={vi.fn()} onDeny={onDeny} />,
    );

    fireEvent.click(screen.getByLabelText('Deny this tool use'));
    expect(onDeny).toHaveBeenCalledWith('approval-1');
  });

  it('shows countdown timer', async () => {
    const ApprovalCard = (await import('../../src/components/global/ApprovalCard')).default;
    const approval = makeApproval({ requested_at: Date.now() });

    render(
      <ApprovalCard approval={approval} onAllow={vi.fn()} onDeny={vi.fn()} />,
    );

    // Should show approximately 30:00 for a just-created approval
    expect(screen.getByText(/30:0/)).toBeInTheDocument();
  });

  it('disables buttons when expired', async () => {
    vi.useFakeTimers();
    const ApprovalCard = (await import('../../src/components/global/ApprovalCard')).default;
    // requested 31 minutes ago — already expired
    const approval = makeApproval({
      requested_at: Date.now() - 31 * 60 * 1000,
    });

    render(
      <ApprovalCard approval={approval} onAllow={vi.fn()} onDeny={vi.fn()} />,
    );

    const allowBtn = screen.getByLabelText('Allow this tool use');
    const denyBtn = screen.getByLabelText('Deny this tool use');
    expect(allowBtn).toBeDisabled();
    expect(denyBtn).toBeDisabled();
    vi.useRealTimers();
  });
});

// ── ConnectionIndicator ─────────────────────────────────────────────────────

describe('ConnectionIndicator', () => {
  it('shows Connected when status is open', async () => {
    const { useConnectionStore } = await import('../../src/stores/useConnectionStore');
    useConnectionStore.getState().setStatus('open');

    const ConnectionIndicator = (
      await import('../../src/components/global/ConnectionIndicator')
    ).default;

    render(<ConnectionIndicator />);
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute(
      'aria-label',
      'WebSocket status: Connected',
    );
  });

  it('shows Reconnecting when status is connecting', async () => {
    const { useConnectionStore } = await import('../../src/stores/useConnectionStore');
    useConnectionStore.getState().setStatus('connecting');

    const ConnectionIndicator = (
      await import('../../src/components/global/ConnectionIndicator')
    ).default;

    render(<ConnectionIndicator />);
    expect(screen.getByText('Reconnecting')).toBeInTheDocument();
  });

  it('shows Disconnected when status is closed', async () => {
    const { useConnectionStore } = await import('../../src/stores/useConnectionStore');
    useConnectionStore.getState().setStatus('closed');

    const ConnectionIndicator = (
      await import('../../src/components/global/ConnectionIndicator')
    ).default;

    render(<ConnectionIndicator />);
    expect(screen.getByText('Disconnected')).toBeInTheDocument();
  });

  it('shows Connection error when status is error', async () => {
    const { useConnectionStore } = await import('../../src/stores/useConnectionStore');
    useConnectionStore.getState().setStatus('error');

    const ConnectionIndicator = (
      await import('../../src/components/global/ConnectionIndicator')
    ).default;

    render(<ConnectionIndicator />);
    expect(screen.getByText('Connection error')).toBeInTheDocument();
  });
});

// ── GlobalApprovalQueue ─────────────────────────────────────────────────────

describe('GlobalApprovalQueue', () => {
  beforeEach(async () => {
    const { useApprovalsStore } = await import('../../src/stores/useApprovalsStore');
    // Reset store
    useApprovalsStore.setState({ pending: [], resolved: [] });
  });

  it('renders nothing when no pending approvals', async () => {
    const GlobalApprovalQueue = (
      await import('../../src/components/global/GlobalApprovalQueue')
    ).default;

    const { container } = render(
      <MemoryRouter>
        <GlobalApprovalQueue />
      </MemoryRouter>,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders approval cards for pending approvals', async () => {
    const { useApprovalsStore } = await import('../../src/stores/useApprovalsStore');
    const approval = makeApproval();
    useApprovalsStore.getState().addPending(approval);

    const GlobalApprovalQueue = (
      await import('../../src/components/global/GlobalApprovalQueue')
    ).default;

    render(
      <MemoryRouter>
        <GlobalApprovalQueue />
      </MemoryRouter>,
    );

    expect(screen.getByText('Bash')).toBeInTheDocument();
  });

  it('posts decision to API on Approve click', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'approval-1', decision: 'approved' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { useApprovalsStore } = await import('../../src/stores/useApprovalsStore');
    useApprovalsStore.getState().addPending(makeApproval());

    const GlobalApprovalQueue = (
      await import('../../src/components/global/GlobalApprovalQueue')
    ).default;

    render(
      <MemoryRouter>
        <GlobalApprovalQueue />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText('Approve'));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/approvals/approval-1/decide',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision: 'approved' }),
        }),
      );
    });

    fetchSpy.mockRestore();
  });

  it('shows pending count in header', async () => {
    const { useApprovalsStore } = await import('../../src/stores/useApprovalsStore');
    useApprovalsStore.getState().addPending(makeApproval());

    const GlobalApprovalQueue = (
      await import('../../src/components/global/GlobalApprovalQueue')
    ).default;

    render(
      <MemoryRouter>
        <GlobalApprovalQueue />
      </MemoryRouter>,
    );

    expect(screen.getByText('1 approval pending')).toBeInTheDocument();
  });
});

// ── CommandPalette ──────────────────────────────────────────────────────────

describe('CommandPalette', () => {
  it('renders nothing when closed', async () => {
    const CommandPalette = (
      await import('../../src/components/global/CommandPalette')
    ).default;

    const { container } = render(
      <MemoryRouter>
        <CommandPalette isOpen={false} onClose={vi.fn()} />
      </MemoryRouter>,
    );

    expect(container.firstChild).toBeNull();
  });

  it('shows all commands when open with empty query', async () => {
    const CommandPalette = (
      await import('../../src/components/global/CommandPalette')
    ).default;

    render(
      <MemoryRouter>
        <CommandPalette isOpen={true} onClose={vi.fn()} />
      </MemoryRouter>,
    );

    expect(screen.getByText('Board')).toBeInTheDocument();
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('filters commands by query', async () => {
    const CommandPalette = (
      await import('../../src/components/global/CommandPalette')
    ).default;

    render(
      <MemoryRouter>
        <CommandPalette isOpen={true} onClose={vi.fn()} />
      </MemoryRouter>,
    );

    const input = screen.getByLabelText('Search commands');
    await userEvent.type(input, 'sched');

    expect(screen.getByText('Scheduled')).toBeInTheDocument();
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
  });

  it('calls onClose when Escape is pressed', async () => {
    const CommandPalette = (
      await import('../../src/components/global/CommandPalette')
    ).default;
    const onClose = vi.fn();

    render(
      <MemoryRouter>
        <CommandPalette isOpen={true} onClose={onClose} />
      </MemoryRouter>,
    );

    const input = screen.getByLabelText('Search commands');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('has proper ARIA attributes', async () => {
    const CommandPalette = (
      await import('../../src/components/global/CommandPalette')
    ).default;

    render(
      <MemoryRouter>
        <CommandPalette isOpen={true} onClose={vi.fn()} />
      </MemoryRouter>,
    );

    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });
});

// ── useKeyboardShortcuts ────────────────────────────────────────────────────

describe('useKeyboardShortcuts', () => {
  it('Esc sets isCommandPaletteOpen to false', async () => {
    const { useKeyboardShortcuts } = await import('../../src/hooks/useKeyboardShortcuts');
    let hookResult: ReturnType<typeof useKeyboardShortcuts> | null = null;

    function TestComponent() {
      hookResult = useKeyboardShortcuts();
      return <div data-testid="test">test</div>;
    }

    render(
      <MemoryRouter>
        <TestComponent />
      </MemoryRouter>,
    );

    // Open palette via Ctrl+K
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    expect(hookResult!.isCommandPaletteOpen).toBe(true);

    // Close via Escape
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(hookResult!.isCommandPaletteOpen).toBe(false);
  });
});
