import { describe, it, expect, afterEach } from 'vitest';
import { makeMigratedDb } from '../helpers/db-fixture';
import type Database from 'better-sqlite3';

let db: Database.Database;
afterEach(() => db?.close());

describe('migration 023 verification_results', () => {
  it('creates the verification_results table with the expected columns', () => {
    db = makeMigratedDb();
    const cols = (db.pragma('table_info(verification_results)') as Array<{ name: string }>).map(
      (c) => c.name,
    );
    for (const c of [
      'id',
      'goal_id',
      'session_id',
      'status',
      'command',
      'workspace',
      'exit_code',
      'output',
      'duration_ms',
      'model',
      'created_at',
    ]) {
      expect(cols).toContain(c);
    }
  });

  it('enforces the status check constraint', () => {
    db = makeMigratedDb();
    const ins = db.prepare(
      `INSERT INTO verification_results (id, goal_id, status, created_at) VALUES (?, ?, ?, ?)`,
    );
    expect(() => ins.run('v1', 'g1', 'bogus', 0)).toThrow();
    expect(() => ins.run('v2', 'g1', 'pass', 0)).not.toThrow();
  });
});
