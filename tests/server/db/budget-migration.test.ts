import { describe, it, expect, afterEach } from 'vitest';
import { makeMigratedDb } from '../helpers/db-fixture';
import type Database from 'better-sqlite3';

let db: Database.Database;
afterEach(() => db?.close());

describe('migration 024 budget_state', () => {
  it('creates budget_state with the expected columns', () => {
    db = makeMigratedDb();
    const cols = (db.pragma('table_info(budget_state)') as Array<{ name: string }>).map((c) => c.name);
    for (const c of ['key', 'value_json', 'updated_at']) expect(cols).toContain(c);
  });

  it('seeds the kill_switch row as off', () => {
    db = makeMigratedDb();
    const row = db
      .prepare("SELECT value_json FROM budget_state WHERE key = 'kill_switch'")
      .get() as { value_json: string } | undefined;
    expect(row).toBeDefined();
    expect(JSON.parse(row!.value_json)).toEqual({ active: false });
  });
});
