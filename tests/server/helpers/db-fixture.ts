import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';

/** In-memory DB with all migrations applied, WAL + FKs on. Caller closes it. */
export function makeMigratedDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}
