import { z } from 'zod';
import type { DashboardApiClient } from '../api-client.js';

/** Input schema for list_goals tool. */
export const ListGoalsInputSchema = z.object({
  status: z
    .enum(['planning', 'active', 'waiting', 'complete', 'archived'])
    .optional()
    .describe('Filter by goal status'),
  tag: z
    .string()
    .optional()
    .describe('Filter by tag'),
});

export type ListGoalsInput = z.infer<typeof ListGoalsInputSchema>;

/**
 * List goals with optional status and tag filters.
 * Returns Goal[] from the dashboard API.
 */
export async function listGoals(
  client: DashboardApiClient,
  input: ListGoalsInput,
): Promise<string> {
  const params: { status?: string | undefined; tag?: string | undefined } = {};
  if (input.status !== undefined) params.status = input.status;
  if (input.tag !== undefined) params.tag = input.tag;
  const goals = await client.listGoals(params);
  return JSON.stringify(goals, null, 2);
}
