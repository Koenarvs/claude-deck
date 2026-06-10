import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';
import {
  getModelBreakdown, getModelMix, getCostPerGoal,
} from '../../../server/services/analytics-model-service';

const DAY = 86_400_000;
function daysAgo(n: number): number { return Date.now() - n * DAY; }
function dateOf(n: number): string { return new Date(daysAgo(n)).toISOString().split('T')[0]; }

function seedModelRow(db: Database.Database, r: {
  session: string; model: string; tier: string; provider?: string;
  input: number; output: number; cost: number; unpriced?: 0 | 1; daysAgo: number;
}): void {
  db.prepare(`
    INSERT OR REPLACE INTO session_model_usage
      (session_id, model, tier, provider, input_tokens, cache_creation_tokens,
       cache_read_tokens, output_tokens, total_tokens, estimated_cost_usd, unpriced,
       message_count, session_date, first_message_at)
    VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    r.session, r.model, r.tier, r.provider ?? 'claude',
    r.input, r.output, r.input + r.output, r.cost, r.unpriced ?? 0,
    dateOf(r.daysAgo), daysAgo(r.daysAgo),
  );
}

describe('analytics-model-service', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    seedModelRow(db, { session: 's1', model: 'claude-opus-4-8', tier: 'frontier', input: 1000, output: 500, cost: 1.0, daysAgo: 2 });
    seedModelRow(db, { session: 's1', model: 'claude-sonnet-4-6', tier: 'balanced', input: 4000, output: 2000, cost: 0.5, daysAgo: 2 });
    seedModelRow(db, { session: 's2', model: 'claude-opus-4-8', tier: 'frontier', input: 1000, output: 500, cost: 1.0, daysAgo: 40 });
    seedModelRow(db, { session: 's3', model: 'gemini-3-pro', tier: 'frontier', input: 9000, output: 0, cost: 0, unpriced: 1, daysAgo: 1 });
  });
  afterEach(() => { db.close(); });

  describe('getModelBreakdown', () => {
    it('groups by model within the window and computes share + effective rate', () => {
      const rows = getModelBreakdown(db, 30);
      const opus = rows.find((r) => r.model.includes('opus'))!;
      expect(rows.find((r) => r.model.includes('gemini'))).toBeTruthy(); // unpriced still listed
      expect(opus.equivalentUsd).toBeCloseTo(1.0, 4);
      expect(opus.tier).toBe('frontier');
      expect(opus.effectiveRatePerMTok).toBeCloseTo((1.0 / (1500 / 1_000_000)), 0);
      const totalShare = rows.reduce((s, r) => s + r.share, 0);
      expect(totalShare).toBeCloseTo(1, 4);
    });

    it('marks unpriced models', () => {
      const gemini = getModelBreakdown(db, 30).find((r) => r.model.includes('gemini'))!;
      expect(gemini.unpriced).toBe(true);
      expect(gemini.equivalentUsd).toBe(0);
    });

    it('days=0 includes all-time rows', () => {
      expect(getModelBreakdown(db, 0).reduce((s, r) => s + r.tokensIn + r.tokensOut, 0))
        .toBeGreaterThan(getModelBreakdown(db, 30).reduce((s, r) => s + r.tokensIn + r.tokensOut, 0));
    });
  });

  describe('getModelMix', () => {
    it('returns per-date buckets with per-model token shares and a topTierShare', () => {
      const series = getModelMix(db, 30, 'day');
      expect(Array.isArray(series)).toBe(true);
      const today = series.find((b) => b.date === dateOf(1))!;
      expect(today.topTierShare).toBeCloseTo(1, 4);
      const twoDaysAgo = series.find((b) => b.date === dateOf(2))!;
      expect(twoDaysAgo.topTierShare).toBeCloseTo(1500 / 7500, 4);
      expect(twoDaysAgo.models['claude-opus-4-8']).toBeGreaterThan(0);
    });
  });

  describe('getCostPerGoal', () => {
    it('trends equivalent-$ per completed goal by completion week', () => {
      db.prepare(`INSERT INTO goals (id, title, cwd, status, kanban_order, created_at, updated_at, completed_at)
                  VALUES ('g1','G','/x','complete', 1, ?, ?, ?)`).run(daysAgo(2), daysAgo(2), daysAgo(2));
      db.prepare(`INSERT INTO sessions (id, goal_id, origin, started_at) VALUES ('s1','g1','dashboard', ?)`).run(daysAgo(2));
      const series = getCostPerGoal(db, 30);
      expect(series.length).toBeGreaterThan(0);
      const point = series[0];
      expect(typeof point.date).toBe('string');
      expect(point.equivalentUsdPerGoal).toBeCloseTo(1.5, 4);
      expect(point.completedGoals).toBe(1);
    });
  });
});
