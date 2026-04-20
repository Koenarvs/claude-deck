import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = path.resolve(__dirname, '../../../server/db/migrations/001_init.sql');

function applyMigration(db: Database.Database): void {
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf-8');
  db.exec(sql);
}

function getTableNames(db: Database.Database): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name).sort();
}

describe('001_init migration', () => {
  it('creates all expected tables', () => {
    const db = new Database(':memory:');
    applyMigration(db);

    const tables = getTableNames(db);
    expect(tables).toContain('goals');
    expect(tables).toContain('sessions');
    expect(tables).toContain('messages');
    expect(tables).toContain('hook_events');
    expect(tables).toContain('approvals');
    expect(tables).toContain('scheduled_tasks');
    expect(tables).toContain('schema_migrations');

    db.close();
  });

  it('is idempotent — running twice does not error and version is still 1', () => {
    const db = new Database(':memory:');
    applyMigration(db);
    applyMigration(db);

    const rows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{
      version: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe(1);

    db.close();
  });

  it('CHECK constraint rejects invalid goal status', () => {
    const db = new Database(':memory:');
    applyMigration(db);

    expect(() => {
      db.prepare(
        `INSERT INTO goals (id, title, cwd, status, permission_mode, kanban_order, created_at, updated_at)
         VALUES ('g1', 'Test', '/tmp', 'invalid_status', 'supervised', 1.0, 1700000000000, 1700000000000)`,
      ).run();
    }).toThrow();

    db.close();
  });

  it('CHECK constraint rejects invalid session origin', () => {
    const db = new Database(':memory:');
    applyMigration(db);

    expect(() => {
      db.prepare(
        `INSERT INTO sessions (id, origin)
         VALUES ('s1', 'manual')`,
      ).run();
    }).toThrow();

    db.close();
  });

  it('CHECK constraint rejects invalid approval status', () => {
    const db = new Database(':memory:');
    applyMigration(db);

    expect(() => {
      db.prepare(
        `INSERT INTO approvals (id, status)
         VALUES ('a1', 'rejected')`,
      ).run();
    }).toThrow();

    db.close();
  });

  it('allows valid goal insertion', () => {
    const db = new Database(':memory:');
    applyMigration(db);

    db.prepare(
      `INSERT INTO goals (id, title, cwd, status, permission_mode, kanban_order, created_at, updated_at)
       VALUES ('g1', 'Valid Goal', '/home/user', 'planning', 'supervised', 1.0, 1700000000000, 1700000000000)`,
    ).run();

    const row = db.prepare('SELECT * FROM goals WHERE id = ?').get('g1') as { title: string };
    expect(row.title).toBe('Valid Goal');

    db.close();
  });
});
