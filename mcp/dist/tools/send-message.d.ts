import { z } from 'zod';
import type { DashboardApiClient } from '../api-client.js';
/** Input schema for send_message tool. */
export declare const SendMessageInputSchema: z.ZodObject<{
    goal_id: z.ZodString;
    prompt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    goal_id: string;
    prompt: string;
}, {
    goal_id: string;
    prompt: string;
}>;
export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;
/**
 * Send a follow-up message to an existing goal's active session.
 * Returns the session_id of the session that received the message.
 */
export declare function sendMessage(client: DashboardApiClient, input: SendMessageInput): Promise<string>;
