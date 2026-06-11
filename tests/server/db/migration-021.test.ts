import { describe, it, expect, afterEach } from 'vitest';
import { makeMigratedDb } from '../helpers/db-fixture';
import type Database from 'better-sqlite3';

let db: Database.Database;
afterEach(() => db?.close());

describe('migration 021 — projects', () => {
  it('creates projects table with expected columns', () => {
    db = makeMigratedDb();
    const cols = (db.pragma('table_info(projects)') as Array<{ name: string }>).map((c) => c.name);
    for (const c of [
      'id',
      'name',
      'root_path',
      'allowed_models',
      'default_permission_mode',
      'done_command',
      'worktree_root',
      'created_at',
      'updated_at',
    ]) {
      expect(cols).toContain(c);
    }
  });

  it('adds project_id to goals', () => {
    db = makeMigratedDb();
    const cols = (db.pragma('table_info(goals)') as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('project_id');
  });

  it('enforces unique root_path', () => {
    db = makeMigratedDb();
    const ins = db.prepare(
      `INSERT INTO projects (id,name,root_path,allowed_models,default_permission_mode,done_command,worktree_root,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    ins.run('p1', 'A', 'C:/repo', '[]', 'supervised', null, null, 1, 1);
    expect(() => ins.run('p2', 'B', 'C:/repo', '[]', 'supervised', null, null, 1, 1)).toThrow();
  });
});
