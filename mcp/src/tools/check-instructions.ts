import { z } from 'zod';
import type { DashboardApiClient } from '../api-client.js';

export const CheckInstructionsInputSchema = z.object({
  goal_id: z
    .string()
    .optional()
    .describe(
      'Goal ID to check instructions for. Defaults to this session\'s goal (CLAUDE_DECK_GOAL_ID).',
    ),
});

export type CheckInstructionsInput = z.infer<typeof CheckInstructionsInputSchema>;

/**
 * Check for pending inter-goal instructions sent to this goal.
 * Retrieves all pending/delivered messages and marks pending ones as delivered.
 */
export async function checkInstructions(
  client: DashboardApiClient,
  input: CheckInstructionsInput,
): Promise<string> {
  const goalId = input.goal_id ?? process.env['CLAUDE_DECK_GOAL_ID'];

  if (!goalId) {
    return JSON.stringify(
      {
        error:
          'goal_id is required. Pass it explicitly or ensure CLAUDE_DECK_GOAL_ID is set.',
      },
      null,
      2,
    );
  }

  const instructions = await client.getInstructions(goalId);

  if (instructions.length === 0) {
    return JSON.stringify({ message: 'No pending instructions.', instructions: [] }, null, 2);
  }

  for (const msg of instructions) {
    if (msg.status === 'pending') {
      try {
        await client.markDelivered(goalId, msg.id);
      } catch {
        // Best-effort — message content is still returned
      }
    }
  }

  return JSON.stringify(
    {
      message: `${instructions.length} instruction(s) retrieved.`,
      instructions: instructions.map((m) => ({
        id: m.id,
        from_goal_id: m.from_goal_id,
        content: m.content,
        message_type: m.message_type,
        status: m.status,
        created_at: m.created_at,
      })),
    },
    null,
    2,
  );
}
