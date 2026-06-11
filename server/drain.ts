import logger from './logger';

/**
 * Graceful-drain step (5D): persists resume state for every live goal before
 * the process registry kills the PTYs. Pure — the persist action is injected
 * (it writes provider_session_id + workspace_path and marks the goal 'waiting').
 */
export function drainSessions(liveGoalIds: string[], persist: (goalId: string) => void): void {
  logger.info({ count: liveGoalIds.length }, 'drain: persisting resume state before shutdown');
  for (const goalId of liveGoalIds) {
    try {
      persist(goalId);
    } catch (err) {
      logger.error({ err, goalId }, 'drain: failed to persist resume state');
    }
  }
}
