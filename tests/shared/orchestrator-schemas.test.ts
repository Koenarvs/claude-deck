import { describe, it, expect } from 'vitest';
import {
  OrchestratorConfigSchema,
  OrchestratorMessageSchema,
  PostOwnerMessageSchema,
  DEFAULT_ORCHESTRATOR_CONFIG,
} from '../../src/shared/orchestrator';

describe('orchestrator schemas', () => {
  it('provides defaults via DEFAULT_ORCHESTRATOR_CONFIG', () => {
    const parsed = OrchestratorConfigSchema.parse(DEFAULT_ORCHESTRATOR_CONFIG);
    expect(parsed.persona_name).toBe('Hawat');
    expect(parsed.model).toBe('haiku');
    expect(parsed.idle_timeout_ms).toBe(600000);
  });

  it('rejects an invalid role on a message', () => {
    expect(() =>
      OrchestratorMessageSchema.parse({
        id: 'x',
        role: 'robot',
        channel: 'app',
        content: 'hi',
        tool_calls_json: null,
        trigger_kind: null,
        created_at: 1,
      }),
    ).toThrow();
  });

  it('requires non-empty text on a posted owner message', () => {
    expect(() => PostOwnerMessageSchema.parse({ text: '' })).toThrow();
    expect(PostOwnerMessageSchema.parse({ text: 'do the thing' }).text).toBe('do the thing');
  });
});
