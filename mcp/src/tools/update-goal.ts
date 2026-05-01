import { z } from 'zod';
import type { DashboardApiClient } from '../api-client.js';

/** Input schema for update_goal tool. */
export const UpdateGoalInputSchema = z.object({
  goal_id: z.string().describe('Goal ID to update'),
  status: z
    .enum(['planning', 'active', 'waiting', 'complete', 'archived'])
    .optional()
    .describe('New status for the goal'),
  title: z
    .string()
    .min(1)
    .optional()
    .describe('New title for the goal'),
  description: z
    .string()
    .nullable()
    .optional()
    .describe('New description for the goal (null to clear)'),
  tags: z
    .array(z.string())
    .optional()
    .describe('New tags for the goal (replaces existing tags)'),
});

export type UpdateGoalInput = z.infer<typeof UpdateGoalInputSchema>;

/**
 * Update an existing goal's status, title, description, or tags.
 * Returns the updated Goal from the dashboard API.
 */
export async function updateGoal(
  client: DashboardApiClient,
  input: UpdateGoalInput,
): Promise<string> {
  const params: {
    status?: string | undefined;
    title?: string | undefined;
    description?: string | null | undefined;
    tags?: string[] | undefined;
  } = {};
  if (input.status !== undefined) params.status = input.status;
  if (input.title !== undefined) params.title = input.title;
  if (input.description !== undefined) params.description = input.description;
  if (input.tags !== undefined) params.tags = input.tags;
  const goal = await client.updateGoal(input.goal_id, params);
  return JSON.stringify(goal, null, 2);
}
