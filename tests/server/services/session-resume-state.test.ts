import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeMigratedDb } from '../helpers/db-fixture';
import { SessionService } from '../../../server/services/session-service';
import type Database from 'better-sqlite3';

vi.mock('../../../server/ws', () => ({ broadcast: vi.fn() }));
vi.mock('../../../server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let db: Database.Database;
beforeEach(() => {
  db = makeMigratedDb();
});
afterEach(() => db.close());

describe('SessionService.recordResumeState (5D)', () => {
  it('records provider_session_id + workspace_path for resume', () => {
    db.prepare(
      `INSERT INTO goals (id,title,cwd,status,priority,permission_mode,kanban_order,created_at,updated_at)
       VALUES ('g1','T','C:/repo','active',0,'supervised',0,1,1)`,
    ).run();
    db.prepare(
      `INSERT INTO sessions (id,goal_id,origin,started_at,stream_event_count,hook_event_count,stderr_bytes)
       VALUES ('g1','g1','dashboard',1,0,0,0)`,
    ).run();

    const svc = new SessionService(db, vi.fn());
    svc.recordResumeState('g1', { providerSessionId: 'g1', workspacePath: 'C:/wt/g1' });

    const row = db
      .prepare('SELECT provider_session_id, workspace_path FROM sessions WHERE id = ?')
      .get('g1') as { provider_session_id: string; workspace_path: string };
    expect(row.provider_session_id).toBe('g1');
    expect(row.workspace_path).toBe('C:/wt/g1');
  });
});
