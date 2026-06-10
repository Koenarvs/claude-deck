import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import Database from 'better-sqlite3';
import { createApp } from '../../../server/app';
import { createSystemRouter } from '../../../server/routes/system';
import { runMigrations } from '../../../server/db/migrate';
import type { ProviderConfig } from '../../../src/shared/agents/provider-config';

const DAY = 86_400_000;
function daysAgo(n: number): number { return Date.now() - n * DAY; }
function dateOf(n: number): string { return new Date(daysAgo(n)).toISOString().split('T')[0]; }

let server: http.Server;
let port: number;
let db: Database.Database;

const PROVIDERS: ProviderConfig[] = [
  { id: 'claude', enabled: true, billingMode: 'seat', seatPriceUsdMonthly: 200 },
];

beforeAll(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const ins = db.prepare(`INSERT OR REPLACE INTO session_model_usage
      (session_id, model, tier, provider, input_tokens, cache_creation_tokens, cache_read_tokens,
       output_tokens, total_tokens, estimated_cost_usd, unpriced, message_count, session_date, first_message_at)
      VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, 1, ?, ?)`);
  ins.run('s1', 'claude-opus-4-8', 'frontier', 'claude', 1000, 500, 1500, 1.0, 0, dateOf(2), daysAgo(2));
  ins.run('s1', 'claude-sonnet-4-6', 'balanced', 'claude', 4000, 2000, 6000, 0.5, 0, dateOf(2), daysAgo(2));
  ins.run('s2', 'gemini-3-pro', 'frontier', 'antigravity', 9000, 0, 9000, 0, 1, dateOf(1), daysAgo(1));

  const router = createSystemRouter(undefined, { getProviders: () => PROVIDERS });
  const app = createApp({ apiRouters: [router] });
  (app as unknown as { locals: { db: Database.Database } }).locals.db = db;
  server = http.createServer(app);
  port = await new Promise<number>((resolve) => server.listen(0, () => {
    const a = server.address(); if (a && typeof a === 'object') resolve(a.port);
  }));
});

afterAll(() => { server.close(); db.close(); });

const base = () => `http://127.0.0.1:${port}/api/analytics`;

describe('GET /api/analytics/model-breakdown', () => {
  it('returns per-model rows with label from billingMode', async () => {
    const res = await fetch(`${base()}/model-breakdown?days=30`);
    expect(res.status).toBe(200);
    const body = await res.json() as { label: string; models: Array<{ model: string; unpriced: boolean }> };
    expect(body.label).toBe('equivalent_value'); // claude seat
    const gemini = body.models.find((m) => m.model.includes('gemini'));
    expect(gemini?.unpriced).toBe(true); // unpriced surfaced, not hidden
  });
});

describe('GET /api/analytics/model-mix', () => {
  it('returns date buckets with topTierShare', async () => {
    const res = await fetch(`${base()}/model-mix?days=30&bucket=day`);
    expect(res.status).toBe(200);
    const body = await res.json() as { label: string; series: Array<{ date: string; topTierShare: number }> };
    expect(Array.isArray(body.series)).toBe(true);
    expect(body.series.every((b) => b.topTierShare >= 0 && b.topTierShare <= 1)).toBe(true);
  });
});

describe('GET /api/analytics/value', () => {
  it('returns seat provider with value multiplier', async () => {
    const res = await fetch(`${base()}/value?days=30`);
    const body = await res.json() as { providers: Array<{ provider: string; label: string; valueMultiplier?: number }> };
    const claude = body.providers.find((p) => p.provider === 'claude')!;
    expect(claude.label).toBe('equivalent_value');
    expect(claude.valueMultiplier).toBeGreaterThan(0);
  });
});

describe('GET /api/analytics/window-utilization', () => {
  it('returns seat-only rows flagged as estimate', async () => {
    const res = await fetch(`${base()}/window-utilization`);
    const body = await res.json() as { rows: Array<{ provider: string; isEstimate: boolean }> };
    expect(body.rows.every((r) => r.isEstimate === true)).toBe(true);
  });
});

describe('GET /api/analytics/cost-per-goal', () => {
  it('returns a trend array (empty allowed when no completed goals)', async () => {
    const res = await fetch(`${base()}/cost-per-goal?days=30`);
    expect(res.status).toBe(200);
    const body = await res.json() as { label: string; series: unknown[] };
    expect(Array.isArray(body.series)).toBe(true);
  });
});

describe('graceful degradation', () => {
  it('returns empty shapes (not 500) when session_model_usage is empty', async () => {
    const db2 = new Database(':memory:');
    runMigrations(db2);
    const router = createSystemRouter(undefined, { getProviders: () => PROVIDERS });
    const app2 = createApp({ apiRouters: [router] });
    (app2 as unknown as { locals: { db: Database.Database } }).locals.db = db2;
    const s2 = http.createServer(app2);
    const p2 = await new Promise<number>((r) => s2.listen(0, () => {
      const a = s2.address(); if (a && typeof a === 'object') r(a.port);
    }));
    const res = await fetch(`http://127.0.0.1:${p2}/api/analytics/model-breakdown?days=30`);
    expect(res.status).toBe(200);
    const body = await res.json() as { models: unknown[] };
    expect(body.models).toEqual([]);
    s2.close(); db2.close();
  });
});
