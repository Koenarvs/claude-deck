import { z } from 'zod';
import type { DashboardApiClient } from '../api-client.js';
/** Input schema for schedule_task tool. */
export declare const ScheduleTaskInputSchema: z.ZodObject<{
    name: z.ZodString;
    cron_expr: z.ZodString;
    goal_template: z.ZodObject<{
        title: z.ZodString;
        cwd: z.ZodString;
        model: z.ZodOptional<z.ZodEnum<["opus", "sonnet", "haiku", "default"]>>;
        initialPrompt: z.ZodOptional<z.ZodString>;
        tags: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        title: string;
        cwd: string;
        tags?: string[] | undefined;
        model?: "opus" | "sonnet" | "haiku" | "default" | undefined;
        initialPrompt?: string | undefined;
    }, {
        title: string;
        cwd: string;
        tags?: string[] | undefined;
        model?: "opus" | "sonnet" | "haiku" | "default" | undefined;
        initialPrompt?: string | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    name: string;
    cron_expr: string;
    goal_template: {
        title: string;
        cwd: string;
        tags?: string[] | undefined;
        model?: "opus" | "sonnet" | "haiku" | "default" | undefined;
        initialPrompt?: string | undefined;
    };
}, {
    name: string;
    cron_expr: string;
    goal_template: {
        title: string;
        cwd: string;
        tags?: string[] | undefined;
        model?: "opus" | "sonnet" | "haiku" | "default" | undefined;
        initialPrompt?: string | undefined;
    };
}>;
export type ScheduleTaskInput = z.infer<typeof ScheduleTaskInputSchema>;
/**
 * Create a scheduled task that will create goals on a cron schedule.
 * Returns the created ScheduledTask from the dashboard API.
 */
export declare function scheduleTask(client: DashboardApiClient, input: ScheduleTaskInput): Promise<string>;
