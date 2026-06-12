import { describe, it, expect } from 'vitest';
import {
  OrchestratorConfigSchema,
  DEFAULT_ORCHESTRATOR_CONFIG,
} from '../../src/shared/orchestrator';
import { ChannelInboundSchema } from '../../src/shared/orchestrator-channels';

describe('discord_owner_id config field', () => {
  it('defaults discord_owner_id to null', () => {
    const parsed = OrchestratorConfigSchema.parse(DEFAULT_ORCHESTRATOR_CONFIG);
    expect(parsed.discord_owner_id).toBeNull();
  });

  it('accepts a string owner id and back-fills null when omitted (migration-025 seed)', () => {
    const fromSeed = OrchestratorConfigSchema.parse({
      enabled: true,
      persona_name: 'Hawat',
      model: 'haiku',
      idle_timeout_ms: 600000,
      max_concurrent_children: 3,
      max_depth: 2,
    });
    expect(fromSeed.discord_owner_id).toBeNull();
    expect(
      OrchestratorConfigSchema.parse({ ...DEFAULT_ORCHESTRATOR_CONFIG, discord_owner_id: '42' })
        .discord_owner_id,
    ).toBe('42');
  });
});

describe('ChannelInboundSchema', () => {
  it('requires userId, text, and chatId', () => {
    expect(() => ChannelInboundSchema.parse({ text: 'hi' })).toThrow();
    const ok = ChannelInboundSchema.parse({ userId: 'u1', text: 'status?', chatId: 'c1' });
    expect(ok).toEqual({ userId: 'u1', text: 'status?', chatId: 'c1' });
  });

  it('carries an optional messageId for quote-replies', () => {
    const ok = ChannelInboundSchema.parse({ userId: 'u1', text: 'hi', chatId: 'c1', messageId: 'm9' });
    expect(ok.messageId).toBe('m9');
  });
});
