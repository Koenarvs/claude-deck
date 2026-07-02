import { z } from 'zod';

// ── Response Schemas ─────────────────────────────────────────────────────────
// Local zod schemas for validating dashboard API responses.
// These mirror the shared types but live in-package to avoid rootDir issues.

const GoalResponseSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  cwd: z.string(),
  status: z.string(),
  priority: z.number(),
  tags: z.array(z.string()),
  current_session_id: z.string().nullable(),
  model: z.string().nullable(),
  permission_mode: z.string(),
  plan_json: z.unknown().nullable(),
  kanban_order: z.number(),
  created_at: z.number(),
  updated_at: z.number(),
  completed_at: z.number().nullable(),
});

const SessionResponseSchema = z.object({
  id: z.string(),
  goal_id: z.string().nullable(),
  origin: z.string(),
  cwd: z.string().nullable(),
  model: z.string().nullable(),
  trace_dir: z.string().nullable(),
  stream_event_count: z.number(),
  hook_event_count: z.number(),
  stderr_bytes: z.number(),
  started_at: z.number().nullable(),
  ended_at: z.number().nullable(),
});

const MessageResponseSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  role: z.string(),
  content: z.string().nullable(),
  tool_name: z.string().nullable(),
  tool_args: z.string().nullable(),
  tool_result: z.string().nullable(),
  tool_use_id: z.string().nullable(),
  created_at: z.number(),
});

const GoalDetailResponseSchema = z.object({
  goal: GoalResponseSchema,
  messages: z.array(MessageResponseSchema),
  plan: z.unknown().nullable(),
});

const ScheduledTaskResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  cron_expr: z.string(),
  goal_template_json: z.string(),
  enabled: z.boolean(),
  last_run_at: z.number().nullable(),
  next_run_at: z.number().nullable(),
  created_at: z.number(),
});

const SendMessageResponseSchema = z.object({
  session_id: z.string(),
});

const InterGoalMessageResponseSchema = z.object({
  id: z.string(),
  from_goal_id: z.string(),
  to_goal_id: z.string(),
  content: z.string(),
  message_type: z.string(),
  status: z.string(),
  created_at: z.number(),
  delivered_at: z.number().nullable(),
  acknowledged_at: z.number().nullable(),
});

const CreateGoalAndInstructResponseSchema = z.object({
  goal: GoalResponseSchema,
  instruction: InterGoalMessageResponseSchema,
  session_id: z.string().nullable(),
});

// ── Inferred types ───────────────────────────────────────────────────────────

/** Goal as returned by the dashboard API. */
export type Goal = z.infer<typeof GoalResponseSchema>;

/** Goal with its messages and plan. */
export type GoalDetail = z.infer<typeof GoalDetailResponseSchema>;

/** Session as returned by the dashboard API. */
export type Session = z.infer<typeof SessionResponseSchema>;

/** Message as returned by the dashboard API. */
export type Message = z.infer<typeof MessageResponseSchema>;

/** Scheduled task as returned by the dashboard API. */
export type ScheduledTask = z.infer<typeof ScheduledTaskResponseSchema>;

/** Response from the create-goal-and-instruct composite endpoint. */
export type CreateGoalAndInstructResponse = z.infer<typeof CreateGoalAndInstructResponseSchema>;

// ── Error types ──────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = 'http://127.0.0.1:4100';

/**
 * Error thrown when the dashboard API returns a non-2xx response.
 */
export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly body: string,
  ) {
    super(`API error ${statusCode}: ${body}`);
    this.name = 'ApiError';
  }
}

/**
 * Error thrown when the dashboard API is unreachable.
 */
export class ApiConnectionError extends Error {
  constructor(
    public readonly cause_message: string,
  ) {
    super(`Cannot connect to claude-deck at ${DEFAULT_BASE_URL}: ${cause_message}`);
    this.name = 'ApiConnectionError';
  }
}

// ── Client ───────────────────────────────────────────────────────────────────

/**
 * Typed HTTP client for the claude-deck dashboard API.
 * All methods validate responses via zod before returning domain types.
 */
export class DashboardApiClient {
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? DEFAULT_BASE_URL;
  }

  /** Send a JSON request and return the parsed response body. */
  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    schema?: z.ZodType<T>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };
    const token = process.env['CLAUDE_DECK_TOKEN'];
    if (token && token.trim().length > 0) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const init: RequestInit = { method, headers };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ApiConnectionError(message);
    }

    const text = await response.text();

    if (!response.ok) {
      throw new ApiError(response.status, text);
    }

    const json: unknown = JSON.parse(text);

    if (schema) {
      return schema.parse(json);
    }

    return json as T;
  }

  // ── Goals ────────────────────────────────────────────────────────────────

  /** List goals with optional status and tag filters. */
  async listGoals(params?: {
    status?: string | undefined;
    tag?: string | undefined;
  }): Promise<Goal[]> {
    const query = new URLSearchParams();
    if (params?.status !== undefined) query.set('status', params.status);
    if (params?.tag !== undefined) query.set('tag', params.tag);
    const qs = query.toString();
    const path = `/api/goals${qs ? `?${qs}` : ''}`;
    return this.request('GET', path, undefined, z.array(GoalResponseSchema));
  }

  /** Get a single goal with its messages and plan. */
  async getGoal(id: string): Promise<GoalDetail> {
    return this.request(
      'GET',
      `/api/goals/${encodeURIComponent(id)}`,
      undefined,
      GoalDetailResponseSchema,
    );
  }

  /** Create a new goal. Optionally spawns a session with initialPrompt. */
  async createGoal(input: {
    title: string;
    cwd: string;
    model?: string | undefined;
    initialPrompt?: string | undefined;
    tags?: string[] | undefined;
    permission_mode?: string | undefined;
    agent_type?: string | undefined;
  }): Promise<Goal> {
    const body: Record<string, unknown> = {
      title: input.title,
      cwd: input.cwd,
    };
    if (input.model !== undefined) body['model'] = input.model;
    if (input.initialPrompt !== undefined) body['initialPrompt'] = input.initialPrompt;
    if (input.tags !== undefined) body['tags'] = input.tags;
    if (input.permission_mode !== undefined) body['permission_mode'] = input.permission_mode;
    if (input.agent_type !== undefined) body['agent_type'] = input.agent_type;
    return this.request('POST', '/api/goals', body, GoalResponseSchema);
  }

  /** Update an existing goal's fields (title, description, status, tags). */
  async updateGoal(
    id: string,
    input: {
      status?: string | undefined;
      title?: string | undefined;
      description?: string | null | undefined;
      tags?: string[] | undefined;
    },
  ): Promise<Goal> {
    const body: Record<string, unknown> = {};
    if (input.status !== undefined) body['status'] = input.status;
    if (input.title !== undefined) body['title'] = input.title;
    if (input.description !== undefined) body['description'] = input.description;
    if (input.tags !== undefined) body['tags'] = input.tags;
    return this.request(
      'PATCH',
      `/api/goals/${encodeURIComponent(id)}`,
      body,
      GoalResponseSchema,
    );
  }

  /** Atomically create a goal, send an instruction to it, and optionally spawn a session. */
  async createGoalAndInstruct(input: {
    title: string;
    cwd: string;
    description?: string | undefined;
    model?: string | undefined;
    tags?: string[] | undefined;
    instruction: string;
    source_goal_id: string;
    spawn_session?: boolean | undefined;
    permission_mode?: string | undefined;
    agent_type?: string | undefined;
  }): Promise<CreateGoalAndInstructResponse> {
    const body: Record<string, unknown> = {
      title: input.title,
      cwd: input.cwd,
      instruction: input.instruction,
      source_goal_id: input.source_goal_id,
    };
    if (input.description !== undefined) body['description'] = input.description;
    if (input.model !== undefined) body['model'] = input.model;
    if (input.tags !== undefined) body['tags'] = input.tags;
    if (input.spawn_session !== undefined) body['spawn_session'] = input.spawn_session;
    if (input.permission_mode !== undefined) body['permission_mode'] = input.permission_mode;
    if (input.agent_type !== undefined) body['agent_type'] = input.agent_type;
    return this.request(
      'POST',
      '/api/goals/create-and-instruct',
      body,
      CreateGoalAndInstructResponseSchema,
    );
  }

  // ── Messages ─────────────────────────────────────────────────────────────

  /** Send a follow-up message to an existing goal. */
  async sendMessage(
    goalId: string,
    prompt: string,
  ): Promise<{ session_id: string }> {
    return this.request(
      'POST',
      `/api/goals/${encodeURIComponent(goalId)}/messages`,
      { prompt },
      SendMessageResponseSchema,
    );
  }

  // ── Sessions ─────────────────────────────────────────────────────────────

  /** List sessions with optional filters. */
  async listSessions(params?: {
    origin?: string | undefined;
    active?: string | undefined;
  }): Promise<Session[]> {
    const query = new URLSearchParams();
    if (params?.origin !== undefined) query.set('origin', params.origin);
    if (params?.active !== undefined) query.set('active', params.active);
    const qs = query.toString();
    const path = `/api/sessions${qs ? `?${qs}` : ''}`;
    return this.request('GET', path, undefined, z.array(SessionResponseSchema));
  }

  /** Get messages for a specific session. */
  async getSessionMessages(sessionId: string): Promise<Message[]> {
    return this.request(
      'GET',
      `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
      undefined,
      z.array(MessageResponseSchema),
    );
  }

  // ── Inter-Goal Messages ──────────────────────────────────────────────

  /** Send an instruction from one goal to another. */
  async sendGoalInstruction(
    fromGoalId: string,
    targetGoalId: string,
    body: { content: string; message_type?: string },
  ): Promise<z.infer<typeof InterGoalMessageResponseSchema>> {
    const requestBody: Record<string, unknown> = {
      content: body.content,
    };
    if (body.message_type !== undefined) {
      requestBody['message_type'] = body.message_type;
    }
    return this.request(
      'POST',
      `/api/goals/${encodeURIComponent(fromGoalId)}/instruct/${encodeURIComponent(targetGoalId)}`,
      requestBody,
      InterGoalMessageResponseSchema,
    );
  }

  /** Get pending/delivered instructions for a goal. */
  async getInstructions(
    goalId: string,
  ): Promise<Array<z.infer<typeof InterGoalMessageResponseSchema>>> {
    return this.request(
      'GET',
      `/api/goals/${encodeURIComponent(goalId)}/instructions`,
      undefined,
      z.array(InterGoalMessageResponseSchema),
    );
  }

  /** Mark an instruction as delivered. */
  async markDelivered(
    goalId: string,
    messageId: string,
  ): Promise<z.infer<typeof InterGoalMessageResponseSchema>> {
    return this.request(
      'POST',
      `/api/goals/${encodeURIComponent(goalId)}/instructions/${encodeURIComponent(messageId)}/acknowledge`,
      undefined,
      InterGoalMessageResponseSchema,
    );
  }

  // ── Scheduled Tasks ──────────────────────────────────────────────────────

  /** Create a scheduled task. */
  async createScheduledTask(input: {
    name: string;
    cron_expr: string;
    goal_template: {
      title: string;
      cwd: string;
      model?: string | undefined;
      initialPrompt?: string | undefined;
      tags?: string[] | undefined;
    };
  }): Promise<ScheduledTask> {
    const template: Record<string, unknown> = {
      title: input.goal_template.title,
      cwd: input.goal_template.cwd,
    };
    if (input.goal_template.model !== undefined) template['model'] = input.goal_template.model;
    if (input.goal_template.initialPrompt !== undefined) template['initialPrompt'] = input.goal_template.initialPrompt;
    if (input.goal_template.tags !== undefined) template['tags'] = input.goal_template.tags;

    return this.request(
      'POST',
      '/api/scheduled-tasks',
      {
        name: input.name,
        cron_expr: input.cron_expr,
        goal_template_json: template,
      },
      ScheduledTaskResponseSchema,
    );
  }
}
