import { z } from 'zod';
import type { DashboardApiClient } from '../api-client.js';

/** Input schema for send_goal_instruction tool. */
export const SendGoalInstructionInputSchema = z.object({
  target_goal_id: z.string().min(1).describe('ID of the goal to send the instruction to'),
  content: z.string().min(1).describe('The instruction or message content'),
  message_type: z
    .enum(['instruction', 'result', 'status_update', 'context'])
    .optional()
    .default('instruction')
    .describe('Type of inter-goal message (default: instruction)'),
  from_goal_id: z
    .string()
    .optional()
    .describe(
      'ID of the sending goal. If omitted, infer from the current session\'s goal_id.',
    ),
});

export type SendGoalInstructionInput = z.infer<typeof SendGoalInstructionInputSchema>;

/**
 * Send an instruction or result to another goal.
 * Use this to delegate work to other goals or report results back to a control goal.
 * Returns the created inter-goal message from the dashboard API.
 */
export async function sendGoalInstruction(
  client: DashboardApiClient,
  input: SendGoalInstructionInput,
): Promise<string> {
  const fromGoalId = input.from_goal_id;

  if (!fromGoalId) {
    return JSON.stringify(
      {
        error: 'from_goal_id is required. Pass the current goal ID or set it explicitly.',
      },
      null,
      2,
    );
  }

  const message = await client.sendGoalInstruction(
    fromGoalId,
    input.target_goal_id,
    {
      content: input.content,
      message_type: input.message_type ?? 'instruction',
    },
  );

  return JSON.stringify(message, null, 2);
}
