// ── Goal ──────────────────────────────────────────────────────────────────────

export type GoalStatus = 'planning' | 'active' | 'waiting' | 'complete' | 'archived';

export type GoalModel = 'opus' | 'sonnet' | 'haiku' | 'default' | (string & {});

export type PermissionMode = 'autonomous' | 'supervised';

export interface Goal {
  id: string;
  title: string;
  description: string | null;
  cwd: string;
  status: GoalStatus;
  priority: number;
  tags: string[];
  current_session_id: string | null;
  model: GoalModel | null;
  permission_mode: PermissionMode;
  plan_json: PlanJson | null;
  initial_prompt?: string | null;
  kanban_order: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface CreateGoalInput {
  title: string;
  description?: string | undefined;
  cwd: string;
  model?: GoalModel | undefined;
  permission_mode?: PermissionMode | undefined;
  tags?: string[] | undefined;
  initialPrompt?: string | undefined;
}

export interface UpdateGoalInput {
  title?: string | undefined;
  description?: string | null | undefined;
  status?: GoalStatus | undefined;
  priority?: number | undefined;
  tags?: string[] | undefined;
  model?: GoalModel | null | undefined;
  permission_mode?: PermissionMode | undefined;
  kanban_order?: number | undefined;
}

// ── Session ───────────────────────────────────────────────────────────────────

export type SessionOrigin = 'dashboard' | 'external';

export interface Session {
  id: string;
  goal_id: string | null;
  origin: SessionOrigin;
  cwd: string | null;
  model: string | null;
  trace_dir: string | null;
  display_name: string | null;
  parent_session_id: string | null;
  stream_event_count: number;
  hook_event_count: number;
  stderr_bytes: number;
  started_at: number | null;
  ended_at: number | null;
}

// ── Message ───────────────────────────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result';

export interface Message {
  id: string;
  session_id: string;
  role: MessageRole;
  content: string | null;
  tool_name: string | null;
  tool_args: string | null;
  tool_result: string | null;
  tool_use_id: string | null;
  created_at: number;
}

// ── Hook Events ───────────────────────────────────────────────────────────────

export type HookEventType =
  | 'SessionStart'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PermissionRequest'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'UserPromptSubmit'
  | 'Stop';

export interface HookEvent {
  id: string;
  session_id: string | null;
  event_type: HookEventType;
  tool_name: string | null;
  payload_json: string;
  created_at: number;
}

// ── Approval ──────────────────────────────────────────────────────────────────

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'timeout';

export type ApprovalDecision = 'approved' | 'denied' | 'timeout';

export interface Approval {
  id: string;
  session_id: string | null;
  goal_id: string | null;
  tool_name: string;
  tool_args: string;
  status: ApprovalStatus;
  decided_reason: string | null;
  requested_at: number;
  resolved_at: number | null;
}

// ── Scheduled Tasks ───────────────────────────────────────────────────────────

export interface ScheduledTask {
  id: string;
  name: string;
  cron_expr: string;
  goal_template_json: string;
  enabled: boolean;
  last_run_at: number | null;
  next_run_at: number | null;
  created_at: number;
}

export interface CreateScheduledTaskInput {
  name: string;
  cron_expr: string;
  goal_template_json: GoalTemplate;
  enabled?: boolean | undefined;
}

export interface UpdateScheduledTaskInput {
  name?: string | undefined;
  cron_expr?: string | undefined;
  goal_template_json?: GoalTemplate | undefined;
  enabled?: boolean | undefined;
}

export interface GoalTemplate {
  title: string;
  cwd: string;
  model?: GoalModel | undefined;
  initialPrompt?: string | undefined;
  tags?: string[] | undefined;
}

// ── Plan ──────────────────────────────────────────────────────────────────────

export interface PlanTodo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority: number;
  children: PlanTodo[];
}

export interface PlanJson {
  todos: PlanTodo[];
  raw_content: string;
}

// ── Inter-Goal Message ───────────────────────────────────────────────────────

export type InterGoalMessageType = 'instruction' | 'result' | 'status_update' | 'context';

export type InterGoalMessageStatus = 'pending' | 'delivered' | 'acknowledged';

export interface InterGoalMessage {
  id: string;
  from_goal_id: string;
  to_goal_id: string;
  content: string;
  message_type: InterGoalMessageType;
  status: InterGoalMessageStatus;
  created_at: number;
  delivered_at: number | null;
  acknowledged_at: number | null;
}

// ── Goal Detail (composite) ───────────────────────────────────────────────────

export interface GoalDetail {
  goal: Goal;
  messages: Message[];
  interGoalMessages: InterGoalMessage[];
  plan: PlanJson | null;
}

// ── Analytics API Responses ──────────────────────────────────────────────────

export interface TokenDataPoint {
  timestamp: number;
  model: string;
  tokens_in: number;
  tokens_out: number;
}

export interface TokenSeries {
  data: TokenDataPoint[];
  from: number;
  to: number;
}

export interface ToolFrequencyEntry {
  tool_name: string;
  count: number;
}

export interface ToolFrequency {
  data: ToolFrequencyEntry[];
  from: number;
  to: number;
}

export interface HeatmapDay {
  date: string;
  count: number;
}

export interface HeatmapData {
  data: HeatmapDay[];
  from: number;
  to: number;
}

export interface CostDataPoint {
  timestamp: number;
  model: string;
  cost_usd: number;
}

export interface CostSeries {
  data: CostDataPoint[];
  from: number;
  to: number;
  total_usd: number;
}

// ── App Config ────────────────────────────────────────────────────────────────

export interface ProviderConfig {
  id: string;
  enabled: boolean;
  billingMode: 'metered' | 'seat';
  seatPriceUsdMonthly?: number;
  budget?: { dailyUsd?: number; monthlyUsd?: number; perGoalUsd?: number };
}

export interface AppConfig {
  homeRoute: string;
  dataDir: string;
  hooksInstalled: boolean;
  tracePruneDays: number;
  defaultModel: GoalModel;
  defaultPermissionMode: PermissionMode;
  providers: ProviderConfig[];
}

// ── Stream JSON Events (CLI → server) ─────────────────────────────────────────

export interface AssistantTextBlock {
  type: 'text';
  text: string;
}

export interface AssistantToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AssistantThinkingBlock {
  type: 'thinking';
  thinking: string;
}

export type AssistantContentBlock =
  | AssistantTextBlock
  | AssistantToolUseBlock
  | AssistantThinkingBlock;

export interface StreamJsonInitEvent {
  type: 'system';
  subtype: 'init';
  session_id: string;
  tools: string[];
  model: string;
}

export interface StreamJsonAssistantEvent {
  type: 'assistant';
  message: {
    content: AssistantContentBlock[];
  };
}

export interface StreamJsonToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

export interface StreamJsonUserEvent {
  type: 'user';
  message: {
    content: StreamJsonToolResultBlock[];
  };
}

export interface StreamJsonCompactEvent {
  type: 'system';
  subtype: 'compact_boundary';
  compact_metadata: Record<string, unknown>;
}

export interface StreamJsonResultEvent {
  type: 'result';
  subtype: string;
  total_cost_usd: number;
  num_turns: number;
  session_id: string;
  // Extended fields from CLI (may not always be present)
  total_input_tokens?: number | undefined;
  total_output_tokens?: number | undefined;
  total_cache_read_tokens?: number | undefined;
  total_cache_creation_tokens?: number | undefined;
}

export type StreamJsonEvent =
  | StreamJsonInitEvent
  | StreamJsonAssistantEvent
  | StreamJsonUserEvent
  | StreamJsonCompactEvent
  | StreamJsonResultEvent;
