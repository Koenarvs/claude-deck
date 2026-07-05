import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { HeadroomConfig } from '../../../src/shared/types';

// Mock isVertex so we can test both Vertex and non-Vertex command building, and
// stub regionFromClaudeSettings to undefined so command-building tests stay
// hermetic (the real fn reads ~/.claude/settings.json) — region then derives
// purely from the CLOUD_ML_REGION we set in process.env below. Region precedence
// and the settings fallback are covered in tests/server/headroom-env.test.ts.
const isVertexMock = vi.fn((..._args: unknown[]) => true);
vi.mock('../../../server/headroom-env', async (importActual) => {
  const actual = await importActual<typeof import('../../../server/headroom-env')>();
  return {
    ...actual,
    isVertex: (...args: unknown[]) => isVertexMock(...args),
    regionFromClaudeSettings: () => undefined,
  };
});

const { buildHeadroomCommand, HeadroomService, makePortReclaimer, portFromBaseUrl } = await import('../../../server/services/headroom-service');

/** No-op reclaimer so service tests never touch the real machine's ports. */
const noReclaim = (): void => {};

const base: HeadroomConfig = {
  enabled: true,
  baseUrl: 'http://localhost:8787',
  launchOnStartup: true,
  compressionDegree: 'balanced',
  interceptToolResults: false,
  memory: false,
};

beforeEach(() => {
  isVertexMock.mockReturnValue(true);
  process.env['CLOUD_ML_REGION'] = 'us-east5';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['CLOUD_ML_REGION'];
});

describe('buildHeadroomCommand', () => {
  it('builds the balanced command with --vertex-api-url and --region on Vertex', () => {
    expect(buildHeadroomCommand(base)).toBe(
      'headroom proxy --port 8787 --vertex-api-url https://us-east5-aiplatform.googleapis.com --region us-east5 --target-ratio 0.4',
    );
  });

  it('omits the Vertex flags on non-Vertex stacks', () => {
    isVertexMock.mockReturnValue(false);
    expect(buildHeadroomCommand(base)).toBe(
      'headroom proxy --port 8787 --target-ratio 0.4',
    );
  });

  it('defaults region to us-east5 when CLOUD_ML_REGION is unset', () => {
    delete process.env['CLOUD_ML_REGION'];
    expect(buildHeadroomCommand(base)).toContain(
      '--vertex-api-url https://us-east5-aiplatform.googleapis.com --region us-east5',
    );
  });

  it('uses the multi-region host shape and region for us/eu', () => {
    process.env['CLOUD_ML_REGION'] = 'us';
    expect(buildHeadroomCommand(base)).toContain('--vertex-api-url https://aiplatform.us.rep.googleapis.com --region us');
    process.env['CLOUD_ML_REGION'] = 'eu';
    expect(buildHeadroomCommand(base)).toContain('--vertex-api-url https://aiplatform.eu.rep.googleapis.com --region eu');
  });

  it('uses the bare host for the global region', () => {
    process.env['CLOUD_ML_REGION'] = 'global';
    expect(buildHeadroomCommand(base)).toContain('--vertex-api-url https://aiplatform.googleapis.com --region global');
  });

  it('prefers an explicit vertexApiUrl override for the host but still sends --region', () => {
    process.env['CLOUD_ML_REGION'] = 'us';
    expect(buildHeadroomCommand({ ...base, vertexApiUrl: 'https://custom.example.com' })).toContain(
      '--vertex-api-url https://custom.example.com --region us',
    );
  });

  it('maps each compression degree to the right flag', () => {
    expect(buildHeadroomCommand({ ...base, compressionDegree: 'off' })).toContain('--no-optimize');
    expect(buildHeadroomCommand({ ...base, compressionDegree: 'light' })).toContain('--target-ratio 0.6');
    expect(buildHeadroomCommand({ ...base, compressionDegree: 'aggressive' })).toContain('--target-ratio 0.3');
  });

  it('appends feature flags only when enabled', () => {
    const cmd = buildHeadroomCommand({ ...base, interceptToolResults: true, memory: true });
    expect(cmd).toContain('--intercept-tool-results');
    expect(cmd).toContain('--memory');
    const none = buildHeadroomCommand(base);
    expect(none).not.toContain('--intercept-tool-results');
    expect(none).not.toContain('--memory');
  });

  it('derives the port from baseUrl', () => {
    expect(buildHeadroomCommand({ ...base, baseUrl: 'http://localhost:9001' })).toContain('--port 9001');
  });

  it('uses the advanced command override verbatim when set', () => {
    expect(buildHeadroomCommand({ ...base, command: 'headroom proxy --custom' })).toBe('headroom proxy --custom');
  });
});

describe('HeadroomService crash recovery', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('mocked'));
  });
  function makeFakeChild() {
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    const self = {
      pid: 123,
      exitCode: null as number | null,
      killed: false,
      once(event: string, cb: (...args: unknown[]) => void) {
        (listeners[event] ??= []).push(cb);
      },
      kill() {
        self.killed = true;
        self.exitCode = 1;
        for (const cb of listeners['exit'] ?? []) cb(1, 'SIGTERM');
      },
      emit(event: string, ...args: unknown[]) {
        if (event === 'exit') { self.exitCode = (args[0] as number) ?? null; }
        for (const cb of listeners[event] ?? []) cb(...args);
      },
    };
    return self;
  }

  it('respawns the proxy after unexpected exit', async () => {
    const origDelay = HeadroomService.RESTART_DELAY_MS;
    (HeadroomService as { RESTART_DELAY_MS: number }).RESTART_DELAY_MS = 50;

    const children: ReturnType<typeof makeFakeChild>[] = [];
    const spawnFn = vi.fn(() => { const c = makeFakeChild(); children.push(c); return c; });
    const svc = new HeadroomService(spawnFn as never, noReclaim);

    svc.sync(base);
    await new Promise(r => setTimeout(r, 50));
    expect(spawnFn).toHaveBeenCalledTimes(1);

    children[0].emit('spawn');
    children[0].emit('exit', 1);
    expect(spawnFn).toHaveBeenCalledTimes(1);

    await new Promise(r => setTimeout(r, 200));
    expect(spawnFn).toHaveBeenCalledTimes(2);

    await svc.shutdown();
    (HeadroomService as { RESTART_DELAY_MS: number }).RESTART_DELAY_MS = origDelay;
  }, 5_000);

  it('stops respawning after MAX_CRASH_RESTARTS', async () => {
    vi.useFakeTimers();
    const children: ReturnType<typeof makeFakeChild>[] = [];
    const spawnFn = vi.fn(() => { const c = makeFakeChild(); children.push(c); return c; });
    const svc = new HeadroomService(spawnFn as never, noReclaim);

    svc.sync(base);
    await vi.advanceTimersByTimeAsync(0);
    expect(spawnFn).toHaveBeenCalledTimes(1);

    for (let i = 0; i < HeadroomService.MAX_CRASH_RESTARTS; i++) {
      children[children.length - 1].emit('exit', 1);
      await vi.advanceTimersByTimeAsync(HeadroomService.RESTART_DELAY_MS + 100);
      expect(spawnFn).toHaveBeenCalledTimes(i + 2);
    }

    const callsBefore = spawnFn.mock.calls.length;
    children[children.length - 1].emit('exit', 1);
    await vi.advanceTimersByTimeAsync(HeadroomService.RESTART_DELAY_MS + 100);
    expect(spawnFn).toHaveBeenCalledTimes(callsBefore);

    await svc.shutdown();
    vi.useRealTimers();
  });

  it('counts spawn-then-quick-crash toward the cap (does not reset crashCount on spawn)', async () => {
    vi.useFakeTimers();
    const children: ReturnType<typeof makeFakeChild>[] = [];
    const spawnFn = vi.fn(() => { const c = makeFakeChild(); children.push(c); return c; });
    const svc = new HeadroomService(spawnFn as never, noReclaim);

    svc.sync(base);
    await vi.advanceTimersByTimeAsync(0);
    expect(spawnFn).toHaveBeenCalledTimes(1);

    // Each attempt spawns successfully, then dies well before STABLE_AFTER_MS
    // (e.g. it can't bind the port). Because the counter resets only after the
    // grace period — never on spawn — the loop must still surrender at the cap.
    for (let i = 0; i < HeadroomService.MAX_CRASH_RESTARTS; i++) {
      const c = children[children.length - 1];
      c.emit('spawn');
      c.emit('exit', 1);
      await vi.advanceTimersByTimeAsync(HeadroomService.RESTART_DELAY_MS + 100);
      expect(spawnFn).toHaveBeenCalledTimes(i + 2);
    }

    const callsBefore = spawnFn.mock.calls.length;
    const last = children[children.length - 1];
    last.emit('spawn');
    last.emit('exit', 1);
    await vi.advanceTimersByTimeAsync(HeadroomService.RESTART_DELAY_MS + 100);
    expect(spawnFn).toHaveBeenCalledTimes(callsBefore);

    await svc.shutdown();
    vi.useRealTimers();
  });
});

describe('portFromBaseUrl', () => {
  it('extracts the port from a baseUrl', () => {
    expect(portFromBaseUrl('http://localhost:9001')).toBe('9001');
  });
  it('defaults to 8787 when absent or unparseable', () => {
    expect(portFromBaseUrl('http://localhost')).toBe('8787');
    expect(portFromBaseUrl('not a url')).toBe('8787');
  });
});

describe('makePortReclaimer', () => {
  it('kills a stale headroom squatter', () => {
    const killed: number[] = [];
    const reclaim = makePortReclaimer({
      listenerPids: () => [16020],
      isHeadroomPid: () => true,
      killTree: (pid) => killed.push(pid),
    });
    reclaim('8787');
    expect(killed).toEqual([16020]);
  });

  it('leaves a foreign non-headroom process alone', () => {
    const killed: number[] = [];
    const reclaim = makePortReclaimer({
      listenerPids: () => [4321],
      isHeadroomPid: () => false,
      killTree: (pid) => killed.push(pid),
    });
    reclaim('8787');
    expect(killed).toEqual([]);
  });

  it('never kills our own pid', () => {
    const killed: number[] = [];
    const reclaim = makePortReclaimer({
      listenerPids: () => [999],
      isHeadroomPid: () => true,
      killTree: (pid) => killed.push(pid),
    });
    reclaim('8787', 999);
    expect(killed).toEqual([]);
  });

  it('is a no-op when nothing is listening', () => {
    const killed: number[] = [];
    const reclaim = makePortReclaimer({
      listenerPids: () => [],
      isHeadroomPid: () => true,
      killTree: (pid) => killed.push(pid),
    });
    reclaim('8787');
    expect(killed).toEqual([]);
  });
});
