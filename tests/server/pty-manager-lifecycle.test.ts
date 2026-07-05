import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface FakePty {
  onDataCbs: Array<(data: string) => void>;
  onExitCbs: Array<(e: { exitCode: number }) => void>;
  onData: (cb: (data: string) => void) => void;
  onExit: (cb: (e: { exitCode: number }) => void) => void;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  spawnEnv: Record<string, string>;
}

const state = vi.hoisted(() => ({
  spawned: [] as Array<{
    onDataCbs: Array<(data: string) => void>;
    onExitCbs: Array<(e: { exitCode: number }) => void>;
    write: ReturnType<typeof import('vitest').vi.fn>;
    resize: ReturnType<typeof import('vitest').vi.fn>;
    kill: ReturnType<typeof import('vitest').vi.fn>;
    spawnEnv: Record<string, string>;
  }>,
}));

vi.mock('node-pty', async () => {
  const { vi } = await import('vitest');
  return {
    spawn: vi.fn(
      (_cmd: string, _args: string[], opts: { env?: Record<string, string> }) => {
        const term = {
          onDataCbs: [] as Array<(data: string) => void>,
          onExitCbs: [] as Array<(e: { exitCode: number }) => void>,
          onData(cb: (data: string) => void) {
            term.onDataCbs.push(cb);
          },
          onExit(cb: (e: { exitCode: number }) => void) {
            term.onExitCbs.push(cb);
          },
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          spawnEnv: opts?.env ?? {},
        };
        state.spawned.push(term);
        return term;
      },
    ),
  };
});

vi.mock('../../server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { PtyManager } from '../../server/pty-manager';
import { ClaudeAdapter } from '../../server/agents/claude-adapter';
import { processRegistry } from '../../server/process-registry';
import logger from '../../server/logger';
import type { Goal } from '../../src/shared/types';
import type { ServerEvent } from '../../src/shared/events';

const goal = { id: 'goal-1', cwd: '/repo', permission_mode: 'supervised', model: 'default' } as Goal;

function lastPty(): FakePty {
  const t = state.spawned[state.spawned.length - 1];
  if (!t) throw new Error('no pty spawned');
  return t as unknown as FakePty;
}

describe('PtyManager lifecycle', () => {
  let broadcasts: ServerEvent[];
  let broadcast: (event: ServerEvent) => void;

  beforeEach(() => {
    state.spawned.length = 0;
    broadcasts = [];
    broadcast = (event) => broadcasts.push(event);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('start / write / resize / interrupt', () => {
    it('broadcasts terminal:started on start and reports alive', () => {
      const mgr = new PtyManager(goal, new ClaudeAdapter(), { broadcast });
      mgr.start();

      expect(state.spawned).toHaveLength(1);
      expect(broadcasts).toContainEqual({ type: 'terminal:started', goal_id: 'goal-1' });
      expect(mgr.isAlive()).toBe(true);
    });

    it('write() forwards data to a live terminal', () => {
      const mgr = new PtyManager(goal, new ClaudeAdapter(), { broadcast });
      mgr.start();

      mgr.write('hello\r');
      expect(lastPty().write).toHaveBeenCalledWith('hello\r');
    });

    it('write() is a no-op before start and after exit', () => {
      const mgr = new PtyManager(goal, new ClaudeAdapter(), { broadcast });
      expect(() => mgr.write('too early')).not.toThrow();

      mgr.start();
      const term = lastPty();
      term.onExitCbs.forEach((cb) => cb({ exitCode: 0 }));

      mgr.write('after exit');
      expect(term.write).not.toHaveBeenCalled();
    });

    it('resize() forwards to the terminal while alive and is a no-op after exit', () => {
      const mgr = new PtyManager(goal, new ClaudeAdapter(), { broadcast });
      mgr.start();
      const term = lastPty();

      mgr.resize(80, 24);
      expect(term.resize).toHaveBeenCalledWith(80, 24);

      term.onExitCbs.forEach((cb) => cb({ exitCode: 0 }));
      term.resize.mockClear();
      mgr.resize(100, 40);
      expect(term.resize).not.toHaveBeenCalled();
    });

    it('resize() swallows errors from the pty and logs a warning', () => {
      const mgr = new PtyManager(goal, new ClaudeAdapter(), { broadcast });
      mgr.start();
      lastPty().resize.mockImplementation(() => {
        throw new Error('resize boom');
      });

      expect(() => mgr.resize(10, 10)).not.toThrow();
      expect(vi.mocked(logger.warn)).toHaveBeenCalled();
    });

    it('interrupt() kills a live terminal; no-op after exit', async () => {
      const mgr = new PtyManager(goal, new ClaudeAdapter(), { broadcast });
      mgr.start();
      const term = lastPty();

      await mgr.interrupt();
      expect(term.kill).toHaveBeenCalledTimes(1);

      term.onExitCbs.forEach((cb) => cb({ exitCode: 0 }));
      await mgr.interrupt();
      expect(term.kill).toHaveBeenCalledTimes(1);
    });

    it('cleanup() drops the terminal reference so isAlive() is false', async () => {
      const mgr = new PtyManager(goal, new ClaudeAdapter(), { broadcast });
      mgr.start();
      expect(mgr.isAlive()).toBe(true);
      await mgr.cleanup();
      expect(mgr.isAlive()).toBe(false);
    });
  });

  describe('onExit', () => {
    it('non-zero exit broadcasts terminal:exited, removes from registry, fires callback, writes trace meta', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-lifecycle-'));
      const traceDir = path.join(tmp, 'goal-1');
      const removeSpy = vi.spyOn(processRegistry, 'remove');
      const onExit = vi.fn();

      const mgr = new PtyManager(goal, new ClaudeAdapter(), {
        broadcast,
        onExit,
        traceDir,
      });
      mgr.start();
      const term = lastPty();

      term.onDataCbs.forEach((cb) => cb('some output\n'));
      term.onExitCbs.forEach((cb) => cb({ exitCode: 42 }));

      expect(broadcasts).toContainEqual({
        type: 'terminal:exited',
        goal_id: 'goal-1',
        exitCode: 42,
      });
      expect(removeSpy).toHaveBeenCalledWith('goal-1');
      expect(onExit).toHaveBeenCalledWith('goal-1', 42);
      expect(mgr.isAlive()).toBe(false);

      // finishTrace is fire-and-forget; give it a beat to flush meta.json
      await new Promise((r) => setTimeout(r, 60));
      const metaPath = path.join(traceDir, 'meta.json');
      expect(fs.existsSync(metaPath)).toBe(true);
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      expect(meta.exitCode).toBe(42);
      expect(meta.session_id).toBe('goal-1');

      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('terminal:data is broadcast for pty output', () => {
      const mgr = new PtyManager(goal, new ClaudeAdapter(), { broadcast });
      mgr.start();
      lastPty().onDataCbs.forEach((cb) => cb('chunk-1'));

      expect(broadcasts).toContainEqual({
        type: 'terminal:data',
        goal_id: 'goal-1',
        data: 'chunk-1',
      });
    });

    it('spawn failure broadcasts terminal:exited with exitCode 1 and marks the manager dead', async () => {
      const pty = await import('node-pty');
      vi.mocked(pty.spawn).mockImplementationOnce(() => {
        throw new Error('spawn failed');
      });

      const mgr = new PtyManager(goal, new ClaudeAdapter(), { broadcast });
      expect(() => mgr.start()).not.toThrow();

      expect(broadcasts).toContainEqual({
        type: 'terminal:exited',
        goal_id: 'goal-1',
        exitCode: 1,
      });
      // start() returns early: no terminal:started
      expect(broadcasts.some((e) => e.type === 'terminal:started')).toBe(false);
      expect(mgr.isAlive()).toBe(false);
    });
  });

  describe('buildEnv (observed via spawn env)', () => {
    const KEY = 'CLAUDE_CODE_USE_VERTEX';
    let saved: string | undefined;

    beforeEach(() => {
      saved = process.env[KEY];
    });

    afterEach(() => {
      if (saved === undefined) delete process.env[KEY];
      else process.env[KEY] = saved;
    });

    it('forces TERM=xterm-256color', () => {
      new PtyManager(goal, new ClaudeAdapter(), { broadcast }).start();
      expect(lastPty().spawnEnv['TERM']).toBe('xterm-256color');
    });

    it("authMode 'vertex' exports CLAUDE_CODE_USE_VERTEX=1 even when not inherited", () => {
      delete process.env[KEY];
      new PtyManager(goal, new ClaudeAdapter(), { broadcast, authMode: 'vertex' }).start();
      expect(lastPty().spawnEnv[KEY]).toBe('1');
    });

    it("authMode 'oauth' strips an inherited CLAUDE_CODE_USE_VERTEX", () => {
      process.env[KEY] = '1';
      new PtyManager(goal, new ClaudeAdapter(), { broadcast, authMode: 'oauth' }).start();
      expect(KEY in lastPty().spawnEnv).toBe(false);
    });

    it('no authMode leaves the inherited value untouched', () => {
      process.env[KEY] = '1';
      new PtyManager(goal, new ClaudeAdapter(), { broadcast }).start();
      expect(lastPty().spawnEnv[KEY]).toBe('1');
    });

    it('inherits arbitrary process env values', () => {
      process.env['PTY_LIFECYCLE_TEST_MARKER'] = 'marker-value';
      try {
        new PtyManager(goal, new ClaudeAdapter(), { broadcast }).start();
        expect(lastPty().spawnEnv['PTY_LIFECYCLE_TEST_MARKER']).toBe('marker-value');
      } finally {
        delete process.env['PTY_LIFECYCLE_TEST_MARKER'];
      }
    });
  });
});
