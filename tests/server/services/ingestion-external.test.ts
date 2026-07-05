import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';
import { ingestExternalAgentUsage, type UsageSource } from '../../../server/services/ingestion-service';
import type { RawUsage } from '../../../src/shared/agents/types';

const usage = (model: string, tokens: Partial<RawUsage> = {}): RawUsage => {
  const base = {
    model,
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    messageCount: 3,
  };
  const merged = { ...base, ...tokens };
  return { ...merged, byModel: [merged] };
};

describe('ingestExternalAgentUsage', () => {
  let db: Database.Database;
  let dir: string;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    dir = mkdtempSync(join(tmpdir(), 'ext-ingest-'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const makeLog = (name: string): string => {
    const p = join(dir, name);
    writeFileSync(p, '{}', 'utf8');
    return p;
  };

  const rowsFor = (like: string) =>
    db
      .prepare(
        'SELECT session_id, model, provider, estimated_cost_usd, unpriced, message_count FROM session_model_usage WHERE session_id LIKE ? ORDER BY session_id',
      )
      .all(like) as Array<{
      session_id: string;
      model: string;
      provider: string;
      estimated_cost_usd: number;
      unpriced: number;
      message_count: number;
    }>;

  it('ingests codex rollouts into provider-tagged session_model_usage rows with cost', async () => {
    const log = makeLog('rollout-2026-06-09-sess7.jsonl');
    const source: UsageSource = {
      id: 'codex',
      listSessionLogs: () => [log],
      parseUsage: () => usage('gpt-5.5', { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    };

    await ingestExternalAgentUsage(db, [source]);

    const rows = rowsFor('codex:%');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.session_id).toBe('codex:rollout-2026-06-09-sess7');
    expect(rows[0]!.provider).toBe('codex');
    expect(rows[0]!.unpriced).toBe(0);
    // $5/M input + $30/M output → $35 for 1M+1M
    expect(rows[0]!.estimated_cost_usd).toBeCloseTo(35, 2);
  });

  it('skips sessions whose message count has not grown, re-ingests grown ones', async () => {
    const log = makeLog('rollout-a.jsonl');
    let calls = 0;
    const source: UsageSource = {
      id: 'codex',
      listSessionLogs: () => [log],
      parseUsage: () => {
        calls += 1;
        return usage('gpt-5.4', { messageCount: calls === 1 ? 3 : 3 });
      },
    };

    await ingestExternalAgentUsage(db, [source]);
    await ingestExternalAgentUsage(db, [source]); // same count → skip write
    expect(rowsFor('codex:%')).toHaveLength(1);
    expect(rowsFor('codex:%')[0]!.message_count).toBe(3);

    // Grown session re-ingests.
    const grown: UsageSource = {
      id: 'codex',
      listSessionLogs: () => [log],
      parseUsage: () => usage('gpt-5.4', { messageCount: 10 }),
    };
    await ingestExternalAgentUsage(db, [grown]);
    expect(rowsFor('codex:%')[0]!.message_count).toBe(10);
  });

  it('survives a throwing source and still ingests the healthy one', async () => {
    const bad: UsageSource = {
      id: 'codex',
      listSessionLogs: () => {
        throw new Error('no store');
      },
      parseUsage: () => usage('gpt-5.5'),
    };
    const good: UsageSource = {
      id: 'antigravity',
      listSessionLogs: () => [makeLog('chat-1.jsonl')],
      parseUsage: () => usage('gemini-3-pro'),
    };

    await ingestExternalAgentUsage(db, [bad, good]);

    expect(rowsFor('codex:%')).toHaveLength(0);
    const agy = rowsFor('antigravity:%');
    expect(agy).toHaveLength(1);
    expect(agy[0]!.provider).toBe('antigravity');
  });

  it('ignores empty sessions (messageCount 0)', async () => {
    const source: UsageSource = {
      id: 'codex',
      listSessionLogs: () => [makeLog('rollout-empty.jsonl')],
      parseUsage: () => usage('gpt-5.5', { messageCount: 0 }),
    };
    await ingestExternalAgentUsage(db, [source]);
    expect(rowsFor('codex:%')).toHaveLength(0);
  });
});
