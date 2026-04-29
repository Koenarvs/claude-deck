import { z } from 'zod';
import type { DashboardApiClient } from '../api-client.js';
/** Input schema for create_goal_and_instruct tool. */
export declare const CreateGoalAndInstructInputSchema: z.ZodObject<{
    title: z.ZodString;
    cwd: z.ZodString;
    model: z.ZodOptional<z.ZodEnum<["opus", "sonnet", "haiku", "default"]>>;
    tags: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    description: z.ZodOptional<z.ZodString>;
    instruction: z.ZodString;
    source_goal_id: z.ZodString;
    spawn_session: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
}, "strip", z.ZodTypeAny, {
    title: string;
    cwd: string;
    instruction: string;
    source_goal_id: string;
    spawn_session: boolean;
    description?: string | undefined;
    tags?: string[] | undefined;
    model?: "opus" | "sonnet" | "haiku" | "default" | undefined;
}, {
    title: string;
    cwd: string;
    instruction: string;
    source_goal_id: string;
    description?: string | undefined;
    tags?: string[] | undefined;
    model?: "opus" | "sonnet" | "haiku" | "default" | undefined;
    spawn_session?: boolean | undefined;
}>;
export type CreateGoalAndInstructInput = z.infer<typeof CreateGoalAndInstructInputSchema>;
/**
 * Atomically create a new goal, send an instruction to it, and optionally spawn a session.
 * This is a composite operation: if any step fails, the whole thing rolls back.
 * Returns the created Goal, the instruction message, and the session ID (if spawned).
 */
export declare function createGoalAndInstruct(client: DashboardApiClient, input: CreateGoalAndInstructInput): Promise<string>;
