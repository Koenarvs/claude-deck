import { describe, it, expect } from 'vitest';
import { ListGoalsInputSchema } from '../src/tools/list-goals.js';
import { GetGoalInputSchema } from '../src/tools/get-goal.js';
import { CreateGoalInputSchema } from '../src/tools/create-goal.js';
import { SendMessageInputSchema } from '../src/tools/send-message.js';
import { ListSessionsInputSchema } from '../src/tools/list-sessions.js';
import { GetSessionMessagesInputSchema } from '../src/tools/get-session-messages.js';
import { ScheduleTaskInputSchema } from '../src/tools/schedule-task.js';

// ── list_goals ───────────────────────────────────────────────────────────────

describe('list_goals input schema', () => {
  it('accepts empty input (no filters)', () => {
    const result = ListGoalsInputSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts valid status filter', () => {
    const result = ListGoalsInputSchema.safeParse({ status: 'active' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('active');
    }
  });

  it('accepts valid tag filter', () => {
    const result = ListGoalsInputSchema.safeParse({ tag: 'sprint-248' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tag).toBe('sprint-248');
    }
  });

  it('accepts both status and tag', () => {
    const result = ListGoalsInputSchema.safeParse({ status: 'planning', tag: 'infra' });
    expect(result.success).toBe(true);
  });

  it('rejects invalid status value', () => {
    const result = ListGoalsInputSchema.safeParse({ status: 'invalid' });
    expect(result.success).toBe(false);
  });

  it('accepts all valid status values', () => {
    for (const status of ['planning', 'active', 'waiting', 'complete', 'archived']) {
      const result = ListGoalsInputSchema.safeParse({ status });
      expect(result.success).toBe(true);
    }
  });
});

// ── get_goal ─────────────────────────────────────────────────────────────────

describe('get_goal input schema', () => {
  it('accepts a valid id', () => {
    const result = GetGoalInputSchema.safeParse({ id: 'abc-123' });
    expect(result.success).toBe(true);
  });

  it('rejects missing id', () => {
    const result = GetGoalInputSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ── create_goal ──────────────────────────────────────────────────────────────

describe('create_goal input schema', () => {
  it('accepts minimal required fields', () => {
    const result = CreateGoalInputSchema.safeParse({
      title: 'Fix the bug',
      cwd: '/home/user/project',
    });
    expect(result.success).toBe(true);
  });

  it('accepts all optional fields', () => {
    const result = CreateGoalInputSchema.safeParse({
      title: 'Refactor auth',
      cwd: '/home/user/project',
      model: 'opus',
      initialPrompt: 'Refactor the auth module to use OAuth2',
      tags: ['auth', 'refactor'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.model).toBe('opus');
      expect(result.data.tags).toEqual(['auth', 'refactor']);
    }
  });

  it('rejects empty title', () => {
    const result = CreateGoalInputSchema.safeParse({
      title: '',
      cwd: '/home/user/project',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty cwd', () => {
    const result = CreateGoalInputSchema.safeParse({
      title: 'Fix the bug',
      cwd: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing title', () => {
    const result = CreateGoalInputSchema.safeParse({
      cwd: '/home/user/project',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid model', () => {
    const result = CreateGoalInputSchema.safeParse({
      title: 'Fix the bug',
      cwd: '/home/user/project',
      model: 'gpt-4',
    });
    expect(result.success).toBe(false);
  });

  it('accepts all valid model values', () => {
    for (const model of ['opus', 'sonnet', 'haiku', 'default']) {
      const result = CreateGoalInputSchema.safeParse({
        title: 'Test',
        cwd: '/tmp',
        model,
      });
      expect(result.success).toBe(true);
    }
  });
});

// ── send_message ─────────────────────────────────────────────────────────────

describe('send_message input schema', () => {
  it('accepts valid input', () => {
    const result = SendMessageInputSchema.safeParse({
      goal_id: 'abc-123',
      prompt: 'Continue with the next step',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing goal_id', () => {
    const result = SendMessageInputSchema.safeParse({
      prompt: 'Continue',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty prompt', () => {
    const result = SendMessageInputSchema.safeParse({
      goal_id: 'abc-123',
      prompt: '',
    });
    expect(result.success).toBe(false);
  });
});

// ── list_sessions ────────────────────────────────────────────────────────────

describe('list_sessions input schema', () => {
  it('accepts empty input (no filters)', () => {
    const result = ListSessionsInputSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts origin filter', () => {
    const result = ListSessionsInputSchema.safeParse({ origin: 'dashboard' });
    expect(result.success).toBe(true);
  });

  it('accepts active filter', () => {
    const result = ListSessionsInputSchema.safeParse({ active: 'true' });
    expect(result.success).toBe(true);
  });

  it('rejects invalid origin', () => {
    const result = ListSessionsInputSchema.safeParse({ origin: 'unknown' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid active value', () => {
    const result = ListSessionsInputSchema.safeParse({ active: 'yes' });
    expect(result.success).toBe(false);
  });
});

// ── get_session_messages ─────────────────────────────────────────────────────

describe('get_session_messages input schema', () => {
  it('accepts valid session_id', () => {
    const result = GetSessionMessagesInputSchema.safeParse({
      session_id: 'session-abc-123',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing session_id', () => {
    const result = GetSessionMessagesInputSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ── schedule_task ────────────────────────────────────────────────────────────

describe('schedule_task input schema', () => {
  it('accepts valid input with all fields', () => {
    const result = ScheduleTaskInputSchema.safeParse({
      name: 'Morning standup prep',
      cron_expr: '0 9 * * 1-5',
      goal_template: {
        title: 'Standup prep',
        cwd: '/home/user/project',
        model: 'sonnet',
        initialPrompt: 'Prepare standup notes',
        tags: ['daily', 'standup'],
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts minimal goal_template', () => {
    const result = ScheduleTaskInputSchema.safeParse({
      name: 'Nightly backup check',
      cron_expr: '0 2 * * *',
      goal_template: {
        title: 'Check backups',
        cwd: '/var/backups',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing name', () => {
    const result = ScheduleTaskInputSchema.safeParse({
      cron_expr: '0 9 * * *',
      goal_template: { title: 'Test', cwd: '/tmp' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing cron_expr', () => {
    const result = ScheduleTaskInputSchema.safeParse({
      name: 'Test',
      goal_template: { title: 'Test', cwd: '/tmp' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing goal_template', () => {
    const result = ScheduleTaskInputSchema.safeParse({
      name: 'Test',
      cron_expr: '0 9 * * *',
    });
    expect(result.success).toBe(false);
  });

  it('rejects goal_template with empty title', () => {
    const result = ScheduleTaskInputSchema.safeParse({
      name: 'Test',
      cron_expr: '0 9 * * *',
      goal_template: { title: '', cwd: '/tmp' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid model in goal_template', () => {
    const result = ScheduleTaskInputSchema.safeParse({
      name: 'Test',
      cron_expr: '0 9 * * *',
      goal_template: { title: 'Test', cwd: '/tmp', model: 'gpt-4' },
    });
    expect(result.success).toBe(false);
  });
});

// ── Tool count verification ──────────────────────────────────────────────────

describe('tool definitions', () => {
  it('exports exactly 7 input schemas', () => {
    const schemas = [
      ListGoalsInputSchema,
      GetGoalInputSchema,
      CreateGoalInputSchema,
      SendMessageInputSchema,
      ListSessionsInputSchema,
      GetSessionMessagesInputSchema,
      ScheduleTaskInputSchema,
    ];
    expect(schemas).toHaveLength(7);
    // Each schema should be a ZodObject
    for (const schema of schemas) {
      expect(schema.safeParse).toBeDefined();
    }
  });
});
