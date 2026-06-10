import { describe, it, expect } from 'vitest';
import type {
  SpawnContext,
  RawUsage,
  AgentCatalogEntry,
  AgentCapabilities,
} from '../../../src/shared/agents/types';

const ALL_CAPS: AgentCapabilities = {
  canObserveHooks: true,
  canResume: true,
  canMcp: true,
  canApprove: true,
  canStream: true,
};

describe('agent shared types', () => {
  it('SpawnContext is constructible', () => {
    const ctx: SpawnContext = {
      goalId: 'g1',
      model: 'opus',
      cwd: '/tmp',
      permissionMode: 'supervised',
      mcpServer: null,
    };
    expect(ctx.goalId).toBe('g1');
  });

  it('RawUsage carries a per-model breakdown (Delta A)', () => {
    const u: RawUsage = {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      messageCount: 1,
      model: 'claude-opus-4-8',
      byModel: [
        {
          inputTokens: 1,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          messageCount: 1,
          model: 'claude-opus-4-8',
        },
      ],
    };
    expect(u.byModel).toHaveLength(1);
    expect(u.byModel[0].model).toBe('claude-opus-4-8');
  });

  it('AgentCatalogEntry carries a capability matrix (Delta C)', () => {
    const c: AgentCatalogEntry = {
      id: 'claude',
      label: 'Claude Code',
      enabled: true,
      models: [{ value: 'opus', label: 'Opus' }],
      capabilities: ALL_CAPS,
    };
    expect(c.models.length + Number(c.capabilities.canApprove)).toBe(2);
  });
});
