import { describe, it, expect } from 'vitest';
import { ServerEventSchema } from '../../src/shared/events';

describe('orchestrator server events', () => {
  it('validates orchestrator:message', () => {
    const ev = {
      type: 'orchestrator:message',
      message: {
        id: 'm1',
        role: 'orchestrator',
        channel: 'app',
        content: 'hi',
        tool_calls_json: null,
        trigger_kind: null,
        created_at: 1,
      },
    };
    expect(ServerEventSchema.parse(ev).type).toBe('orchestrator:message');
  });
  it('validates orchestrator:status', () => {
    expect(ServerEventSchema.parse({ type: 'orchestrator:status', status: 'active' }).type).toBe(
      'orchestrator:status',
    );
  });
  it('validates orchestrator:tool', () => {
    expect(
      ServerEventSchema.parse({ type: 'orchestrator:tool', tool: 'create_goal', summary: '{}' }).type,
    ).toBe('orchestrator:tool');
  });
});
