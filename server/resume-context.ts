import type { SpawnContext } from '../src/shared/agents/types';
import type { Orphan } from './services/reconciliation-service';

/**
 * Builds the SpawnContext needed to resume an orphaned session (5D). Prefers the
 * isolated workspace path as cwd (so the resumed PTY lands back in its worktree),
 * falling back to the goal cwd. mcpServer is rebuilt by the spawn site.
 */
export function buildResumeContext(orphan: Orphan): SpawnContext {
  return {
    goalId: orphan.goalId,
    model: orphan.model ?? 'default',
    cwd: orphan.workspacePath ?? orphan.cwd,
    permissionMode: orphan.permissionMode,
    mcpServer: null,
  };
}
