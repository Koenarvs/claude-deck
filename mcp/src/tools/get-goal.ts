import { z } from 'zod';
import type { DashboardApiClient } from '../api-client.js';

/** Input schema for get_goal tool. */
export const GetGoalInputSchema = z.object({
  id: z.string().describe('Goal ID (UUID)'),
});

export type GetGoalInput = z.infer<typeof GetGoalInputSchema>;

/**
 * Get a single goal with its messages and plan.
 * Returns GoalDetail from the dashboard API.
 */
export async function getGoal(
  client: DashboardApiClient,
  input: GetGoalInput,
): Promise<string> {
  const detail = await client.getGoal(input.id);
  return JSON.stringify(detail, null, 2);
}
