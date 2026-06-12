import { describe, it, expect, afterEach } from 'vitest';
import { makeMigratedDb } from '../helpers/db-fixture';
import { buildSnapshot } from '../../../server/orchestrator/snapshot';
import type Database from 'better-sqlite3';

let db: Database.Database;
afterEach(() => db?.close());

function seed(d: Database.Database) {
  const now = Date.now();
  const insGoal = d.prepare(
    `INSERT INTO goals (id, title, cwd, status, priority, permission_mode, kanban_order, created_at, updated_at)
     VALUES (?, ?, '/r', ?, 0, 'supervised', 1, ?, ?)`,
  );
  insGoal.run('g1', 'Build feature', 'active', now, now);
  insGoal.run('g2', 'Old done', 'complete', now, now);
  d.prepare(
    `INSERT INTO sessions (id, goal_id, origin, started_at, stream_event_count, hook_event_count, stderr_bytes)
     VALUES ('s1', 'g1', 'dashboard', ?, 0, 0, 0)`,
  ).run(now);
  d.prepare(
    `INSERT INTO approvals (id, session_id, goal_id, tool_name, tool_args, status, requested_at)
     VALUES ('a1', 's1', 'g1', 'Bash', '{}', 'pending', ?)`,
  ).run(now);
}

describe('buildSnapshot', () => {
  it('summarizes active goals, live sessions, and pending approvals', () => {
    db = makeMigratedDb();
    seed(db);
    const snap = buildSnapshot(db);
    expect(snap.activeGoals.find((g) => g.id === 'g1')).toBeTruthy();
    expect(snap.activeGoals.find((g) => g.id === 'g2')).toBeFalsy(); // complete is excluded
    expect(snap.liveSessions.map((s) => s.id)).toContain('s1');
    expect(snap.pendingApprovals[0]?.tool_name).toBe('Bash');
  });

  it('renders to a compact markdown block for the prompt', () => {
    db = makeMigratedDb();
    seed(db);
    const md = buildSnapshot(db).toMarkdown();
    expect(md).toContain('Build feature');
    expect(md).toContain('Pending approvals');
  });
});
