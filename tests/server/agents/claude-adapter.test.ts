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

  it('start: adds --dangerously-skip-permissions for autonomous and --model for non-default', () => {
    expect(a.buildStartArgs({ ...base, permissionMode: 'autonomous', model: 'opus' })).toEqual([
      '--session-id', 'goal-1', '--dangerously-skip-permissions', '--model', 'opus',
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

  it('resume: adds --dangerously-skip-permissions for autonomous', () => {
    expect(a.buildResumeArgs('sess-9', { ...base, permissionMode: 'autonomous' })).toEqual([
      '--resume', 'sess-9', '--dangerously-skip-permissions',
    ]);
  });

  it('start: adds --agent when agentType is set', () => {
    expect(a.buildStartArgs({ ...base, agentType: 'dev-looker' })).toEqual([
      '--session-id', 'goal-1', '--agent', 'dev-looker',
    ]);
  });

  it('start: combines autonomous + model + agent', () => {
    expect(a.buildStartArgs({ ...base, permissionMode: 'autonomous', model: 'sonnet', agentType: 'research' })).toEqual([
      '--session-id', 'goal-1', '--dangerously-skip-permissions', '--model', 'sonnet', '--agent', 'research',
    ]);
  });

  it('resume: adds --agent when agentType is set', () => {
    expect(a.buildResumeArgs('sess-9', { ...base, agentType: 'eval' })).toEqual([
      '--resume', 'sess-9', '--agent', 'eval',
    ]);
  });

  it('start: omits --agent when agentType is null or empty', () => {
    expect(a.buildStartArgs({ ...base, agentType: null })).toEqual(['--session-id', 'goal-1']);
    expect(a.buildStartArgs({ ...base, agentType: undefined })).toEqual(['--session-id', 'goal-1']);
  });

  it('catalog: exposes default + every registry claude model, all capabilities true', () => {
    // Derived from MODEL_REGISTRY (provider 'claude') with the 'default' sentinel first.
    expect(a.models.map((m) => m.value)).toEqual(['default', 'fable-5', 'opus', 'sonnet', 'haiku']);
    expect(a.capabilities).toEqual({
      canObserveHooks: true, canResume: true, canMcp: true, canApprove: true, canStream: true,
    });
  });
});
