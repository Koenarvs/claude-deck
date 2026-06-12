import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../../../server/db/migrate';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../server/db/migrations');

/** Every migration file's leading version number. */
function fileVersions(): number[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => f.match(/^(\d+)/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => parseInt(m[1], 10))
    .sort((a, b) => a - b);
}

function recordedVersions(db: Database.Database): number[] {
  return (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{
    version: number;
  }>).map((r) => r.version);
}

describe('runMigrations version recording', () => {
  it('records every migration file version in schema_migrations', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(recordedVersions(db)).toEqual(fileVersions());
    db.close();
  });

  it('is idempotent — a second run does not throw (guards ALTER ADD COLUMN re-run)', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    // The second pass must skip every already-applied migration. If a version were
    // not recorded, an ALTER TABLE ADD COLUMN migration (021/022) would throw here.
    expect(() => runMigrations(db)).not.toThrow();
    expect(recordedVersions(db)).toEqual(fileVersions());
    db.close();
  });
});
