import { z } from 'zod';
import { ApiError } from '../api-client.js';
/** Input schema for create_goal_and_instruct tool. */
export const CreateGoalAndInstructInputSchema = z.object({
    title: z.string().min(1).describe('Goal title'),
    cwd: z.string().min(1).describe('Working directory (absolute path)'),
    model: z
        .enum(['opus', 'sonnet', 'haiku', 'default'])
        .optional()
        .describe('Claude model to use'),
    permission_mode: z
        .enum(['autonomous', 'supervised'])
        .optional()
        .describe('Permission mode for the session (default: supervised)'),
    tags: z
        .array(z.string())
        .optional()
        .describe('Tags for categorization'),
    description: z
        .string()
        .optional()
        .describe('Goal description'),
    instruction: z
        .string()
        .min(1)
        .describe('The instruction content to send to the new goal'),
    source_goal_id: z
        .string()
        .min(1)
        .describe('ID of the goal sending the instruction'),
    spawn_session: z
        .boolean()
        .optional()
        .default(true)
        .describe('Whether to spawn a session immediately (default: true)'),
});
/**
 * Atomically create a new goal, send an instruction to it, and optionally spawn a session.
 * This is a composite operation: if any step fails, the whole thing rolls back.
 * Returns the created Goal, the instruction message, and the session ID (if spawned).
 */
export async function createGoalAndInstruct(client, input) {
    const params = {
        title: input.title,
        cwd: input.cwd,
        instruction: input.instruction,
        source_goal_id: input.source_goal_id,
    };
    if (input.model !== undefined)
        params.model = input.model;
    if (input.permission_mode !== undefined)
        params.permission_mode = input.permission_mode;
    if (input.tags !== undefined)
        params.tags = input.tags;
    if (input.description !== undefined)
        params.description = input.description;
    if (input.spawn_session !== undefined)
        params.spawn_session = input.spawn_session;
    try {
        const result = await client.createGoalAndInstruct(params);
        return JSON.stringify(result, null, 2);
    }
    catch (err) {
        if (err instanceof ApiError && err.statusCode === 409) {
            let parsed = {};
            try {
                parsed = JSON.parse(err.body);
            }
            catch { /* ignore */ }
            const existingId = parsed['existing_goal_id'] ?? 'unknown';
            throw new Error(`A goal with title "${input.title}" already exists (goal ID: ${existingId}). ` +
                `Use send_goal_instruction to send work to it, or choose a different title.`);
        }
        throw err;
    }
}
