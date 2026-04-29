import { z } from 'zod';
import type { DashboardApiClient } from '../api-client.js';
/** Input schema for get_session_messages tool. */
export declare const GetSessionMessagesInputSchema: z.ZodObject<{
    session_id: z.ZodString;
}, "strip", z.ZodTypeAny, {
    session_id: string;
}, {
    session_id: string;
}>;
export type GetSessionMessagesInput = z.infer<typeof GetSessionMessagesInputSchema>;
/**
 * Get all messages for a specific session.
 * Returns Message[] from the dashboard API.
 */
export declare function getSessionMessages(client: DashboardApiClient, input: GetSessionMessagesInput): Promise<string>;
