import { describe, it, expect, vi } from 'vitest';
import { PtyManager } from '../../server/pty-manager';
import { ClaudeAdapter } from '../../server/agents/claude-adapter';
import type { Goal } from '../../src/shared/types';

const goal = {
  id: 'goal-1',
  cwd: '/repo',
  model: 'opus',
  permission_mode: 'autonomous',
} as Goal;

describe('PtyManager + adapter', () => {
  it('builds start argv via the adapter (no real spawn)', () => {
    const adapter = new ClaudeAdapter();
    const spy = vi.spyOn(adapter, 'buildStartArgs');
    const mgr = new PtyManager(goal, adapter, { broadcast: () => {} });
    const args = mgr.buildLaunchArgs();
    // session id + autonomous bypass + non-default model; mcp-config appended last.
    expect(args.slice(0, 6)).toEqual([
      '--session-id', 'goal-1', '--permission-mode', 'bypassPermissions', '--model', 'opus',
    ]);
    expect(spy).toHaveBeenCalledOnce();
  });

  it('omits --model for the default model', () => {
    const adapter = new ClaudeAdapter();
    const mgr = new PtyManager({ ...goal, model: 'default', permission_mode: 'supervised' } as Goal, adapter, {
      broadcast: () => {},
    });
    const args = mgr.buildLaunchArgs();
    expect(args.includes('--model')).toBe(false);
    expect(args.slice(0, 2)).toEqual(['--session-id', 'goal-1']);
  });
});
