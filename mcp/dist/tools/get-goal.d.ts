import { z } from 'zod';
import type { DashboardApiClient } from '../api-client.js';
/** Input schema for get_goal tool. */
export declare const GetGoalInputSchema: z.ZodObject<{
    id: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
}, {
    id: string;
}>;
export type GetGoalInput = z.infer<typeof GetGoalInputSchema>;
/**
 * Get a single goal with its messages and plan.
 * Returns GoalDetail from the dashboard API.
 */
export declare function getGoal(client: DashboardApiClient, input: GetGoalInput): Promise<string>;
