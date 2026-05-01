import { z } from 'zod';
import type { DashboardApiClient } from '../api-client.js';
/** Input schema for update_goal tool. */
export declare const UpdateGoalInputSchema: z.ZodObject<{
    goal_id: z.ZodString;
    status: z.ZodOptional<z.ZodEnum<["planning", "active", "waiting", "complete", "archived"]>>;
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    tags: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
}, "strip", z.ZodTypeAny, {
    goal_id: string;
    title?: string | undefined;
    description?: string | null | undefined;
    status?: "active" | "planning" | "waiting" | "complete" | "archived" | undefined;
    tags?: string[] | undefined;
}, {
    goal_id: string;
    title?: string | undefined;
    description?: string | null | undefined;
    status?: "active" | "planning" | "waiting" | "complete" | "archived" | undefined;
    tags?: string[] | undefined;
}>;
export type UpdateGoalInput = z.infer<typeof UpdateGoalInputSchema>;
/**
 * Update an existing goal's status, title, description, or tags.
 * Returns the updated Goal from the dashboard API.
 */
export declare function updateGoal(client: DashboardApiClient, input: UpdateGoalInput): Promise<string>;
