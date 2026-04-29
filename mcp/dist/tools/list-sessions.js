import { z } from 'zod';
/** Input schema for list_sessions tool. */
export const ListSessionsInputSchema = z.object({
    origin: z
        .enum(['dashboard', 'external'])
        .optional()
        .describe('Filter by session origin'),
    active: z
        .enum(['true', 'false'])
        .optional()
        .describe('Filter by active status ("true" for running, "false" for ended)'),
});
/**
 * List sessions with optional origin and active filters.
 * Returns Session[] from the dashboard API.
 */
export async function listSessions(client, input) {
    const params = {};
    if (input.origin !== undefined)
        params.origin = input.origin;
    if (input.active !== undefined)
        params.active = input.active;
    const sessions = await client.listSessions(params);
    return JSON.stringify(sessions, null, 2);
}
