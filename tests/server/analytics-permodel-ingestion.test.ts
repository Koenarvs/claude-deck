import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/db/migrate';
import { ingestAllSessions } from '../../server/services/ingestion-service';

function line(obj: unknown): string { return JSON.stringify(obj); }

describe('Per-model ingestion → session_model_usage', () => {
  let db: Database.Database;
  let tmp: string;

  beforeAll(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-permodel-'));
    const proj = path.join(tmp, 'proj');
    fs.mkdirSync(proj, { recursive: true });

    // A single session that mixes opus + sonnet (subagent / mid-session switch).
    fs.writeFileSync(path.join(proj, 'mixed.jsonl'), [
      line({ type: 'system', subtype: 'init', model: 'claude-opus-4-8', timestamp: '2026-06-01T10:00:00Z' }),
      line({ timestamp: '2026-06-01T10:00:01Z', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1000, output_tokens: 500 } } }),
      line({ timestamp: '2026-06-01T10:01:00Z', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 2000, output_tokens: 1000 } } }),
    ].join('\n') + '\n');

    await ingestAllSessions(db, tmp);
  });

  afterAll(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  it('writes one parent session_usage row (rollup unchanged)', () => {
    const row = db.prepare('SELECT * FROM session_usage WHERE session_id = ?').get('mixed') as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.input_tokens).toBe(3000);
    expect(row.output_tokens).toBe(1500);
  });

  it('writes one session_model_usage row per model', () => {
    const rows = db.prepare(
      'SELECT model, input_tokens, output_tokens, tier FROM session_model_usage WHERE session_id = ? ORDER BY model',
    ).all('mixed') as Array<{ model: string; input_tokens: number; output_tokens: number; tier: string }>;
    expect(rows.length).toBe(2);
    const opus = rows.find((r) => r.model.includes('opus'))!;
    const sonnet = rows.find((r) => r.model.includes('sonnet'))!;
    expect(opus.input_tokens).toBe(1000);
    expect(opus.output_tokens).toBe(500);
    expect(opus.tier).toBe('frontier');
    expect(sonnet.input_tokens).toBe(2000);
    expect(sonnet.output_tokens).toBe(1000);
    expect(sonnet.tier).toBe('balanced');
  });

  it('parent cost equals the sum of per-model costs', () => {
    const parent = db.prepare('SELECT estimated_cost_usd FROM session_usage WHERE session_id = ?').get('mixed') as { estimated_cost_usd: number };
    const childSum = (db.prepare('SELECT COALESCE(SUM(estimated_cost_usd),0) AS s FROM session_model_usage WHERE session_id = ?').get('mixed') as { s: number }).s;
    expect(parent.estimated_cost_usd).toBeCloseTo(childSum, 4);
  });

  it('re-ingestion does not duplicate per-model rows', async () => {
    await ingestAllSessions(db, tmp);
    const n = (db.prepare('SELECT COUNT(*) AS c FROM session_model_usage WHERE session_id = ?').get('mixed') as { c: number }).c;
    expect(n).toBe(2);
  });
});
