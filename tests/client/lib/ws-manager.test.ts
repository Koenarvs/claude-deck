import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Terminal/conversation event emitters are mocked so dispatch can be asserted
// without wiring real listeners.
vi.mock('../../../src/lib/terminal-events', () => ({
  emitTerminalData: vi.fn(),
  emitTerminalStarted: vi.fn(),
  emitTerminalExited: vi.fn(),
}));
vi.mock('../../../src/lib/conversation-events', () => ({
  emitConversationUpdated: vi.fn(),
}));

// ── WebSocket mock ───────────────────────────────────────────────────────────

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  send = vi.fn();
  close = vi.fn();
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(data: unknown): void {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  }

  simulateClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

type WsModule = typeof import('../../../src/lib/ws-manager');
type ConnectionStoreModule = typeof import('../../../src/stores/useConnectionStore');
type TerminalEventsModule = typeof import('../../../src/lib/terminal-events');

/**
 * ws-manager holds module-level singleton state (ws, reconnectAttempt,
 * initialized), so every test imports a fresh copy of the module graph.
 */
async function freshModules(): Promise<{
  wsManager: WsModule;
  connectionStore: ConnectionStoreModule['useConnectionStore'];
  terminalEvents: TerminalEventsModule;
}> {
  vi.resetModules();
  const wsManager = await import('../../../src/lib/ws-manager');
  const { useConnectionStore } = await import('../../../src/stores/useConnectionStore');
  const terminalEvents = await import('../../../src/lib/terminal-events');
  return { wsManager, connectionStore: useConnectionStore, terminalEvents };
}

function mount(wsManager: WsModule): MockWebSocket {
  renderHook(() => wsManager.useWsManager());
  const inst = MockWebSocket.instances[MockWebSocket.instances.length - 1];
  if (!inst) throw new Error('useWsManager did not open a WebSocket');
  return inst;
}

describe('ws-manager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('connection lifecycle', () => {
    it('connects on first mount, sets status to connecting, then open + subscribes', async () => {
      const { wsManager, connectionStore } = await freshModules();

      const inst = mount(wsManager);
      expect(MockWebSocket.instances).toHaveLength(1);
      expect(inst.url).toMatch(/^ws(s)?:\/\/.+\/ws$/);
      expect(connectionStore.getState().status).toBe('connecting');

      act(() => inst.simulateOpen());
      expect(connectionStore.getState().status).toBe('open');
      expect(inst.send).toHaveBeenCalledWith(JSON.stringify({ type: 'subscribe', goals: 'all' }));
    });

    it('is a singleton: repeated mounts do not open extra connections', async () => {
      const { wsManager } = await freshModules();

      mount(wsManager);
      renderHook(() => wsManager.useWsManager());
      renderHook(() => wsManager.useWsManager());

      expect(MockWebSocket.instances).toHaveLength(1);
    });

    it('sets status to error on socket error without dropping the connection state machine', async () => {
      const { wsManager, connectionStore } = await freshModules();
      const inst = mount(wsManager);

      act(() => inst.onerror?.());
      expect(connectionStore.getState().status).toBe('error');

      // A subsequent close still transitions to closed and schedules reconnect
      act(() => inst.simulateClose());
      expect(connectionStore.getState().status).toBe('closed');
    });
  });

  describe('reconnect backoff', () => {
    it('reconnects after the base delay (1s) when the socket closes', async () => {
      const { wsManager, connectionStore } = await freshModules();
      const inst = mount(wsManager);

      act(() => inst.simulateClose());
      expect(connectionStore.getState().status).toBe('closed');
      expect(MockWebSocket.instances).toHaveLength(1);

      act(() => void vi.advanceTimersByTime(999));
      expect(MockWebSocket.instances).toHaveLength(1);

      act(() => void vi.advanceTimersByTime(1));
      expect(MockWebSocket.instances).toHaveLength(2);
      expect(connectionStore.getState().status).toBe('connecting');
    });

    it('doubles the delay per attempt and caps at 30s', async () => {
      const { wsManager } = await freshModules();
      mount(wsManager);

      // attempt n uses delay min(1000 * 2^n, 30000); attempts 0..4 -> 1s..16s,
      // attempt 5 would be 32s -> capped at 30s, and stays capped afterwards.
      const expectedDelays = [1000, 2000, 4000, 8000, 16000, 30000, 30000];

      for (const [i, delay] of expectedDelays.entries()) {
        const current = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
        act(() => current.simulateClose());

        act(() => void vi.advanceTimersByTime(delay - 1));
        expect(MockWebSocket.instances, `attempt ${i}: fired early`).toHaveLength(i + 1);

        act(() => void vi.advanceTimersByTime(1));
        expect(MockWebSocket.instances, `attempt ${i}: did not fire`).toHaveLength(i + 2);
      }
    });

    it('resets the backoff after a successful open', async () => {
      const { wsManager } = await freshModules();
      const first = mount(wsManager);

      // Two failed cycles: delays 1s then 2s
      act(() => first.simulateClose());
      act(() => void vi.advanceTimersByTime(1000));
      const second = MockWebSocket.instances[1]!;
      act(() => second.simulateClose());
      act(() => void vi.advanceTimersByTime(2000));
      const third = MockWebSocket.instances[2]!;

      // Successful open resets reconnectAttempt to 0
      act(() => third.simulateOpen());
      act(() => third.simulateClose());

      act(() => void vi.advanceTimersByTime(999));
      expect(MockWebSocket.instances).toHaveLength(3);
      act(() => void vi.advanceTimersByTime(1));
      expect(MockWebSocket.instances).toHaveLength(4);
    });

    it('does not open a duplicate socket while one is still CONNECTING', async () => {
      const { wsManager } = await freshModules();
      const inst = mount(wsManager);

      act(() => inst.simulateClose());
      act(() => void vi.advanceTimersByTime(1000));
      expect(MockWebSocket.instances).toHaveLength(2);

      // No further reconnect timers should fire while attempt 2 is CONNECTING
      act(() => void vi.advanceTimersByTime(60_000));
      expect(MockWebSocket.instances).toHaveLength(2);
    });
  });

  describe('message dispatch', () => {
    it('dispatches terminal events to the terminal-events emitters', async () => {
      const { wsManager, terminalEvents } = await freshModules();
      const inst = mount(wsManager);
      act(() => inst.simulateOpen());

      act(() =>
        inst.simulateMessage({ type: 'terminal:data', goal_id: 'g1', data: 'chunk' }),
      );
      expect(terminalEvents.emitTerminalData).toHaveBeenCalledWith('g1', 'chunk');

      act(() => inst.simulateMessage({ type: 'terminal:started', goal_id: 'g1' }));
      expect(terminalEvents.emitTerminalStarted).toHaveBeenCalledWith('g1');

      act(() =>
        inst.simulateMessage({ type: 'terminal:exited', goal_id: 'g1', exitCode: 7 }),
      );
      expect(terminalEvents.emitTerminalExited).toHaveBeenCalledWith('g1', 7);
    });

    it('updates the sessions store on session:observed', async () => {
      const { wsManager } = await freshModules();
      const { useSessionsStore } = await import('../../../src/stores/useSessionsStore');
      const inst = mount(wsManager);
      act(() => inst.simulateOpen());

      const session = {
        id: 'sess-1',
        goal_id: 'g1',
        origin: 'dashboard',
        cwd: null,
        model: null,
        trace_dir: null,
        stream_event_count: 0,
        hook_event_count: 0,
        stderr_bytes: 0,
        started_at: 1700000000000,
        ended_at: null,
      };
      act(() => inst.simulateMessage({ type: 'session:observed', session }));

      const stored = useSessionsStore.getState().sessions.find((s) => s.id === 'sess-1');
      expect(stored).toBeDefined();
      expect(stored?.goal_id).toBe('g1');
    });

    it('ignores events that fail schema validation', async () => {
      const { wsManager, terminalEvents } = await freshModules();
      const inst = mount(wsManager);
      act(() => inst.simulateOpen());

      expect(() =>
        act(() => inst.simulateMessage({ type: 'terminal:data', goal_id: 'g1' })), // missing data
      ).not.toThrow();
      expect(() =>
        act(() => inst.simulateMessage({ type: 'no-such-event' })),
      ).not.toThrow();
      expect(terminalEvents.emitTerminalData).not.toHaveBeenCalled();
    });

    it('ignores malformed JSON frames', async () => {
      const { wsManager } = await freshModules();
      const inst = mount(wsManager);
      act(() => inst.simulateOpen());

      expect(() => act(() => inst.simulateMessage('{not json'))).not.toThrow();
    });
  });

  describe('sendWsMessage', () => {
    it('sends JSON when the socket is open', async () => {
      const { wsManager } = await freshModules();
      const inst = mount(wsManager);
      act(() => inst.simulateOpen());
      inst.send.mockClear();

      wsManager.sendWsMessage({ type: 'ping', n: 1 });
      expect(inst.send).toHaveBeenCalledWith(JSON.stringify({ type: 'ping', n: 1 }));
    });

    it('silently drops messages while the socket is not open', async () => {
      const { wsManager } = await freshModules();
      const inst = mount(wsManager); // still CONNECTING

      expect(() => wsManager.sendWsMessage({ type: 'ping' })).not.toThrow();
      expect(inst.send).not.toHaveBeenCalled();

      act(() => inst.simulateClose());
      expect(() => wsManager.sendWsMessage({ type: 'ping' })).not.toThrow();
      expect(inst.send).not.toHaveBeenCalled();
    });
  });
});
