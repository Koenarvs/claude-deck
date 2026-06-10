import { describe, it, expect } from 'vitest';
import {
  GoalSchema,
  MessageSchema,
  GoalStatusSchema,
  CreateGoalInputSchema,
  AssistantContentBlockSchema,
  StreamJsonEventSchema,
  PlanJsonSchema,
  SessionSchema,
  HookEventSchema,
  ApprovalSchema,
  ScheduledTaskSchema,
  AppConfigSchema,
} from '../../src/shared/schemas';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const validGoal = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  title: 'Test Goal',
  description: null,
  cwd: '/home/user/project',
  status: 'active',
  priority: 0,
  tags: ['test'],
  current_session_id: null,
  model: 'sonnet',
  permission_mode: 'supervised',
  plan_json: null,
  kanban_order: 1.0,
  created_at: 1700000000000,
  updated_at: 1700000000000,
  completed_at: null,
};

const validMessage = {
  id: '550e8400-e29b-41d4-a716-446655440001',
  session_id: 'sess-123',
  role: 'assistant',
  content: 'Hello world',
  tool_name: null,
  tool_args: null,
  tool_result: null,
  tool_use_id: null,
  created_at: 1700000000000,
};

// ── Goal Schema ───────────────────────────────────────────────────────────────

describe('GoalSchema', () => {
  it('accepts a valid goal', () => {
    const result = GoalSchema.safeParse(validGoal);
    expect(result.success).toBe(true);
  });

  it('rejects invalid status', () => {
    const result = GoalSchema.safeParse({ ...validGoal, status: 'running' });
    expect(result.success).toBe(false);
  });

  it('rejects missing required fields', () => {
    const { title: _, ...noTitle } = validGoal;
    const result = GoalSchema.safeParse(noTitle);
    expect(result.success).toBe(false);
  });

  it('rejects empty title', () => {
    const result = GoalSchema.safeParse({ ...validGoal, title: '' });
    expect(result.success).toBe(false);
  });

  it('accepts all valid statuses', () => {
    for (const status of ['planning', 'active', 'waiting', 'complete', 'archived']) {
      const result = GoalStatusSchema.safeParse(status);
      expect(result.success).toBe(true);
    }
  });
});

// ── Message Schema ────────────────────────────────────────────────────────────

describe('MessageSchema', () => {
  it('accepts a valid message', () => {
    const result = MessageSchema.safeParse(validMessage);
    expect(result.success).toBe(true);
  });

  it('rejects invalid role', () => {
    const result = MessageSchema.safeParse({ ...validMessage, role: 'admin' });
    expect(result.success).toBe(false);
  });

  it('roundtrips through parse', () => {
    const parsed = MessageSchema.parse(validMessage);
    expect(parsed.id).toBe(validMessage.id);
    expect(parsed.role).toBe('assistant');
    expect(parsed.content).toBe('Hello world');
    expect(parsed.created_at).toBe(1700000000000);
  });
});

// ── CreateGoalInput Schema ────────────────────────────────────────────────────

describe('CreateGoalInputSchema', () => {
  it('accepts valid input with required fields only', () => {
    const result = CreateGoalInputSchema.safeParse({
      title: 'New Goal',
      cwd: '/home/user',
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid input with all fields', () => {
    const result = CreateGoalInputSchema.safeParse({
      title: 'New Goal',
      cwd: '/home/user',
      description: 'A test goal',
      model: 'opus',
      permission_mode: 'autonomous',
      tags: ['test', 'demo'],
      initialPrompt: 'Hello Claude',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing title', () => {
    const result = CreateGoalInputSchema.safeParse({ cwd: '/home' });
    expect(result.success).toBe(false);
  });

  it('rejects missing cwd', () => {
    const result = CreateGoalInputSchema.safeParse({ title: 'Goal' });
    expect(result.success).toBe(false);
  });
});

// ── AssistantContentBlock ─────────────────────────────────────────────────────

describe('AssistantContentBlockSchema', () => {
  it('narrows text block', () => {
    const result = AssistantContentBlockSchema.safeParse({
      type: 'text',
      text: 'hello',
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'text') {
      expect(result.data.text).toBe('hello');
    }
  });

  it('narrows tool_use block', () => {
    const result = AssistantContentBlockSchema.safeParse({
      type: 'tool_use',
      id: 'tu-1',
      name: 'Bash',
      input: { command: 'ls' },
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'tool_use') {
      expect(result.data.name).toBe('Bash');
    }
  });

  it('narrows thinking block', () => {
    const result = AssistantContentBlockSchema.safeParse({
      type: 'thinking',
      thinking: 'Let me consider...',
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'thinking') {
      expect(result.data.thinking).toBe('Let me consider...');
    }
  });

  it('rejects unknown type', () => {
    const result = AssistantContentBlockSchema.safeParse({
      type: 'image',
      url: 'https://example.com/img.png',
    });
    expect(result.success).toBe(false);
  });
});

// ── StreamJsonEvent ───────────────────────────────────────────────────────────

describe('StreamJsonEventSchema', () => {
  it('parses init event', () => {
    const result = StreamJsonEventSchema.safeParse({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-1',
      tools: ['Bash', 'Read'],
      model: 'sonnet',
    });
    expect(result.success).toBe(true);
  });

  it('parses assistant event', () => {
    const result = StreamJsonEventSchema.safeParse({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Hello' }],
      },
    });
    expect(result.success).toBe(true);
  });

  it('parses result event', () => {
    const result = StreamJsonEventSchema.safeParse({
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.05,
      num_turns: 3,
      session_id: 'sess-1',
    });
    expect(result.success).toBe(true);
  });

  it('parses user event with tool results', () => {
    const result = StreamJsonEventSchema.safeParse({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tu-1', content: 'output text' },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  it('parses compact_boundary event', () => {
    const result = StreamJsonEventSchema.safeParse({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { reason: 'token_limit' },
    });
    expect(result.success).toBe(true);
  });
});

// ── PlanJson ──────────────────────────────────────────────────────────────────

describe('PlanJsonSchema', () => {
  it('accepts valid plan with nested todos', () => {
    const result = PlanJsonSchema.safeParse({
      todos: [
        {
          content: 'Step 1',
          status: 'completed',
          priority: 1,
          children: [
            {
              content: 'Sub-step 1a',
              status: 'pending',
              priority: 0,
              children: [],
            },
          ],
        },
      ],
      raw_content: '- [x] Step 1\n  - [ ] Sub-step 1a',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid todo status', () => {
    const result = PlanJsonSchema.safeParse({
      todos: [
        { content: 'Bad', status: 'done', priority: 0, children: [] },
      ],
      raw_content: '',
    });
    expect(result.success).toBe(false);
  });
});

// ── Session Schema ────────────────────────────────────────────────────────────

describe('SessionSchema', () => {
  it('accepts a valid session', () => {
    const result = SessionSchema.safeParse({
      id: 'sess-1',
      goal_id: null,
      origin: 'external',
      cwd: '/tmp',
      model: 'sonnet',
      trace_dir: null,
      stream_event_count: 0,
      hook_event_count: 0,
      stderr_bytes: 0,
      started_at: 1700000000000,
      ended_at: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid origin', () => {
    const result = SessionSchema.safeParse({
      id: 'sess-1',
      goal_id: null,
      origin: 'manual',
      cwd: '/tmp',
      model: null,
      trace_dir: null,
      stream_event_count: 0,
      hook_event_count: 0,
      stderr_bytes: 0,
      started_at: null,
      ended_at: null,
    });
    expect(result.success).toBe(false);
  });
});

// ── Other Schemas ─────────────────────────────────────────────────────────────

describe('HookEventSchema', () => {
  it('accepts valid hook event', () => {
    const result = HookEventSchema.safeParse({
      id: 'he-1',
      session_id: 'sess-1',
      event_type: 'PreToolUse',
      tool_name: 'Bash',
      payload_json: '{}',
      created_at: 1700000000000,
    });
    expect(result.success).toBe(true);
  });
});

describe('ApprovalSchema', () => {
  it('accepts valid approval', () => {
    const result = ApprovalSchema.safeParse({
      id: 'ap-1',
      session_id: 'sess-1',
      goal_id: null,
      tool_name: 'Bash',
      tool_args: '{"command":"rm -rf"}',
      status: 'pending',
      decided_reason: null,
      requested_at: 1700000000000,
      resolved_at: null,
    });
    expect(result.success).toBe(true);
  });
});

describe('ScheduledTaskSchema', () => {
  it('accepts valid scheduled task', () => {
    const result = ScheduledTaskSchema.safeParse({
      id: 'st-1',
      name: 'Daily cleanup',
      cron_expr: '0 0 * * *',
      goal_template_json: '{"title":"Cleanup","cwd":"/tmp"}',
      enabled: true,
      last_run_at: null,
      next_run_at: 1700086400000,
      created_at: 1700000000000,
    });
    expect(result.success).toBe(true);
  });
});

describe('AppConfigSchema', () => {
  it('accepts valid config', () => {
    const result = AppConfigSchema.safeParse({
      homeRoute: '/board',
      dataDir: './data',
      hooksInstalled: false,
      tracePruneDays: 90,
      defaultModel: 'sonnet',
      defaultPermissionMode: 'supervised',
    });
    expect(result.success).toBe(true);
  });

  it('rejects tracePruneDays less than 1', () => {
    const result = AppConfigSchema.safeParse({
      homeRoute: '/board',
      dataDir: './data',
      hooksInstalled: false,
      tracePruneDays: 0,
      defaultModel: 'sonnet',
      defaultPermissionMode: 'supervised',
    });
    expect(result.success).toBe(false);
  });
});

describe('AppConfigSchema providers (Delta B)', () => {
  it('defaults providers to a single enabled claude seat record', async () => {
    const { AppConfigSchema } = await import('../../src/shared/schemas');
    const parsed = AppConfigSchema.parse({
      homeRoute: '/board',
      dataDir: '',
      hooksInstalled: false,
      tracePruneDays: 90,
      defaultModel: 'default',
      defaultPermissionMode: 'supervised',
    });
    expect(parsed.providers).toEqual([{ id: 'claude', enabled: true, billingMode: 'seat' }]);
  });

  it('ProviderConfigSchema defaults billingMode to seat', async () => {
    const { ProviderConfigSchema } = await import('../../src/shared/schemas');
    const p = ProviderConfigSchema.parse({ id: 'antigravity', enabled: false });
    expect(p.billingMode).toBe('seat');
  });

  it('PersistedConfigSchema picks only the settable fields (incl. providers)', async () => {
    const { PersistedConfigSchema } = await import('../../src/shared/schemas');
    const p = PersistedConfigSchema.parse({
      homeRoute: '/board',
      tracePruneDays: 90,
      defaultModel: 'opus',
      defaultPermissionMode: 'autonomous',
      providers: [{ id: 'claude', enabled: true, billingMode: 'seat' }],
    });
    expect(Object.keys(p).sort()).toEqual(
      ['defaultModel', 'defaultPermissionMode', 'homeRoute', 'providers', 'tracePruneDays'],
    );
  });
});
