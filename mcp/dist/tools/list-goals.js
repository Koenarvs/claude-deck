import { z } from 'zod';
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
/**
 * List goals with optional status and tag filters.
 * Returns Goal[] from the dashboard API.
 */
export async function listGoals(client, input) {
    const params = {};
    if (input.status !== undefined)
        params.status = input.status;
    if (input.tag !== undefined)
        params.tag = input.tag;
    const goals = await client.listGoals(params);
    return JSON.stringify(goals, null, 2);
}
