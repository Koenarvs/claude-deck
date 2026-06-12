import { describe, it, expect, afterEach } from 'vitest';
import { makeMigratedDb } from '../helpers/db-fixture';
import type Database from 'better-sqlite3';

let db: Database.Database;
afterEach(() => db?.close());

describe('migration 025 orchestrator', () => {
  it('creates orchestrator_messages and orchestrator_state with a seeded singleton row', () => {
    db = makeMigratedDb();
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('orchestrator_messages','orchestrator_state')",
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name).sort()).toEqual(['orchestrator_messages', 'orchestrator_state']);

    const state = db.prepare('SELECT * FROM orchestrator_state WHERE id = 1').get() as
      | { id: number; status: string; config_json: string }
      | undefined;
    expect(state?.status).toBe('idle');
    expect(JSON.parse(state!.config_json).persona_name).toBe('Hawat');
  });

  it('enforces the singleton id=1 + status check constraints', () => {
    db = makeMigratedDb();
    expect(() =>
      db.prepare('INSERT INTO orchestrator_state (id, status, config_json, updated_at) VALUES (2, ?, ?, ?)').run('idle', '{}', 0),
    ).toThrow();
    expect(() =>
      db.prepare('INSERT INTO orchestrator_messages (id, role, channel, content, created_at) VALUES (?, ?, ?, ?, ?)').run('m', 'robot', 'app', 'x', 0),
    ).toThrow();
  });
});
