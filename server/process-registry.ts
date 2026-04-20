import logger from './logger';

/** Interface for objects managed by the ProcessRegistry. Must support cleanup/kill. */
export interface Killable {
  /** Interrupts and cleans up the managed subprocess. */
  interrupt(): Promise<void>;
  /** Performs final cleanup (close trace files, etc.). */
  cleanup(): Promise<void>;
}

/**
 * Singleton registry mapping goal IDs to their active SessionRunner instances.
 *
 * Enforces a one-subprocess-per-goal constraint. On server shutdown,
 * `killAll()` terminates every registered subprocess.
 */
class ProcessRegistry {
  private readonly runners: Map<string, Killable> = new Map();

  /** Returns the runner for the given goal ID, or undefined if none is registered. */
  get(goalId: string): Killable | undefined {
    return this.runners.get(goalId);
  }

  /** Registers a runner for the given goal ID. Does NOT kill any existing runner -- caller must handle that. */
  set(goalId: string, runner: Killable): void {
    this.runners.set(goalId, runner);
    logger.debug({ goalId }, 'ProcessRegistry: runner registered');
  }

  /** Removes a runner from the registry without killing it. */
  remove(goalId: string): boolean {
    const removed = this.runners.delete(goalId);
    if (removed) {
      logger.debug({ goalId }, 'ProcessRegistry: runner removed');
    }
    return removed;
  }

  /** Returns true if a runner is registered for the given goal ID. */
  has(goalId: string): boolean {
    return this.runners.has(goalId);
  }

  /** Returns the number of registered runners. */
  get size(): number {
    return this.runners.size;
  }

  /**
   * Kills all registered subprocesses and clears the registry.
   *
   * Called during server shutdown (SIGTERM/SIGINT). Each runner's
   * `interrupt()` and `cleanup()` are called. Errors are logged
   * but do not prevent other runners from being cleaned up.
   */
  async killAll(): Promise<void> {
    const goalIds = Array.from(this.runners.keys());
    logger.info({ count: goalIds.length }, 'ProcessRegistry: killing all runners');

    const results = await Promise.allSettled(
      goalIds.map(async (goalId) => {
        const runner = this.runners.get(goalId);
        if (!runner) return;

        try {
          await runner.interrupt();
          await runner.cleanup();
        } catch (err) {
          logger.error({ goalId, err }, 'ProcessRegistry: error killing runner');
        }
      }),
    );

    // Log any settled rejections (shouldn't happen since we catch above, but defensive)
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result && result.status === 'rejected') {
        logger.error(
          { goalId: goalIds[i], reason: result.reason },
          'ProcessRegistry: unexpected rejection during killAll',
        );
      }
    }

    this.runners.clear();
    logger.info('ProcessRegistry: all runners cleared');
  }
}

/** Singleton process registry instance. */
export const processRegistry = new ProcessRegistry();
