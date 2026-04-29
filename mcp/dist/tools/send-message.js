import { z } from 'zod';
/** Input schema for send_message tool. */
export const SendMessageInputSchema = z.object({
    goal_id: z.string().describe('Goal ID to send the message to'),
    prompt: z.string().min(1).describe('The message/prompt to send'),
});
/**
 * Send a follow-up message to an existing goal's active session.
 * Returns the session_id of the session that received the message.
 */
export async function sendMessage(client, input) {
    const result = await client.sendMessage(input.goal_id, input.prompt);
    return JSON.stringify(result, null, 2);
}
