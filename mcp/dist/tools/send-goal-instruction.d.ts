import { z } from 'zod';
import type { DashboardApiClient } from '../api-client.js';
/** Input schema for send_goal_instruction tool. */
export declare const SendGoalInstructionInputSchema: z.ZodObject<{
    target_goal_id: z.ZodString;
    content: z.ZodString;
    message_type: z.ZodDefault<z.ZodOptional<z.ZodEnum<["instruction", "result", "status_update", "context"]>>>;
    from_goal_id: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    content: string;
    message_type: "instruction" | "result" | "status_update" | "context";
    target_goal_id: string;
    from_goal_id?: string | undefined;
}, {
    content: string;
    target_goal_id: string;
    from_goal_id?: string | undefined;
    message_type?: "instruction" | "result" | "status_update" | "context" | undefined;
}>;
export type SendGoalInstructionInput = z.infer<typeof SendGoalInstructionInputSchema>;
/**
 * Send an instruction or result to another goal.
 * Use this to delegate work to other goals or report results back to a control goal.
 * Returns the created inter-goal message from the dashboard API.
 */
export declare function sendGoalInstruction(client: DashboardApiClient, input: SendGoalInstructionInput): Promise<string>;
