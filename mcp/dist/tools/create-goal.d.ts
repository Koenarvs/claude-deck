import { z } from 'zod';
import type { DashboardApiClient } from '../api-client.js';
/** Input schema for create_goal tool. */
export declare const CreateGoalInputSchema: z.ZodObject<{
    title: z.ZodString;
    cwd: z.ZodString;
    model: z.ZodOptional<z.ZodEnum<["opus", "sonnet", "haiku", "default"]>>;
    permission_mode: z.ZodOptional<z.ZodEnum<["autonomous", "supervised"]>>;
    initialPrompt: z.ZodOptional<z.ZodString>;
    tags: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
}, "strip", z.ZodTypeAny, {
    title: string;
    cwd: string;
    tags?: string[] | undefined;
    model?: "opus" | "sonnet" | "haiku" | "default" | undefined;
    permission_mode?: "autonomous" | "supervised" | undefined;
    initialPrompt?: string | undefined;
}, {
    title: string;
    cwd: string;
    tags?: string[] | undefined;
    model?: "opus" | "sonnet" | "haiku" | "default" | undefined;
    permission_mode?: "autonomous" | "supervised" | undefined;
    initialPrompt?: string | undefined;
}>;
export type CreateGoalInput = z.infer<typeof CreateGoalInputSchema>;
/**
 * Create a new goal and optionally spawn a session with an initial prompt.
 * Returns the created Goal from the dashboard API.
 */
export declare function createGoal(client: DashboardApiClient, input: CreateGoalInput): Promise<string>;
