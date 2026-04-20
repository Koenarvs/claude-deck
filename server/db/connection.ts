import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

let db: Database.Database | null = null;

/**
 * Returns a lazy-initialized SQLite database connection.
 * Creates the data directory if it does not exist.
 * Enables WAL mode and foreign keys.
 */
export function getDb(dataDir: string): Database.Database {
  if (db) return db;

  fs.mkdirSync(dataDir, { recursive: true });

  const dbPath = path.join(dataDir, 'claude-deck.db');
  db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  return db;
}

/** Closes the database connection and resets the singleton. */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
