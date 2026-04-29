import { z } from 'zod';
/** Input schema for get_session_messages tool. */
export const GetSessionMessagesInputSchema = z.object({
    session_id: z.string().describe('Session ID to fetch messages for'),
});
/**
 * Get all messages for a specific session.
 * Returns Message[] from the dashboard API.
 */
export async function getSessionMessages(client, input) {
    const messages = await client.getSessionMessages(input.session_id);
    return JSON.stringify(messages, null, 2);
}
