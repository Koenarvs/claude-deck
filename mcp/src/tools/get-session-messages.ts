import { z } from 'zod';
import type { DashboardApiClient } from '../api-client.js';

/** Input schema for get_session_messages tool. */
export const GetSessionMessagesInputSchema = z.object({
  session_id: z.string().describe('Session ID to fetch messages for'),
});

export type GetSessionMessagesInput = z.infer<typeof GetSessionMessagesInputSchema>;

/**
 * Get all messages for a specific session.
 * Returns Message[] from the dashboard API.
 */
export async function getSessionMessages(
  client: DashboardApiClient,
  input: GetSessionMessagesInput,
): Promise<string> {
  const messages = await client.getSessionMessages(input.session_id);
  return JSON.stringify(messages, null, 2);
}
