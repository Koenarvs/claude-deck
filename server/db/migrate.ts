import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Runs all pending SQL migrations against the database.
 * Reads .sql files from server/db/migrations/ in lexical order.
 * Idempotent: CREATE TABLE IF NOT EXISTS + schema_migrations tracking
 * prevent re-application errors.
 */
export function runMigrations(db: Database.Database): void {
  const migrationsDir = path.join(__dirname, 'migrations');

  if (!fs.existsSync(migrationsDir)) {
    return;
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf-8');
    db.exec(sql);
  }
}
