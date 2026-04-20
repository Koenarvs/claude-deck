import type { GoalStatus } from '../../src/shared/types';

/**
 * Allowed state transitions for goal status.
 *
 * State machine diagram:
 * ```
 * planning ──[sendMessage]──> active
 *    └──────[archive]────────> archived
 * active   ──[wait/done]────> waiting | complete
 * waiting  ──[sendMessage]──> active
 * complete ──[reopen]───────> active
 * any (except archived) ───> archived
 * ```
 */
const ALLOWED_TRANSITIONS: Record<GoalStatus, ReadonlySet<GoalStatus>> = {
  planning: new Set<GoalStatus>(['active', 'complete', 'archived']),
  active: new Set<GoalStatus>(['planning', 'waiting', 'complete', 'archived']),
  waiting: new Set<GoalStatus>(['planning', 'active', 'complete', 'archived']),
  complete: new Set<GoalStatus>(['active', 'archived']),
  archived: new Set<GoalStatus>([]),
};

/**
 * Checks whether a goal status transition from `from` to `to` is allowed
 * by the state machine. `archived` is a terminal state — no transitions
 * out of it are permitted.
 *
 * @param from - The current goal status
 * @param to - The desired goal status
 * @returns true if the transition is valid
 */
export function canTransition(from: GoalStatus, to: GoalStatus): boolean {
  if (from === to) return false;
  const allowed = ALLOWED_TRANSITIONS[from];
  return allowed.has(to);
}

/**
 * Returns the set of statuses reachable from the given status.
 *
 * @param from - The current goal status
 * @returns Array of valid target statuses
 */
export function allowedTransitions(from: GoalStatus): GoalStatus[] {
  return [...ALLOWED_TRANSITIONS[from]];
}
