import { z } from 'zod';
import type { DashboardApiClient } from '../api-client.js';

/** Input schema for create_goal tool. */
export const CreateGoalInputSchema = z.object({
  title: z.string().min(1).describe('Goal title'),
  cwd: z.string().min(1).describe('Working directory (absolute path)'),
  model: z
    .enum(['opus', 'sonnet', 'haiku', 'default'])
    .optional()
    .describe('Claude model to use'),
  initialPrompt: z
    .string()
    .optional()
    .describe('Initial prompt to send; spawns a session immediately if provided'),
  tags: z
    .array(z.string())
    .optional()
    .describe('Tags for categorization'),
});

export type CreateGoalInput = z.infer<typeof CreateGoalInputSchema>;

/**
 * Create a new goal and optionally spawn a session with an initial prompt.
 * Returns the created Goal from the dashboard API.
 */
export async function createGoal(
  client: DashboardApiClient,
  input: CreateGoalInput,
): Promise<string> {
  const params: {
    title: string;
    cwd: string;
    model?: string | undefined;
    initialPrompt?: string | undefined;
    tags?: string[] | undefined;
  } = { title: input.title, cwd: input.cwd };
  if (input.model !== undefined) params.model = input.model;
  if (input.initialPrompt !== undefined) params.initialPrompt = input.initialPrompt;
  if (input.tags !== undefined) params.tags = input.tags;
  const goal = await client.createGoal(params);
  return JSON.stringify(goal, null, 2);
}
