import { describe, it, expectTypeOf } from 'vitest';
import type {
  Goal,
  GoalStatus,
  Session,
  Message,
  HookEvent,
  Approval,
  ScheduledTask,
  PlanJson,
  PlanTodo,
  AppConfig,
  StreamJsonEvent,
  AssistantContentBlock,
  CreateGoalInput,
  UpdateGoalInput,
  GoalDetail,
  CreateScheduledTaskInput,
  UpdateScheduledTaskInput,
  PermissionMode,
  GoalModel,
  SessionOrigin,
  MessageRole,
  HookEventType,
  ApprovalStatus,
} from '../../src/shared/types';

describe('GoalStatus union', () => {
  it('accepts all valid statuses', () => {
    expectTypeOf<'planning'>().toMatchTypeOf<GoalStatus>();
    expectTypeOf<'active'>().toMatchTypeOf<GoalStatus>();
    expectTypeOf<'waiting'>().toMatchTypeOf<GoalStatus>();
    expectTypeOf<'complete'>().toMatchTypeOf<GoalStatus>();
    expectTypeOf<'archived'>().toMatchTypeOf<GoalStatus>();
  });

  it('rejects invalid statuses', () => {
    expectTypeOf<'invalid'>().not.toMatchTypeOf<GoalStatus>();
    expectTypeOf<'running'>().not.toMatchTypeOf<GoalStatus>();
  });
});

describe('Goal shape', () => {
  it('has all required fields with correct types', () => {
    expectTypeOf<Goal>().toHaveProperty('id').toBeString();
    expectTypeOf<Goal>().toHaveProperty('title').toBeString();
    expectTypeOf<Goal>().toHaveProperty('cwd').toBeString();
    expectTypeOf<Goal>().toHaveProperty('status').toMatchTypeOf<GoalStatus>();
    expectTypeOf<Goal>().toHaveProperty('priority').toBeNumber();
    expectTypeOf<Goal>().toHaveProperty('tags').toMatchTypeOf<string[]>();
    expectTypeOf<Goal>().toHaveProperty('kanban_order').toBeNumber();
    expectTypeOf<Goal>().toHaveProperty('created_at').toBeNumber();
    expectTypeOf<Goal>().toHaveProperty('updated_at').toBeNumber();
  });

  it('has nullable fields', () => {
    expectTypeOf<Goal>().toHaveProperty('description').toMatchTypeOf<string | null>();
    expectTypeOf<Goal>().toHaveProperty('current_session_id').toMatchTypeOf<string | null>();
    expectTypeOf<Goal>().toHaveProperty('model').toMatchTypeOf<GoalModel | null>();
    expectTypeOf<Goal>().toHaveProperty('completed_at').toMatchTypeOf<number | null>();
    expectTypeOf<Goal>().toHaveProperty('plan_json').toMatchTypeOf<PlanJson | null>();
  });

  it('has permission_mode', () => {
    expectTypeOf<Goal>().toHaveProperty('permission_mode').toMatchTypeOf<PermissionMode>();
  });
});

describe('Session shape', () => {
  it('has origin field', () => {
    expectTypeOf<Session>().toHaveProperty('origin').toMatchTypeOf<SessionOrigin>();
  });

  it('has nullable goal_id', () => {
    expectTypeOf<Session>().toHaveProperty('goal_id').toMatchTypeOf<string | null>();
  });

  it('has numeric counters', () => {
    expectTypeOf<Session>().toHaveProperty('stream_event_count').toBeNumber();
    expectTypeOf<Session>().toHaveProperty('hook_event_count').toBeNumber();
    expectTypeOf<Session>().toHaveProperty('stderr_bytes').toBeNumber();
  });
});

describe('Message shape', () => {
  it('has role field', () => {
    expectTypeOf<Message>().toHaveProperty('role').toMatchTypeOf<MessageRole>();
  });

  it('has session_id', () => {
    expectTypeOf<Message>().toHaveProperty('session_id').toBeString();
  });
});

describe('HookEvent shape', () => {
  it('has event_type field', () => {
    expectTypeOf<HookEvent>().toHaveProperty('event_type').toMatchTypeOf<HookEventType>();
  });
});

describe('Approval shape', () => {
  it('has status field', () => {
    expectTypeOf<Approval>().toHaveProperty('status').toMatchTypeOf<ApprovalStatus>();
  });

  it('has nullable goal_id', () => {
    expectTypeOf<Approval>().toHaveProperty('goal_id').toMatchTypeOf<string | null>();
  });
});

describe('ScheduledTask shape', () => {
  it('has enabled as boolean', () => {
    expectTypeOf<ScheduledTask>().toHaveProperty('enabled').toBeBoolean();
  });

  it('has cron_expr', () => {
    expectTypeOf<ScheduledTask>().toHaveProperty('cron_expr').toBeString();
  });
});

describe('PlanJson and PlanTodo', () => {
  it('PlanJson contains todos array', () => {
    expectTypeOf<PlanJson>().toHaveProperty('todos').toMatchTypeOf<PlanTodo[]>();
  });

  it('PlanTodo has recursive children', () => {
    expectTypeOf<PlanTodo>().toHaveProperty('children').toMatchTypeOf<PlanTodo[]>();
  });

  it('PlanTodo has status union', () => {
    expectTypeOf<PlanTodo['status']>().toMatchTypeOf<'pending' | 'in_progress' | 'completed'>();
  });
});

describe('AppConfig shape', () => {
  it('has all config fields', () => {
    expectTypeOf<AppConfig>().toHaveProperty('homeRoute').toBeString();
    expectTypeOf<AppConfig>().toHaveProperty('dataDir').toBeString();
    expectTypeOf<AppConfig>().toHaveProperty('hooksInstalled').toBeBoolean();
    expectTypeOf<AppConfig>().toHaveProperty('tracePruneDays').toBeNumber();
    expectTypeOf<AppConfig>().toHaveProperty('defaultModel').toMatchTypeOf<GoalModel>();
    expectTypeOf<AppConfig>()
      .toHaveProperty('defaultPermissionMode')
      .toMatchTypeOf<PermissionMode>();
  });
});

describe('StreamJsonEvent discriminated union', () => {
  it('narrows on type field', () => {
    const narrowInit = (e: StreamJsonEvent) => {
      if (e.type === 'system' && 'subtype' in e && e.subtype === 'init') {
        expectTypeOf(e.session_id).toBeString();
      }
    };

    const narrowAssistant = (e: StreamJsonEvent) => {
      if (e.type === 'assistant') {
        expectTypeOf(e.message.content).toMatchTypeOf<AssistantContentBlock[]>();
      }
    };

    const narrowResult = (e: StreamJsonEvent) => {
      if (e.type === 'result') {
        expectTypeOf(e.total_cost_usd).toBeNumber();
        expectTypeOf(e.num_turns).toBeNumber();
        expectTypeOf(e.session_id).toBeString();
      }
    };

    // Prevent unused variable errors
    void narrowInit;
    void narrowAssistant;
    void narrowResult;
  });
});

describe('AssistantContentBlock discriminated union', () => {
  it('includes text variant', () => {
    const block: AssistantContentBlock = { type: 'text', text: 'hello' };
    if (block.type === 'text') {
      expectTypeOf(block.text).toBeString();
    }
  });

  it('includes tool_use variant', () => {
    const block: AssistantContentBlock = {
      type: 'tool_use',
      id: '1',
      name: 'Bash',
      input: {},
    };
    if (block.type === 'tool_use') {
      expectTypeOf(block.name).toBeString();
      expectTypeOf(block.input).toMatchTypeOf<Record<string, unknown>>();
    }
  });

  it('includes thinking variant', () => {
    const block: AssistantContentBlock = { type: 'thinking', thinking: 'hmm...' };
    if (block.type === 'thinking') {
      expectTypeOf(block.thinking).toBeString();
    }
  });
});

describe('Input types', () => {
  it('CreateGoalInput requires title and cwd', () => {
    expectTypeOf<CreateGoalInput>().toHaveProperty('title').toBeString();
    expectTypeOf<CreateGoalInput>().toHaveProperty('cwd').toBeString();
  });

  it('UpdateGoalInput has all optional fields', () => {
    expectTypeOf<Partial<UpdateGoalInput>>().toMatchTypeOf<UpdateGoalInput>();
  });

  it('GoalDetail is a composite type', () => {
    expectTypeOf<GoalDetail>().toHaveProperty('goal').toMatchTypeOf<Goal>();
    expectTypeOf<GoalDetail>().toHaveProperty('messages').toMatchTypeOf<Message[]>();
    expectTypeOf<GoalDetail>().toHaveProperty('plan').toMatchTypeOf<PlanJson | null>();
  });

  it('CreateScheduledTaskInput requires name and cron_expr', () => {
    expectTypeOf<CreateScheduledTaskInput>().toHaveProperty('name').toBeString();
    expectTypeOf<CreateScheduledTaskInput>().toHaveProperty('cron_expr').toBeString();
  });

  it('UpdateScheduledTaskInput has all optional fields', () => {
    expectTypeOf<Partial<UpdateScheduledTaskInput>>().toMatchTypeOf<UpdateScheduledTaskInput>();
  });
});
