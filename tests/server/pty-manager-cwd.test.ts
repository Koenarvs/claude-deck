import { describe, it, expect, vi, beforeEach } from 'vitest';

let spawnCwd: string | undefined;
vi.mock('node-pty', () => ({
  spawn: (_cmd: string, _args: string[], opts: { cwd?: string }) => {
    spawnCwd = opts?.cwd;
    return {
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
  },
}));
vi.mock('../../server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { PtyManager } from '../../server/pty-manager';
import { ClaudeAdapter } from '../../server/agents/claude-adapter';
import type { Goal } from '../../src/shared/types';

const goal = { id: 'g1', cwd: '/repo', permission_mode: 'supervised', model: 'default' } as Goal;

describe('PtyManager spawn cwd (5B)', () => {
  beforeEach(() => {
    spawnCwd = undefined;
  });

  it('spawns in goal.cwd by default', () => {
    new PtyManager(goal, new ClaudeAdapter(), { broadcast: vi.fn() }).start();
    expect(spawnCwd).toBe('/repo');
  });

  it('spawns in cwdOverride (isolated worktree) when provided', () => {
    new PtyManager(goal, new ClaudeAdapter(), {
      broadcast: vi.fn(),
      cwdOverride: '/wt/g1',
    }).start();
    expect(spawnCwd).toBe('/wt/g1');
  });
});
