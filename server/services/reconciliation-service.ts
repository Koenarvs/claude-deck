import type Database from 'better-sqlite3';
import logger from '../logger';

export interface Orphan {
  goalId: string;
  sessionId: string;
  providerSessionId: string | null;
  workspacePath: string | null;
  model: string | null;
  cwd: string;
  permissionMode: 'autonomous' | 'supervised';
}

interface OrphanRow {
  goal_id: string;
  session_id: string;
  provider_session_id: string | null;
  workspace_path: string | null;
  model: string | null;
  cwd: string;
  permission_mode: string;
}

/**
 * Detects sessions the DB thinks are active but which have no live OS process —
 * the candidates for resume-on-boot (5D). Pure: the liveness check is injected.
 */
export function createReconciliationService(db: Database.Database) {
  const stmt = db.prepare<[], OrphanRow>(`
    SELECT s.goal_id AS goal_id, s.id AS session_id, s.provider_session_id AS provider_session_id,
           s.workspace_path AS workspace_path, g.model AS model, g.cwd AS cwd, g.permission_mode AS permission_mode
    FROM sessions s
    JOIN goals g ON s.goal_id = g.id
    WHERE s.ended_at IS NULL
      AND g.status IN ('active', 'waiting')
  `);

  /** Returns orphans for which isLive(goalId) is false. */
  function findOrphans(isLive: (goalId: string) => boolean): Orphan[] {
    const orphans = stmt
      .all()
      .filter((r) => !isLive(r.goal_id))
      .map<Orphan>((r) => ({
        goalId: r.goal_id,
        sessionId: r.session_id,
        providerSessionId: r.provider_session_id,
        workspacePath: r.workspace_path,
        model: r.model,
        cwd: r.cwd,
        permissionMode: r.permission_mode === 'autonomous' ? 'autonomous' : 'supervised',
      }));
    logger.info({ count: orphans.length }, 'reconciliation: orphaned sessions detected');
    return orphans;
  }

  return { findOrphans };
}

export type ReconciliationService = ReturnType<typeof createReconciliationService>;
