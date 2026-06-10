import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/db/migrate';
import { resolveApprovalPosture } from '../../server/approval-policy';

function db(): Database.Database {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  runMigrations(d);
  return d;
}

describe('resolveApprovalPosture', () => {
  let d: Database.Database;
  beforeEach(() => {
    d = db();
  });
  afterEach(() => {
    d.close();
  });

  function makeGoal(id: string, mode: 'supervised' | 'autonomous', model = 'opus') {
    d.prepare(
      `INSERT INTO goals (id, title, cwd, status, priority, permission_mode, model, kanban_order, created_at, updated_at)
       VALUES (?, ?, '/tmp', 'active', 0, ?, ?, 0, 0, 0)`,
    ).run(id, 'g-' + id, mode, model);
  }

  it('supervised + canApprove provider => block', () => {
    makeGoal('g1', 'supervised');
    expect(resolveApprovalPosture(d, 'g1')).toBe('block');
  });

  it('autonomous => pass-through (auto-allow) even if provider can approve', () => {
    makeGoal('g2', 'autonomous');
    expect(resolveApprovalPosture(d, 'g2')).toBe('pass-through');
  });

  it('null goal (unlinked session) => pass-through', () => {
    expect(resolveApprovalPosture(d, null)).toBe('pass-through');
  });

  it('provider lacking canApprove => pass-through, regardless of mode', () => {
    // A non-Claude model id resolves to a provider with canApprove:false until the
    // Phase-1 catalog lands; the prefix heuristic treats gpt-* as non-approving.
    makeGoal('g3', 'supervised', 'gpt-5.5');
    expect(resolveApprovalPosture(d, 'g3')).toBe('pass-through');
  });
});
