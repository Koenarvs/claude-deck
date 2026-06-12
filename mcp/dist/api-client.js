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
// ── Error types ──────────────────────────────────────────────────────────────
const DEFAULT_BASE_URL = 'http://127.0.0.1:4100';
/**
 * Error thrown when the dashboard API returns a non-2xx response.
 */
export class ApiError extends Error {
    statusCode;
    body;
    constructor(statusCode, body) {
        super(`API error ${statusCode}: ${body}`);
        this.statusCode = statusCode;
        this.body = body;
        this.name = 'ApiError';
    }
}
/**
 * Error thrown when the dashboard API is unreachable.
 */
export class ApiConnectionError extends Error {
    cause_message;
    constructor(cause_message) {
        super(`Cannot connect to claude-deck at ${DEFAULT_BASE_URL}: ${cause_message}`);
        this.cause_message = cause_message;
        this.name = 'ApiConnectionError';
    }
}
// ── Client ───────────────────────────────────────────────────────────────────
/**
 * Typed HTTP client for the claude-deck dashboard API.
 * All methods validate responses via zod before returning domain types.
 */
export class DashboardApiClient {
    baseUrl;
    constructor(baseUrl) {
        this.baseUrl = baseUrl ?? DEFAULT_BASE_URL;
    }
    /** Send a JSON request and return the parsed response body. */
    async request(method, path, body, schema) {
        const url = `${this.baseUrl}${path}`;
        const headers = {
            'Accept': 'application/json',
        };
        const token = process.env['CLAUDE_DECK_TOKEN'];
        if (token && token.trim().length > 0) {
            headers['Authorization'] = `Bearer ${token}`;
        }
        const init = { method, headers };
        if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(body);
        }
        let response;
        try {
            response = await fetch(url, init);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new ApiConnectionError(message);
        }
        const text = await response.text();
        if (!response.ok) {
            throw new ApiError(response.status, text);
        }
        const json = JSON.parse(text);
        if (schema) {
            return schema.parse(json);
        }
        return json;
    }
    // ── Goals ────────────────────────────────────────────────────────────────
    /** List goals with optional status and tag filters. */
    async listGoals(params) {
        const query = new URLSearchParams();
        if (params?.status !== undefined)
            query.set('status', params.status);
        if (params?.tag !== undefined)
            query.set('tag', params.tag);
        const qs = query.toString();
        const path = `/api/goals${qs ? `?${qs}` : ''}`;
        return this.request('GET', path, undefined, z.array(GoalResponseSchema));
    }
    /** Get a single goal with its messages and plan. */
    async getGoal(id) {
        return this.request('GET', `/api/goals/${encodeURIComponent(id)}`, undefined, GoalDetailResponseSchema);
    }
    /** Create a new goal. Optionally spawns a session with initialPrompt. */
    async createGoal(input) {
        const body = {
            title: input.title,
            cwd: input.cwd,
        };
        if (input.model !== undefined)
            body['model'] = input.model;
        if (input.initialPrompt !== undefined)
            body['initialPrompt'] = input.initialPrompt;
        if (input.tags !== undefined)
            body['tags'] = input.tags;
        if (input.permission_mode !== undefined)
            body['permission_mode'] = input.permission_mode;
        return this.request('POST', '/api/goals', body, GoalResponseSchema);
    }
    /** Update an existing goal's fields (title, description, status, tags). */
    async updateGoal(id, input) {
        const body = {};
        if (input.status !== undefined)
            body['status'] = input.status;
        if (input.title !== undefined)
            body['title'] = input.title;
        if (input.description !== undefined)
            body['description'] = input.description;
        if (input.tags !== undefined)
            body['tags'] = input.tags;
        return this.request('PATCH', `/api/goals/${encodeURIComponent(id)}`, body, GoalResponseSchema);
    }
    /** Atomically create a goal, send an instruction to it, and optionally spawn a session. */
    async createGoalAndInstruct(input) {
        const body = {
            title: input.title,
            cwd: input.cwd,
            instruction: input.instruction,
            source_goal_id: input.source_goal_id,
        };
        if (input.description !== undefined)
            body['description'] = input.description;
        if (input.model !== undefined)
            body['model'] = input.model;
        if (input.tags !== undefined)
            body['tags'] = input.tags;
        if (input.spawn_session !== undefined)
            body['spawn_session'] = input.spawn_session;
        return this.request('POST', '/api/goals/create-and-instruct', body, CreateGoalAndInstructResponseSchema);
    }
    // ── Messages ─────────────────────────────────────────────────────────────
    /** Send a follow-up message to an existing goal. */
    async sendMessage(goalId, prompt) {
        return this.request('POST', `/api/goals/${encodeURIComponent(goalId)}/messages`, { prompt }, SendMessageResponseSchema);
    }
    // ── Sessions ─────────────────────────────────────────────────────────────
    /** List sessions with optional filters. */
    async listSessions(params) {
        const query = new URLSearchParams();
        if (params?.origin !== undefined)
            query.set('origin', params.origin);
        if (params?.active !== undefined)
            query.set('active', params.active);
        const qs = query.toString();
        const path = `/api/sessions${qs ? `?${qs}` : ''}`;
        return this.request('GET', path, undefined, z.array(SessionResponseSchema));
    }
    /** Get messages for a specific session. */
    async getSessionMessages(sessionId) {
        return this.request('GET', `/api/sessions/${encodeURIComponent(sessionId)}/messages`, undefined, z.array(MessageResponseSchema));
    }
    // ── Inter-Goal Messages ──────────────────────────────────────────────
    /** Send an instruction from one goal to another. */
    async sendGoalInstruction(fromGoalId, targetGoalId, body) {
        const requestBody = {
            content: body.content,
        };
        if (body.message_type !== undefined) {
            requestBody['message_type'] = body.message_type;
        }
        return this.request('POST', `/api/goals/${encodeURIComponent(fromGoalId)}/instruct/${encodeURIComponent(targetGoalId)}`, requestBody, InterGoalMessageResponseSchema);
    }
    /** Get pending/delivered instructions for a goal. */
    async getInstructions(goalId) {
        return this.request('GET', `/api/goals/${encodeURIComponent(goalId)}/instructions`, undefined, z.array(InterGoalMessageResponseSchema));
    }
    /** Mark an instruction as delivered. */
    async markDelivered(goalId, messageId) {
        return this.request('POST', `/api/goals/${encodeURIComponent(goalId)}/instructions/${encodeURIComponent(messageId)}/acknowledge`, undefined, InterGoalMessageResponseSchema);
    }
    // ── Scheduled Tasks ──────────────────────────────────────────────────────
    /** Create a scheduled task. */
    async createScheduledTask(input) {
        const template = {
            title: input.goal_template.title,
            cwd: input.goal_template.cwd,
        };
        if (input.goal_template.model !== undefined)
            template['model'] = input.goal_template.model;
        if (input.goal_template.initialPrompt !== undefined)
            template['initialPrompt'] = input.goal_template.initialPrompt;
        if (input.goal_template.tags !== undefined)
            template['tags'] = input.goal_template.tags;
        return this.request('POST', '/api/scheduled-tasks', {
            name: input.name,
            cron_expr: input.cron_expr,
            goal_template_json: template,
        }, ScheduledTaskResponseSchema);
    }
}
