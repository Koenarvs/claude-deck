import { z } from 'zod';
declare const GoalResponseSchema: z.ZodObject<{
    id: z.ZodString;
    title: z.ZodString;
    description: z.ZodNullable<z.ZodString>;
    cwd: z.ZodString;
    status: z.ZodString;
    priority: z.ZodNumber;
    tags: z.ZodArray<z.ZodString, "many">;
    current_session_id: z.ZodNullable<z.ZodString>;
    model: z.ZodNullable<z.ZodString>;
    permission_mode: z.ZodString;
    plan_json: z.ZodNullable<z.ZodUnknown>;
    kanban_order: z.ZodNumber;
    created_at: z.ZodNumber;
    updated_at: z.ZodNumber;
    completed_at: z.ZodNullable<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    id: string;
    title: string;
    description: string | null;
    cwd: string;
    status: string;
    priority: number;
    tags: string[];
    current_session_id: string | null;
    model: string | null;
    permission_mode: string;
    kanban_order: number;
    created_at: number;
    updated_at: number;
    completed_at: number | null;
    plan_json?: unknown;
}, {
    id: string;
    title: string;
    description: string | null;
    cwd: string;
    status: string;
    priority: number;
    tags: string[];
    current_session_id: string | null;
    model: string | null;
    permission_mode: string;
    kanban_order: number;
    created_at: number;
    updated_at: number;
    completed_at: number | null;
    plan_json?: unknown;
}>;
declare const SessionResponseSchema: z.ZodObject<{
    id: z.ZodString;
    goal_id: z.ZodNullable<z.ZodString>;
    origin: z.ZodString;
    cwd: z.ZodNullable<z.ZodString>;
    model: z.ZodNullable<z.ZodString>;
    trace_dir: z.ZodNullable<z.ZodString>;
    stream_event_count: z.ZodNumber;
    hook_event_count: z.ZodNumber;
    stderr_bytes: z.ZodNumber;
    started_at: z.ZodNullable<z.ZodNumber>;
    ended_at: z.ZodNullable<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    id: string;
    cwd: string | null;
    model: string | null;
    goal_id: string | null;
    origin: string;
    trace_dir: string | null;
    stream_event_count: number;
    hook_event_count: number;
    stderr_bytes: number;
    started_at: number | null;
    ended_at: number | null;
}, {
    id: string;
    cwd: string | null;
    model: string | null;
    goal_id: string | null;
    origin: string;
    trace_dir: string | null;
    stream_event_count: number;
    hook_event_count: number;
    stderr_bytes: number;
    started_at: number | null;
    ended_at: number | null;
}>;
declare const MessageResponseSchema: z.ZodObject<{
    id: z.ZodString;
    session_id: z.ZodString;
    role: z.ZodString;
    content: z.ZodNullable<z.ZodString>;
    tool_name: z.ZodNullable<z.ZodString>;
    tool_args: z.ZodNullable<z.ZodString>;
    tool_result: z.ZodNullable<z.ZodString>;
    tool_use_id: z.ZodNullable<z.ZodString>;
    created_at: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    id: string;
    created_at: number;
    session_id: string;
    role: string;
    content: string | null;
    tool_name: string | null;
    tool_args: string | null;
    tool_result: string | null;
    tool_use_id: string | null;
}, {
    id: string;
    created_at: number;
    session_id: string;
    role: string;
    content: string | null;
    tool_name: string | null;
    tool_args: string | null;
    tool_result: string | null;
    tool_use_id: string | null;
}>;
declare const GoalDetailResponseSchema: z.ZodObject<{
    goal: z.ZodObject<{
        id: z.ZodString;
        title: z.ZodString;
        description: z.ZodNullable<z.ZodString>;
        cwd: z.ZodString;
        status: z.ZodString;
        priority: z.ZodNumber;
        tags: z.ZodArray<z.ZodString, "many">;
        current_session_id: z.ZodNullable<z.ZodString>;
        model: z.ZodNullable<z.ZodString>;
        permission_mode: z.ZodString;
        plan_json: z.ZodNullable<z.ZodUnknown>;
        kanban_order: z.ZodNumber;
        created_at: z.ZodNumber;
        updated_at: z.ZodNumber;
        completed_at: z.ZodNullable<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        title: string;
        description: string | null;
        cwd: string;
        status: string;
        priority: number;
        tags: string[];
        current_session_id: string | null;
        model: string | null;
        permission_mode: string;
        kanban_order: number;
        created_at: number;
        updated_at: number;
        completed_at: number | null;
        plan_json?: unknown;
    }, {
        id: string;
        title: string;
        description: string | null;
        cwd: string;
        status: string;
        priority: number;
        tags: string[];
        current_session_id: string | null;
        model: string | null;
        permission_mode: string;
        kanban_order: number;
        created_at: number;
        updated_at: number;
        completed_at: number | null;
        plan_json?: unknown;
    }>;
    messages: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        session_id: z.ZodString;
        role: z.ZodString;
        content: z.ZodNullable<z.ZodString>;
        tool_name: z.ZodNullable<z.ZodString>;
        tool_args: z.ZodNullable<z.ZodString>;
        tool_result: z.ZodNullable<z.ZodString>;
        tool_use_id: z.ZodNullable<z.ZodString>;
        created_at: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        id: string;
        created_at: number;
        session_id: string;
        role: string;
        content: string | null;
        tool_name: string | null;
        tool_args: string | null;
        tool_result: string | null;
        tool_use_id: string | null;
    }, {
        id: string;
        created_at: number;
        session_id: string;
        role: string;
        content: string | null;
        tool_name: string | null;
        tool_args: string | null;
        tool_result: string | null;
        tool_use_id: string | null;
    }>, "many">;
    plan: z.ZodNullable<z.ZodUnknown>;
}, "strip", z.ZodTypeAny, {
    goal: {
        id: string;
        title: string;
        description: string | null;
        cwd: string;
        status: string;
        priority: number;
        tags: string[];
        current_session_id: string | null;
        model: string | null;
        permission_mode: string;
        kanban_order: number;
        created_at: number;
        updated_at: number;
        completed_at: number | null;
        plan_json?: unknown;
    };
    messages: {
        id: string;
        created_at: number;
        session_id: string;
        role: string;
        content: string | null;
        tool_name: string | null;
        tool_args: string | null;
        tool_result: string | null;
        tool_use_id: string | null;
    }[];
    plan?: unknown;
}, {
    goal: {
        id: string;
        title: string;
        description: string | null;
        cwd: string;
        status: string;
        priority: number;
        tags: string[];
        current_session_id: string | null;
        model: string | null;
        permission_mode: string;
        kanban_order: number;
        created_at: number;
        updated_at: number;
        completed_at: number | null;
        plan_json?: unknown;
    };
    messages: {
        id: string;
        created_at: number;
        session_id: string;
        role: string;
        content: string | null;
        tool_name: string | null;
        tool_args: string | null;
        tool_result: string | null;
        tool_use_id: string | null;
    }[];
    plan?: unknown;
}>;
declare const ScheduledTaskResponseSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    cron_expr: z.ZodString;
    goal_template_json: z.ZodString;
    enabled: z.ZodBoolean;
    last_run_at: z.ZodNullable<z.ZodNumber>;
    next_run_at: z.ZodNullable<z.ZodNumber>;
    created_at: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    id: string;
    created_at: number;
    name: string;
    cron_expr: string;
    goal_template_json: string;
    enabled: boolean;
    last_run_at: number | null;
    next_run_at: number | null;
}, {
    id: string;
    created_at: number;
    name: string;
    cron_expr: string;
    goal_template_json: string;
    enabled: boolean;
    last_run_at: number | null;
    next_run_at: number | null;
}>;
declare const InterGoalMessageResponseSchema: z.ZodObject<{
    id: z.ZodString;
    from_goal_id: z.ZodString;
    to_goal_id: z.ZodString;
    content: z.ZodString;
    message_type: z.ZodString;
    status: z.ZodString;
    created_at: z.ZodNumber;
    delivered_at: z.ZodNullable<z.ZodNumber>;
    acknowledged_at: z.ZodNullable<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    id: string;
    status: string;
    created_at: number;
    content: string;
    from_goal_id: string;
    to_goal_id: string;
    message_type: string;
    delivered_at: number | null;
    acknowledged_at: number | null;
}, {
    id: string;
    status: string;
    created_at: number;
    content: string;
    from_goal_id: string;
    to_goal_id: string;
    message_type: string;
    delivered_at: number | null;
    acknowledged_at: number | null;
}>;
declare const CreateGoalAndInstructResponseSchema: z.ZodObject<{
    goal: z.ZodObject<{
        id: z.ZodString;
        title: z.ZodString;
        description: z.ZodNullable<z.ZodString>;
        cwd: z.ZodString;
        status: z.ZodString;
        priority: z.ZodNumber;
        tags: z.ZodArray<z.ZodString, "many">;
        current_session_id: z.ZodNullable<z.ZodString>;
        model: z.ZodNullable<z.ZodString>;
        permission_mode: z.ZodString;
        plan_json: z.ZodNullable<z.ZodUnknown>;
        kanban_order: z.ZodNumber;
        created_at: z.ZodNumber;
        updated_at: z.ZodNumber;
        completed_at: z.ZodNullable<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        title: string;
        description: string | null;
        cwd: string;
        status: string;
        priority: number;
        tags: string[];
        current_session_id: string | null;
        model: string | null;
        permission_mode: string;
        kanban_order: number;
        created_at: number;
        updated_at: number;
        completed_at: number | null;
        plan_json?: unknown;
    }, {
        id: string;
        title: string;
        description: string | null;
        cwd: string;
        status: string;
        priority: number;
        tags: string[];
        current_session_id: string | null;
        model: string | null;
        permission_mode: string;
        kanban_order: number;
        created_at: number;
        updated_at: number;
        completed_at: number | null;
        plan_json?: unknown;
    }>;
    instruction: z.ZodObject<{
        id: z.ZodString;
        from_goal_id: z.ZodString;
        to_goal_id: z.ZodString;
        content: z.ZodString;
        message_type: z.ZodString;
        status: z.ZodString;
        created_at: z.ZodNumber;
        delivered_at: z.ZodNullable<z.ZodNumber>;
        acknowledged_at: z.ZodNullable<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        status: string;
        created_at: number;
        content: string;
        from_goal_id: string;
        to_goal_id: string;
        message_type: string;
        delivered_at: number | null;
        acknowledged_at: number | null;
    }, {
        id: string;
        status: string;
        created_at: number;
        content: string;
        from_goal_id: string;
        to_goal_id: string;
        message_type: string;
        delivered_at: number | null;
        acknowledged_at: number | null;
    }>;
    session_id: z.ZodNullable<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    session_id: string | null;
    goal: {
        id: string;
        title: string;
        description: string | null;
        cwd: string;
        status: string;
        priority: number;
        tags: string[];
        current_session_id: string | null;
        model: string | null;
        permission_mode: string;
        kanban_order: number;
        created_at: number;
        updated_at: number;
        completed_at: number | null;
        plan_json?: unknown;
    };
    instruction: {
        id: string;
        status: string;
        created_at: number;
        content: string;
        from_goal_id: string;
        to_goal_id: string;
        message_type: string;
        delivered_at: number | null;
        acknowledged_at: number | null;
    };
}, {
    session_id: string | null;
    goal: {
        id: string;
        title: string;
        description: string | null;
        cwd: string;
        status: string;
        priority: number;
        tags: string[];
        current_session_id: string | null;
        model: string | null;
        permission_mode: string;
        kanban_order: number;
        created_at: number;
        updated_at: number;
        completed_at: number | null;
        plan_json?: unknown;
    };
    instruction: {
        id: string;
        status: string;
        created_at: number;
        content: string;
        from_goal_id: string;
        to_goal_id: string;
        message_type: string;
        delivered_at: number | null;
        acknowledged_at: number | null;
    };
}>;
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
/**
 * Error thrown when the dashboard API returns a non-2xx response.
 */
export declare class ApiError extends Error {
    readonly statusCode: number;
    readonly body: string;
    constructor(statusCode: number, body: string);
}
/**
 * Error thrown when the dashboard API is unreachable.
 */
export declare class ApiConnectionError extends Error {
    readonly cause_message: string;
    constructor(cause_message: string);
}
/**
 * Typed HTTP client for the claude-deck dashboard API.
 * All methods validate responses via zod before returning domain types.
 */
export declare class DashboardApiClient {
    private readonly baseUrl;
    constructor(baseUrl?: string);
    /** Send a JSON request and return the parsed response body. */
    private request;
    /** List goals with optional status and tag filters. */
    listGoals(params?: {
        status?: string | undefined;
        tag?: string | undefined;
    }): Promise<Goal[]>;
    /** Get a single goal with its messages and plan. */
    getGoal(id: string): Promise<GoalDetail>;
    /** Create a new goal. Optionally spawns a session with initialPrompt. */
    createGoal(input: {
        title: string;
        cwd: string;
        model?: string | undefined;
        initialPrompt?: string | undefined;
        tags?: string[] | undefined;
        permission_mode?: string | undefined;
    }): Promise<Goal>;
    /** Update an existing goal's fields (title, description, status, tags). */
    updateGoal(id: string, input: {
        status?: string | undefined;
        title?: string | undefined;
        description?: string | null | undefined;
        tags?: string[] | undefined;
    }): Promise<Goal>;
    /** Atomically create a goal, send an instruction to it, and optionally spawn a session. */
    createGoalAndInstruct(input: {
        title: string;
        cwd: string;
        description?: string | undefined;
        model?: string | undefined;
        tags?: string[] | undefined;
        instruction: string;
        source_goal_id: string;
        spawn_session?: boolean | undefined;
    }): Promise<CreateGoalAndInstructResponse>;
    /** Send a follow-up message to an existing goal. */
    sendMessage(goalId: string, prompt: string): Promise<{
        session_id: string;
    }>;
    /** List sessions with optional filters. */
    listSessions(params?: {
        origin?: string | undefined;
        active?: string | undefined;
    }): Promise<Session[]>;
    /** Get messages for a specific session. */
    getSessionMessages(sessionId: string): Promise<Message[]>;
    /** Send an instruction from one goal to another. */
    sendGoalInstruction(fromGoalId: string, targetGoalId: string, body: {
        content: string;
        message_type?: string;
    }): Promise<z.infer<typeof InterGoalMessageResponseSchema>>;
    /** Get pending/delivered instructions for a goal. */
    getInstructions(goalId: string): Promise<Array<z.infer<typeof InterGoalMessageResponseSchema>>>;
    /** Mark an instruction as delivered. */
    markDelivered(goalId: string, messageId: string): Promise<z.infer<typeof InterGoalMessageResponseSchema>>;
    /** Create a scheduled task. */
    createScheduledTask(input: {
        name: string;
        cron_expr: string;
        goal_template: {
            title: string;
            cwd: string;
            model?: string | undefined;
            initialPrompt?: string | undefined;
            tags?: string[] | undefined;
        };
    }): Promise<ScheduledTask>;
}
export {};
