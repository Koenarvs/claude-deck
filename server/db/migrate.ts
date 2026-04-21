import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import logger from '../logger';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Runs all pending SQL migrations against the database.
 * Reads .sql files from server/db/migrations/ in lexical order.
 * Checks schema_migrations table to skip already-applied migrations.
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

  // Get already-applied migration versions
  const applied = new Set<number>();
  try {
    const rows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>;
    for (const row of rows) {
      applied.add(row.version);
    }
  } catch {
    // schema_migrations table doesn't exist yet — first run
  }

  for (const file of files) {
    // Extract version number from filename (e.g., "003_session_hierarchy.sql" → 3)
    const match = file.match(/^(\d+)/);
    const version = match ? parseInt(match[1], 10) : null;

    if (version !== null && applied.has(version)) {
      logger.debug({ file, version }, 'Migration already applied, skipping');
      continue;
    }

    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf-8');

    logger.info({ file, version }, 'Running migration');
    db.exec(sql);
  }
}
