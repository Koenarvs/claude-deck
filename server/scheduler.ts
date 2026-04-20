import cron from 'node-cron';
import type { ScheduledTask, CreateGoalInput } from '../src/shared/types';
import type { ScheduledTaskService } from './services/scheduled-task-service';
import logger from './logger';

/**
 * Callback type for goal creation. The scheduler calls this when a cron fires
 * or when `runNow` is invoked. The caller (typically the route layer or
 * integration wiring) provides an implementation that delegates to the goal service.
 */
export type GoalCreator = (input: CreateGoalInput) => { id: string };

/** Internal record for a registered cron job. */
interface RegisteredJob {
  taskId: string;
  job: ReturnType<typeof cron.schedule>;
}

/**
 * Cron-based scheduler that fires goal creation from scheduled task templates.
 *
 * Lifecycle:
 * - `start()` loads all enabled tasks from the DB and registers cron jobs.
 * - `stop()` destroys all registered jobs.
 * - `refresh(id)` re-registers a single task (call after create/update/delete).
 * - `runNow(id)` fires a task immediately, bypassing the cron schedule.
 */
export class Scheduler {
  private readonly taskService: ScheduledTaskService;
  private readonly createGoal: GoalCreator;
  private readonly jobs: Map<string, RegisteredJob> = new Map();

  constructor(taskService: ScheduledTaskService, createGoal: GoalCreator) {
    this.taskService = taskService;
    this.createGoal = createGoal;
  }

  /**
   * Loads all enabled scheduled tasks from the database and registers
   * their cron jobs. Safe to call multiple times (idempotent after stop).
   */
  start(): void {
    const tasks = this.taskService.list();
    for (const task of tasks) {
      if (task.enabled) {
        this.register(task);
      }
    }
    logger.info({ count: this.jobs.size }, 'Scheduler started');
  }

  /**
   * Stops and destroys all registered cron jobs.
   * Does not modify the database.
   */
  stop(): void {
    for (const [, entry] of this.jobs) {
      entry.job.stop();
    }
    this.jobs.clear();
    logger.info('Scheduler stopped');
  }

  /**
   * Re-registers a single task by ID. Called after create, update, or delete
   * to synchronize the in-memory cron registry with the database state.
   *
   * - If the task exists and is enabled, (re)registers its cron job.
   * - If the task exists but is disabled, removes its cron job.
   * - If the task no longer exists, removes its cron job.
   */
  refresh(id: string): void {
    // Remove existing job if any
    const existing = this.jobs.get(id);
    if (existing) {
      existing.job.stop();
      this.jobs.delete(id);
    }

    // Re-read from DB
    const task = this.taskService.get(id);
    if (task && task.enabled) {
      this.register(task);
    }

    logger.debug({ taskId: id, registered: this.jobs.has(id) }, 'Scheduler refreshed task');
  }

  /**
   * Fires a scheduled task immediately, creating a goal from its template.
   * Updates `last_run_at` on the task. Does not affect the cron schedule.
   *
   * @returns The ID of the created goal.
   * @throws If the task does not exist.
   */
  runNow(id: string): { goal_id: string } {
    const task = this.taskService.get(id);
    if (!task) {
      throw new Error(`Scheduled task not found: ${id}`);
    }

    const goalId = this.fireTask(task);
    return { goal_id: goalId };
  }

  /** Returns the number of currently registered cron jobs. */
  get registeredCount(): number {
    return this.jobs.size;
  }

  /** Returns whether a specific task has a registered cron job. */
  isRegistered(id: string): boolean {
    return this.jobs.has(id);
  }

  /**
   * Registers a cron job for a scheduled task. The job calls `fireTask`
   * on each cron tick.
   */
  private register(task: ScheduledTask): void {
    const job = cron.schedule(task.cron_expr, () => {
      try {
        this.fireTask(task);
      } catch (err) {
        logger.error(
          { taskId: task.id, err: err instanceof Error ? err.message : String(err) },
          'Scheduled task fire failed',
        );
      }
    });

    this.jobs.set(task.id, { taskId: task.id, job });
  }

  /**
   * Creates a goal from a scheduled task's template and records the run.
   * Appends a timestamp to the goal title to avoid duplicate-title confusion.
   *
   * @returns The ID of the created goal.
   */
  private fireTask(task: ScheduledTask): string {
    const template = this.taskService.parseTemplate(task);
    const now = Date.now();
    const timestamp = new Date(now).toISOString();

    const goalInput: CreateGoalInput = {
      title: `${template.title} (${timestamp})`,
      cwd: template.cwd,
      model: template.model,
      initialPrompt: template.initialPrompt,
      tags: template.tags,
    };

    const goal = this.createGoal(goalInput);

    this.taskService.recordRun(task.id, now, null);

    logger.info(
      { taskId: task.id, goalId: goal.id, title: goalInput.title },
      'Scheduled task fired — goal created',
    );

    return goal.id;
  }
}
