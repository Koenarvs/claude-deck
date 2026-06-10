import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';

describe('Migration 017 — session_model_usage', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); runMigrations(db); });
  afterEach(() => { db.close(); });

  it('creates the session_model_usage table', () => {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='session_model_usage'",
    ).get();
    expect(row).toBeTruthy();
  });

  it('has the expected columns', () => {
    const cols = (db.pragma('table_info(session_model_usage)') as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      'session_id', 'model', 'tier', 'provider',
      'input_tokens', 'cache_creation_tokens', 'cache_read_tokens', 'output_tokens',
      'total_tokens', 'estimated_cost_usd', 'unpriced', 'message_count', 'session_date',
      'first_message_at',
    ]));
  });

  it('enforces uniqueness on (session_id, model)', () => {
    const insert = db.prepare(`
      INSERT INTO session_model_usage
        (session_id, model, tier, provider, input_tokens, cache_creation_tokens,
         cache_read_tokens, output_tokens, total_tokens, estimated_cost_usd, unpriced,
         message_count, session_date, first_message_at)
      VALUES (@session_id, @model, @tier, @provider, @in, @cc, @cr, @out, @total, @cost,
              @unpriced, @mc, @date, @first)
    `);
    const row = {
      session_id: 's1', model: 'opus', tier: 'frontier', provider: 'claude',
      in: 100, cc: 10, cr: 20, out: 50, total: 180, cost: 0.5, unpriced: 0,
      mc: 3, date: '2026-06-01', first: 1717200000000,
    };
    insert.run(row);
    expect(() => insert.run(row)).toThrow(/UNIQUE/);
  });

  it('records migration version 17', () => {
    const r = db.prepare('SELECT 1 FROM schema_migrations WHERE version = 17').get();
    expect(r).toBeTruthy();
  });
});
