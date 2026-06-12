import type Database from 'better-sqlite3';
import {
  OrchestratorConfigSchema,
  DEFAULT_ORCHESTRATOR_CONFIG,
  type OrchestratorConfig,
  type OrchestratorStateRecord,
  type OrchestratorStatus,
  type UpdateOrchestratorConfig,
} from '../../src/shared/orchestrator';

interface StateRow {
  id: number;
  status: OrchestratorStatus;
  last_wake_at: number | null;
  last_active_at: number | null;
  config_json: string;
  updated_at: number;
}

/**
 * CRUD for the orchestrator's single-row lifecycle + config state. The
 * `orchestrator_state` table always has exactly one row (id = 1), seeded by migration.
 */
export class OrchestratorStateService {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** Reads the singleton state, parsing + defaulting the embedded config. */
  get(): OrchestratorStateRecord {
    const row = this.db.prepare('SELECT * FROM orchestrator_state WHERE id = 1').get() as
      | StateRow
      | undefined;
    if (!row) {
      return {
        status: 'idle',
        last_wake_at: null,
        last_active_at: null,
        config: DEFAULT_ORCHESTRATOR_CONFIG,
      };
    }
    const config = OrchestratorConfigSchema.parse({
      ...DEFAULT_ORCHESTRATOR_CONFIG,
      ...(JSON.parse(row.config_json) as Record<string, unknown>),
    });
    return {
      status: row.status,
      last_wake_at: row.last_wake_at,
      last_active_at: row.last_active_at,
      config,
    };
  }

  /** Persists a lifecycle status transition. Stamps last_wake_at/last_active_at appropriately. */
  setStatus(status: OrchestratorStatus, now: number): void {
    if (status === 'waking') {
      this.db
        .prepare('UPDATE orchestrator_state SET status = ?, last_wake_at = ?, updated_at = ? WHERE id = 1')
        .run(status, now, now);
    } else if (status === 'active') {
      this.db
        .prepare('UPDATE orchestrator_state SET status = ?, last_active_at = ?, updated_at = ? WHERE id = 1')
        .run(status, now, now);
    } else {
      this.db
        .prepare('UPDATE orchestrator_state SET status = ?, updated_at = ? WHERE id = 1')
        .run(status, now);
    }
  }

  /** Merges a partial config over the current one, validates, and persists. Returns the new config. */
  updateConfig(partial: UpdateOrchestratorConfig): OrchestratorConfig {
    const current = this.get().config;
    const merged = OrchestratorConfigSchema.parse({ ...current, ...partial });
    this.db
      .prepare('UPDATE orchestrator_state SET config_json = ?, updated_at = ? WHERE id = 1')
      .run(JSON.stringify(merged), Date.now());
    return merged;
  }
}
