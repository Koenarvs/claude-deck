import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';
import { getProviderValue, getWindowUtilization } from '../../../server/services/analytics-value-service';
import type { ProviderConfig } from '../../../src/shared/agents/provider-config';

const DAY = 86_400_000;
function daysAgo(n: number): number { return Date.now() - n * DAY; }
function dateOf(n: number): string { return new Date(daysAgo(n)).toISOString().split('T')[0]; }

// daysAgo is kept small (0) so the same rows are visible to both the 30-day
// value window and the 5-hour window-utilization window. (The plan seeded 5d,
// which is outside the 5h window — corrected here so the util assertion holds.)
function seed(db: Database.Database, r: { model: string; tier: string; provider: string; total: number; cost: number; daysAgo: number }): void {
  db.prepare(`INSERT OR REPLACE INTO session_model_usage
      (session_id, model, tier, provider, input_tokens, cache_creation_tokens, cache_read_tokens,
       output_tokens, total_tokens, estimated_cost_usd, unpriced, message_count, session_date, first_message_at)
      VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?, 0, 1, ?, ?)`)
    .run(`sess-${r.model}-${r.daysAgo}`, r.model, r.tier, r.provider, r.total, r.total, r.cost, dateOf(r.daysAgo), daysAgo(r.daysAgo));
}

describe('analytics-value-service', () => {
  let db: Database.Database;
  const providers: ProviderConfig[] = [
    { id: 'claude', enabled: true, billingMode: 'seat', seatPriceUsdMonthly: 200 },
    { id: 'antigravity', enabled: true, billingMode: 'metered', budget: { monthlyUsd: 500 } },
  ];

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    seed(db, { model: 'claude-opus-4-8', tier: 'frontier', provider: 'claude', total: 1_000_000, cost: 6000, daysAgo: 0 });
    seed(db, { model: 'gemini-3-pro', tier: 'frontier', provider: 'antigravity', total: 500_000, cost: 250, daysAgo: 0 });
  });
  afterEach(() => { db.close(); });

  it('seat provider gets equivalent_value label + value multiplier', () => {
    const rows = getProviderValue(db, 30, providers);
    const claude = rows.find((r) => r.provider === 'claude')!;
    expect(claude.label).toBe('equivalent_value');
    expect(claude.equivalentUsd).toBeCloseTo(6000, 2);
    expect(claude.seatPriceUsdMonthly).toBe(200);
    expect(claude.valueMultiplier).toBeCloseTo(6000 / 200, 4); // ~30x — the "steal" view
    expect(claude.budgetUsd).toBeUndefined();
  });

  it('metered provider gets cost label + budget vs spend (no multiplier)', () => {
    const ag = getProviderValue(db, 30, providers).find((r) => r.provider === 'antigravity')!;
    expect(ag.label).toBe('cost');
    expect(ag.equivalentUsd).toBeCloseTo(250, 2);
    expect(ag.budgetUsd).toBe(500);
    expect(ag.valueMultiplier).toBeUndefined();
  });

  it('window utilization is seat-only and labeled estimate', () => {
    const util = getWindowUtilization(db, providers);
    const claude = util.find((u) => u.provider === 'claude')!;
    expect(claude.isEstimate).toBe(true);
    expect(claude.weightedUnits).toBeGreaterThan(0);
    expect(claude.estimatedWindowCap).toBeGreaterThan(0);
    expect(claude.utilizationPct).toBeGreaterThanOrEqual(0);
    expect(util.find((u) => u.provider === 'antigravity')).toBeUndefined();
  });
});
