import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/db/migrate';
import { HookIngest } from '../../server/hook-ingest';
import { ApprovalCoordinator } from '../../server/approval-coordinator';

type SessionStartArg = Parameters<HookIngest['onSessionStart']>[0];

describe('HookIngest trace_dir', () => {
  let db: Database.Database;
  let coordinator: ApprovalCoordinator;
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys=ON');
    runMigrations(db);
    coordinator = new ApprovalCoordinator(db);
  });
  afterEach(() => { coordinator.shutdown(); db.close(); });

  it('populates trace_dir under the configured traces root when set', () => {
    const ingest = new HookIngest(db, coordinator, undefined, '/data/traces');
    ingest.onSessionStart({ session_id: 'ts-1', cwd: '/x' } as SessionStartArg);
    const row = db.prepare(`SELECT trace_dir FROM sessions WHERE id='ts-1'`).get() as { trace_dir: string };
    expect(row.trace_dir).toBe(path.join('/data/traces', 'ts-1'));
  });

  it('leaves trace_dir NULL when no traces root is configured (back-compat)', () => {
    const ingest = new HookIngest(db, coordinator);
    ingest.onSessionStart({ session_id: 'ts-2', cwd: '/x' } as SessionStartArg);
    const row = db.prepare(`SELECT trace_dir FROM sessions WHERE id='ts-2'`).get() as { trace_dir: string | null };
    expect(row.trace_dir).toBeNull();
  });
});
