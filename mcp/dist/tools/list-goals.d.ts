import { z } from 'zod';
import type { DashboardApiClient } from '../api-client.js';
/** Input schema for list_goals tool. */
export declare const ListGoalsInputSchema: z.ZodObject<{
    status: z.ZodOptional<z.ZodEnum<["planning", "active", "waiting", "complete", "archived"]>>;
    tag: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    status?: "active" | "planning" | "waiting" | "complete" | "archived" | undefined;
    tag?: string | undefined;
}, {
    status?: "active" | "planning" | "waiting" | "complete" | "archived" | undefined;
    tag?: string | undefined;
}>;
export type ListGoalsInput = z.infer<typeof ListGoalsInputSchema>;
/**
 * List goals with optional status and tag filters.
 * Returns Goal[] from the dashboard API.
 */
export declare function listGoals(client: DashboardApiClient, input: ListGoalsInput): Promise<string>;
