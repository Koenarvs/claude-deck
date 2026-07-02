import { z } from 'zod';

// ── Enums ─────────────────────────────────────────────────────────────────────

export const GoalStatusSchema = z.enum([
  'planning',
  'active',
  'waiting',
  'complete',
  'archived',
]);

export const GoalModelSchema = z.string();

export const PermissionModeSchema = z.enum(['autonomous', 'supervised']);

export const SessionOriginSchema = z.enum(['dashboard', 'external']);

export const MessageRoleSchema = z.enum([
  'user',
  'assistant',
  'system',
  'tool_use',
  'tool_result',
]);

export const HookEventTypeSchema = z.enum([
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'SubagentStart',
  'SubagentStop',
  'UserPromptSubmit',
  'Stop',
]);

export const ApprovalStatusSchema = z.enum(['pending', 'approved', 'denied', 'timeout']);

export const ApprovalDecisionSchema = z.enum(['approved', 'denied', 'timeout']);

export const PlanTodoStatusSchema = z.enum(['pending', 'in_progress', 'completed']);

// ── Plan ──────────────────────────────────────────────────────────────────────

export const PlanTodoSchema: z.ZodType<{
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority: number;
  children: Array<{
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
    priority: number;
    children: Array<unknown>;
  }>;
}> = z.lazy(() =>
  z.object({
    content: z.string(),
    status: PlanTodoStatusSchema,
    priority: z.number(),
    children: z.array(PlanTodoSchema),
  }),
);

export const PlanJsonSchema = z.object({
  todos: z.array(PlanTodoSchema),
  raw_content: z.string(),
});

// ── Goal ──────────────────────────────────────────────────────────────────────

export const GoalSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  description: z.string().nullable(),
  cwd: z.string().min(1),
  status: GoalStatusSchema,
  priority: z.number().int(),
  tags: z.array(z.string()),
  current_session_id: z.string().nullable(),
  model: GoalModelSchema.nullable(),
  permission_mode: PermissionModeSchema,
  plan_json: PlanJsonSchema.nullable(),
  kanban_order: z.number(),
  created_at: z.number(),
  updated_at: z.number(),
  completed_at: z.number().nullable(),
  agent_type: z.string().nullable().optional(),
});

export const CreateGoalInputSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  cwd: z.string().min(1),
  model: GoalModelSchema.optional(),
  permission_mode: PermissionModeSchema.optional(),
  tags: z.array(z.string()).optional(),
  initialPrompt: z.string().optional(),
  projectId: z.string().optional(),
  agent_type: z.string().optional(),
});

// ── Project Registry (5A) ─────────────────────────────────────────────────────

export const CreateProjectInputSchema = z.object({
  name: z.string().min(1),
  root_path: z.string().min(1),
  allowed_models: z.array(z.string()).optional(),
  default_permission_mode: PermissionModeSchema.optional(),
  done_command: z.string().nullable().optional(),
  worktree_root: z.string().nullable().optional(),
});

export const UpdateProjectInputSchema = z.object({
  name: z.string().min(1).optional(),
  allowed_models: z.array(z.string()).optional(),
  default_permission_mode: PermissionModeSchema.optional(),
  done_command: z.string().nullable().optional(),
  worktree_root: z.string().nullable().optional(),
});

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  root_path: z.string(),
  allowed_models: z.array(z.string()),
  default_permission_mode: PermissionModeSchema,
  done_command: z.string().nullable(),
  worktree_root: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});

// ── 5C Verification gate ─────────────────────────────────────────────────────

export const VerificationStatusSchema = z.enum(['pass', 'fail', 'error', 'skipped', 'running']);

export const VerificationResultSchema = z.object({
  id: z.string(),
  goal_id: z.string(),
  session_id: z.string().nullable(),
  status: VerificationStatusSchema,
  command: z.string().nullable(),
  workspace: z.string().nullable(),
  exit_code: z.number().nullable(),
  output: z.string().nullable(),
  duration_ms: z.number().nullable(),
  model: z.string().nullable(),
  created_at: z.number(),
});

export const UpdateGoalInputSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  status: GoalStatusSchema.optional(),
  priority: z.number().int().optional(),
  tags: z.array(z.string()).optional(),
  model: GoalModelSchema.nullable().optional(),
  permission_mode: PermissionModeSchema.optional(),
  kanban_order: z.number().optional(),
  agent_type: z.string().nullable().optional(),
});

// ── Session ───────────────────────────────────────────────────────────────────

export const SessionSchema = z.object({
  id: z.string(),
  goal_id: z.string().nullable(),
  origin: SessionOriginSchema,
  cwd: z.string().nullable(),
  model: z.string().nullable(),
  trace_dir: z.string().nullable(),
  stream_event_count: z.number().int(),
  hook_event_count: z.number().int(),
  stderr_bytes: z.number().int(),
  started_at: z.number().nullable(),
  ended_at: z.number().nullable(),
});

// ── Message ───────────────────────────────────────────────────────────────────

export const MessageSchema = z.object({
  id: z.string().uuid(),
  session_id: z.string(),
  role: MessageRoleSchema,
  content: z.string().nullable(),
  tool_name: z.string().nullable(),
  tool_args: z.string().nullable(),
  tool_result: z.string().nullable(),
  tool_use_id: z.string().nullable(),
  created_at: z.number(),
});

// ── Hook Event ────────────────────────────────────────────────────────────────

export const HookEventSchema = z.object({
  id: z.string(),
  session_id: z.string().nullable(),
  event_type: HookEventTypeSchema,
  tool_name: z.string().nullable(),
  payload_json: z.string(),
  created_at: z.number(),
});

// ── Approval ──────────────────────────────────────────────────────────────────

export const ApprovalSchema = z.object({
  id: z.string(),
  session_id: z.string().nullable(),
  goal_id: z.string().nullable(),
  tool_name: z.string(),
  tool_args: z.string(),
  status: ApprovalStatusSchema,
  decided_reason: z.string().nullable(),
  requested_at: z.number(),
  resolved_at: z.number().nullable(),
});

// ── Scheduled Task ────────────────────────────────────────────────────────────

export const GoalTemplateSchema = z.object({
  title: z.string().min(1),
  cwd: z.string().min(1),
  model: GoalModelSchema.optional(),
  initialPrompt: z.string().optional(),
  tags: z.array(z.string()).optional(),
  agent_type: z.string().optional(),
});

export const ScheduledTaskSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  cron_expr: z.string().min(1),
  goal_template_json: z.string(),
  enabled: z.boolean(),
  last_run_at: z.number().nullable(),
  next_run_at: z.number().nullable(),
  created_at: z.number(),
});

export const CreateScheduledTaskInputSchema = z.object({
  name: z.string().min(1),
  cron_expr: z.string().min(1),
  goal_template_json: GoalTemplateSchema,
  enabled: z.boolean().optional(),
});

export const UpdateScheduledTaskInputSchema = z.object({
  name: z.string().min(1).optional(),
  cron_expr: z.string().min(1).optional(),
  goal_template_json: GoalTemplateSchema.optional(),
  enabled: z.boolean().optional(),
});

// ── Inter-Goal Message ───────────────────────────────────────────────────────

export const InterGoalMessageTypeSchema = z.enum([
  'instruction',
  'result',
  'status_update',
  'context',
]);

export const InterGoalMessageStatusSchema = z.enum([
  'pending',
  'delivered',
  'acknowledged',
]);

export const InterGoalMessageSchema = z.object({
  id: z.string().uuid(),
  from_goal_id: z.string().uuid(),
  to_goal_id: z.string().uuid(),
  content: z.string().min(1),
  message_type: InterGoalMessageTypeSchema,
  status: InterGoalMessageStatusSchema,
  created_at: z.number(),
  delivered_at: z.number().nullable(),
  acknowledged_at: z.number().nullable(),
});

export const SendGoalInstructionSchema = z.object({
  content: z.string().min(1),
  message_type: InterGoalMessageTypeSchema.default('instruction'),
});

export const CreateGoalAndInstructSchema = z.object({
  title: z.string().min(1),
  cwd: z.string().min(1),
  description: z.string().optional(),
  model: GoalModelSchema.optional(),
  permission_mode: PermissionModeSchema.optional(),
  tags: z.array(z.string()).optional(),
  instruction: z.string().min(1),
  source_goal_id: z.string().min(1),
  spawn_session: z.boolean().optional().default(true),
  agent_type: z.string().optional(),
});

// ── Goal Detail ───────────────────────────────────────────────────────────────

export const GoalDetailSchema = z.object({
  goal: GoalSchema,
  messages: z.array(MessageSchema),
  plan: PlanJsonSchema.nullable(),
});

// ── App Config ────────────────────────────────────────────────────────────────

/** Per-provider configuration. Billing mode is install config, not adapter. */
export const ProviderConfigSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
  billingMode: z.enum(['metered', 'seat']).default('seat'),
  seatPriceUsdMonthly: z.number().nonnegative().optional(), // seat mode → value multiplier
  budget: z
    .object({ dailyUsd: z.number(), monthlyUsd: z.number(), perGoalUsd: z.number() })
    .partial()
    .optional(), // metered mode → caps/alerts
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

/**
 * Headroom context-compression proxy. When enabled, spawned sessions (and the
 * orchestrator brain) get ANTHROPIC_BASE_URL pointed at a running `headroom
 * proxy`, which compresses request bodies before forwarding to Anthropic with
 * the client's existing (subscription) auth untouched. Off by default.
 */
export const CompressionDegreeSchema = z.enum(['off', 'light', 'balanced', 'aggressive']);
export type CompressionDegree = z.infer<typeof CompressionDegreeSchema>;

export const HeadroomConfigSchema = z.object({
  enabled: z.boolean().default(true),
  baseUrl: z.string().url().default('http://localhost:8787'),
  launchOnStartup: z.boolean().default(true),
  compressionDegree: CompressionDegreeSchema.default('balanced'),
  interceptToolResults: z.boolean().default(true),
  memory: z.boolean().default(true),
  // Optional override for the Vertex upstream host. Blank/undefined => the
  // proxy auto-derives it from CLOUD_ML_REGION (self-correcting on region change).
  vertexApiUrl: z.string().url().optional(),
  command: z.string().optional(), // advanced override; undefined => auto-build
});
export type HeadroomConfig = z.infer<typeof HeadroomConfigSchema>;

export const AppConfigSchema = z.object({
  homeRoute: z.string(),
  dataDir: z.string(),
  hooksInstalled: z.boolean(),
  tracePruneDays: z.number().int().min(1),
  defaultModel: GoalModelSchema,
  defaultPermissionMode: PermissionModeSchema,
  providers: z.array(ProviderConfigSchema).default([{ id: 'claude', enabled: true, billingMode: 'seat' }]),
  headroom: HeadroomConfigSchema.default({ enabled: true, baseUrl: 'http://localhost:8787', interceptToolResults: true, memory: true }),
});

/** The subset of AppConfig that is persisted (dataDir/hooksInstalled are computed at runtime). */
export const PersistedConfigSchema = AppConfigSchema.pick({
  homeRoute: true,
  tracePruneDays: true,
  defaultModel: true,
  defaultPermissionMode: true,
  providers: true,
  headroom: true,
});
export type PersistedConfig = z.infer<typeof PersistedConfigSchema>;

// ── Stream JSON Events ────────────────────────────────────────────────────────

export const AssistantTextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

export const AssistantToolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.unknown()),
});

export const AssistantThinkingBlockSchema = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
});

export const AssistantContentBlockSchema = z.discriminatedUnion('type', [
  AssistantTextBlockSchema,
  AssistantToolUseBlockSchema,
  AssistantThinkingBlockSchema,
]);

export const StreamJsonInitEventSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('init'),
  session_id: z.string(),
  tools: z.array(z.string()),
  model: z.string(),
});

export const StreamJsonAssistantEventSchema = z.object({
  type: z.literal('assistant'),
  message: z.object({
    content: z.array(AssistantContentBlockSchema),
  }),
});

export const StreamJsonToolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.string(),
});

export const StreamJsonUserEventSchema = z.object({
  type: z.literal('user'),
  message: z.object({
    content: z.array(StreamJsonToolResultBlockSchema),
  }),
});

export const StreamJsonCompactEventSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('compact_boundary'),
  compact_metadata: z.record(z.unknown()),
});

export const StreamJsonResultEventSchema = z.object({
  type: z.literal('result'),
  subtype: z.string(),
  total_cost_usd: z.number(),
  num_turns: z.number().int(),
  session_id: z.string(),
  total_input_tokens: z.number().optional(),
  total_output_tokens: z.number().optional(),
  total_cache_read_tokens: z.number().optional(),
  total_cache_creation_tokens: z.number().optional(),
});

// StreamJsonEvent: cannot use z.discriminatedUnion because 'system' has two subtypes.
// Use z.union with refinement instead.
export const StreamJsonEventSchema = z.union([
  StreamJsonInitEventSchema,
  StreamJsonAssistantEventSchema,
  StreamJsonUserEventSchema,
  StreamJsonCompactEventSchema,
  StreamJsonResultEventSchema,
]);
