import { describe, it, expect } from 'vitest';
import { ClaudeAdapter } from '../../../server/agents/claude-adapter';
import type { SpawnContext } from '../../../src/shared/agents/types';

const base: SpawnContext = {
  goalId: 'goal-1',
  model: 'default',
  cwd: '/repo',
  permissionMode: 'supervised',
  mcpServer: null,
};
const a = new ClaudeAdapter();

describe('ClaudeAdapter args (characterization of current pty-manager behavior)', () => {
  it('start: session id only for supervised + default model', () => {
    expect(a.buildStartArgs(base)).toEqual(['--session-id', 'goal-1']);
  });

  it('start: adds bypassPermissions for autonomous and --model for non-default', () => {
    expect(a.buildStartArgs({ ...base, permissionMode: 'autonomous', model: 'opus' })).toEqual([
      '--session-id', 'goal-1', '--permission-mode', 'bypassPermissions', '--model', 'opus',
    ]);
  });

  it('start: serializes the mcp descriptor into --mcp-config', () => {
    const args = a.buildStartArgs({
      ...base,
      mcpServer: {
        name: 'claude-deck',
        command: 'node',
        args: ['/x/index.js'],
        env: { CLAUDE_DECK_URL: 'http://127.0.0.1:4100', CLAUDE_DECK_GOAL_ID: 'goal-1' },
      },
    });
    const idx = args.indexOf('--mcp-config');
    expect(idx).toBeGreaterThan(-1);
    expect(JSON.parse(args[idx + 1])).toEqual({
      mcpServers: {
        'claude-deck': {
          command: 'node',
          args: ['/x/index.js'],
          env: { CLAUDE_DECK_URL: 'http://127.0.0.1:4100', CLAUDE_DECK_GOAL_ID: 'goal-1' },
        },
      },
    });
  });

  it('resume: --resume first, no --model (matches today)', () => {
    expect(a.buildResumeArgs('sess-9', { ...base, model: 'opus' })).toEqual(['--resume', 'sess-9']);
  });

  it('resume: adds bypassPermissions for autonomous', () => {
    expect(a.buildResumeArgs('sess-9', { ...base, permissionMode: 'autonomous' })).toEqual([
      '--resume', 'sess-9', '--permission-mode', 'bypassPermissions',
    ]);
  });

  it('catalog: exposes default/opus/sonnet/haiku and all capabilities true', () => {
    expect(a.models.map((m) => m.value)).toEqual(['default', 'opus', 'sonnet', 'haiku']);
    expect(a.capabilities).toEqual({
      canObserveHooks: true, canResume: true, canMcp: true, canApprove: true, canStream: true,
    });
  });
});
