import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeMigratedDb } from '../helpers/db-fixture';
import { createReconciliationService } from '../../../server/services/reconciliation-service';
import type Database from 'better-sqlite3';

vi.mock('../../../server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let db: Database.Database;
beforeEach(() => {
  db = makeMigratedDb();
});
afterEach(() => db.close());

function seedActiveGoalWithOpenSession(goalId: string) {
  db.prepare(
    `INSERT INTO goals (id,title,cwd,status,priority,permission_mode,kanban_order,created_at,updated_at)
     VALUES (?,?,'C:/repo','active',0,'supervised',0,1,1)`,
  ).run(goalId, goalId);
  db.prepare(
    `INSERT INTO sessions (id,goal_id,origin,started_at,ended_at,provider_session_id,workspace_path,stream_event_count,hook_event_count,stderr_bytes)
     VALUES (?,?,'dashboard',1,NULL,?,'C:/wt/x',0,0,0)`,
  ).run(goalId, goalId, goalId);
}

describe('ReconciliationService.findOrphans (5D)', () => {
  it('lists orphans: open sessions on active goals with no live process', () => {
    seedActiveGoalWithOpenSession('g1');
    seedActiveGoalWithOpenSession('g2');
    const isLive = (goalId: string) => goalId === 'g2'; // g2 still has a process
    const svc = createReconciliationService(db);
    const orphans = svc.findOrphans(isLive);
    expect(orphans.map((o) => o.goalId)).toEqual(['g1']);
    expect(orphans[0]!.providerSessionId).toBe('g1');
    expect(orphans[0]!.workspacePath).toBe('C:/wt/x');
  });

  it('ignores completed goals and ended sessions', () => {
    db.prepare(
      `INSERT INTO goals (id,title,cwd,status,priority,permission_mode,kanban_order,created_at,updated_at,completed_at)
       VALUES ('done','T','C:/repo','complete',0,'supervised',0,1,1,1)`,
    ).run();
    db.prepare(
      `INSERT INTO sessions (id,goal_id,origin,started_at,ended_at,stream_event_count,hook_event_count,stderr_bytes)
       VALUES ('done','done','dashboard',1,2,0,0,0)`,
    ).run();
    const svc = createReconciliationService(db);
    expect(svc.findOrphans(() => false)).toEqual([]);
  });
});
