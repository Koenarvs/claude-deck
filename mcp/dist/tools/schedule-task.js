import { z } from 'zod';
/** Schema for the goal template embedded in a scheduled task. */
const GoalTemplateInputSchema = z.object({
    title: z.string().min(1).describe('Goal title template'),
    cwd: z.string().min(1).describe('Working directory (absolute path)'),
    model: z
        .enum(['opus', 'sonnet', 'haiku', 'default'])
        .optional()
        .describe('Claude model to use'),
    initialPrompt: z
        .string()
        .optional()
        .describe('Initial prompt to send when the task fires'),
    tags: z
        .array(z.string())
        .optional()
        .describe('Tags for the created goal'),
});
/** Input schema for schedule_task tool. */
export const ScheduleTaskInputSchema = z.object({
    name: z.string().min(1).describe('Human-readable task name'),
    cron_expr: z.string().min(1).describe('Cron expression (e.g., "0 9 * * 1-5" for weekdays at 9 AM)'),
    goal_template: GoalTemplateInputSchema.describe('Template for the goal created on each run'),
});
/**
 * Create a scheduled task that will create goals on a cron schedule.
 * Returns the created ScheduledTask from the dashboard API.
 */
export async function scheduleTask(client, input) {
    const tmpl = { title: input.goal_template.title, cwd: input.goal_template.cwd };
    if (input.goal_template.model !== undefined)
        tmpl.model = input.goal_template.model;
    if (input.goal_template.initialPrompt !== undefined)
        tmpl.initialPrompt = input.goal_template.initialPrompt;
    if (input.goal_template.tags !== undefined)
        tmpl.tags = input.goal_template.tags;
    const task = await client.createScheduledTask({
        name: input.name,
        cron_expr: input.cron_expr,
        goal_template: tmpl,
    });
    return JSON.stringify(task, null, 2);
}
