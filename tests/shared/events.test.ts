import { describe, it, expect } from 'vitest';
import { ServerEventSchema, ClientMessageSchema } from '../../src/shared/events';

describe('ServerEventSchema', () => {
  it('parses goal:created with a valid Goal', () => {
    const result = ServerEventSchema.safeParse({
      type: 'goal:created',
      goal: {
        id: '550e8400-e29b-41d4-a716-446655440000',
        title: 'Test',
        description: null,
        cwd: '/tmp',
        status: 'planning',
        priority: 0,
        tags: [],
        current_session_id: null,
        model: null,
        permission_mode: 'supervised',
        plan_json: null,
        kanban_order: 1.0,
        created_at: 1700000000000,
        updated_at: 1700000000000,
        completed_at: null,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('goal:created');
    }
  });

  it('parses goal:status event', () => {
    const result = ServerEventSchema.safeParse({
      type: 'goal:status',
      id: 'goal-1',
      status: 'active',
      current_session_id: 'sess-1',
    });
    expect(result.success).toBe(true);
  });

  it('parses message:added event', () => {
    const result = ServerEventSchema.safeParse({
      type: 'message:added',
      goal_id: 'goal-1',
      session_id: 'sess-1',
      message: {
        id: '550e8400-e29b-41d4-a716-446655440001',
        session_id: 'sess-1',
        role: 'assistant',
        content: 'Hello',
        tool_name: null,
        tool_args: null,
        tool_result: null,
        tool_use_id: null,
        token_in: 10,
        token_out: 5,
        created_at: 1700000000000,
      },
    });
    expect(result.success).toBe(true);
  });

  it('parses approval:pending event', () => {
    const result = ServerEventSchema.safeParse({
      type: 'approval:pending',
      approval: {
        id: 'ap-1',
        session_id: 'sess-1',
        goal_id: 'goal-1',
        tool_name: 'Bash',
        tool_args: '{"command":"ls"}',
        status: 'pending',
        decided_reason: null,
        requested_at: 1700000000000,
        resolved_at: null,
      },
      goal_id: 'goal-1',
    });
    expect(result.success).toBe(true);
  });

  it('parses approval:resolved event', () => {
    const result = ServerEventSchema.safeParse({
      type: 'approval:resolved',
      id: 'ap-1',
      decision: 'approved',
    });
    expect(result.success).toBe(true);
  });

  it('parses session:observed event', () => {
    const result = ServerEventSchema.safeParse({
      type: 'session:observed',
      session: {
        id: 'sess-ext-1',
        goal_id: null,
        origin: 'external',
        cwd: '/home/user',
        model: 'sonnet',
        trace_dir: null,
        stream_event_count: 0,
        hook_event_count: 1,
        stderr_bytes: 0,
        total_cost_usd: null,
        total_tokens_in: null,
        total_tokens_out: null,
        started_at: 1700000000000,
        ended_at: null,
      },
    });
    expect(result.success).toBe(true);
  });

  it('parses hook:event event', () => {
    const result = ServerEventSchema.safeParse({
      type: 'hook:event',
      event: {
        id: 'he-1',
        session_id: 'sess-1',
        event_type: 'PreToolUse',
        tool_name: 'Bash',
        payload_json: '{}',
        created_at: 1700000000000,
      },
    });
    expect(result.success).toBe(true);
  });

  it('parses ping event', () => {
    const result = ServerEventSchema.safeParse({ type: 'ping' });
    expect(result.success).toBe(true);
  });

  it('parses session:ended event', () => {
    const result = ServerEventSchema.safeParse({
      type: 'session:ended',
      id: 'sess-1',
    });
    expect(result.success).toBe(true);
  });

  it('parses subprocess:error event', () => {
    const result = ServerEventSchema.safeParse({
      type: 'subprocess:error',
      goal_id: 'goal-1',
      error: 'Process exited with code 1',
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown event type', () => {
    const result = ServerEventSchema.safeParse({
      type: 'goal:deleted',
      id: 'goal-1',
    });
    expect(result.success).toBe(false);
  });

  it('rejects malformed goal in goal:created', () => {
    const result = ServerEventSchema.safeParse({
      type: 'goal:created',
      goal: { id: 'bad' },
    });
    expect(result.success).toBe(false);
  });
});

describe('ClientMessageSchema', () => {
  it('accepts subscribe with array of goal IDs', () => {
    const result = ClientMessageSchema.safeParse({
      type: 'subscribe',
      goals: ['goal-1', 'goal-2'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts subscribe with "all" literal', () => {
    const result = ClientMessageSchema.safeParse({
      type: 'subscribe',
      goals: 'all',
    });
    expect(result.success).toBe(true);
  });

  it('accepts unsubscribe', () => {
    const result = ClientMessageSchema.safeParse({
      type: 'unsubscribe',
    });
    expect(result.success).toBe(true);
  });

  it('accepts ping', () => {
    const result = ClientMessageSchema.safeParse({
      type: 'ping',
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown message type', () => {
    const result = ClientMessageSchema.safeParse({
      type: 'broadcast',
      data: 'hello',
    });
    expect(result.success).toBe(false);
  });

  it('rejects subscribe with invalid goals value', () => {
    const result = ClientMessageSchema.safeParse({
      type: 'subscribe',
      goals: 123,
    });
    expect(result.success).toBe(false);
  });
});
