import { z } from 'zod';
/** Input schema for get_goal tool. */
export const GetGoalInputSchema = z.object({
    id: z.string().describe('Goal ID (UUID)'),
});
/**
 * Get a single goal with its messages and plan.
 * Returns GoalDetail from the dashboard API.
 */
export async function getGoal(client, input) {
    const detail = await client.getGoal(input.id);
    return JSON.stringify(detail, null, 2);
}
