import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeMigratedDb } from '../helpers/db-fixture';
import { createBudgetService } from '../../../server/services/budget-service';
import type Database from 'better-sqlite3';

vi.mock('../../../server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let db: Database.Database;

function seedGoalSpend(goalId: string, model: string, costUsd: number) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO goals (id, title, cwd, status, priority, permission_mode, kanban_order, created_at, updated_at)
     VALUES (?, ?, '/r', 'active', 0, 'supervised', 1, ?, ?)`,
  ).run(goalId, goalId, now, now);
  db.prepare(
    `INSERT INTO sessions (id, goal_id, origin, model, started_at, stream_event_count, hook_event_count, stderr_bytes)
     VALUES (?, ?, 'dashboard', ?, ?, 0, 0, 0)`,
  ).run(`s-${goalId}`, goalId, model, now);
  db.prepare(
    `INSERT INTO session_usage
       (session_id, project_dir, model, input_tokens, cache_creation_tokens, cache_read_tokens, output_tokens, total_tokens, estimated_cost_usd, message_count, session_date, first_message_at, ingested_at)
     VALUES (?, 'p', ?, 0,0,0,0,0, ?, 1, date('now'), ?, ?)`,
  ).run(`s-${goalId}`, model, costUsd, now, now);
}

beforeEach(() => {
  db = makeMigratedDb();
});
afterEach(() => db.close());

describe('BudgetService', () => {
  it('kill switch toggles and is read back', () => {
    const svc = createBudgetService(db, () => ({ enabledProviders: ['claude'] }));
    expect(svc.isKillSwitchActive()).toBe(false);
    svc.setKillSwitch(true);
    expect(svc.isKillSwitchActive()).toBe(true);
  });

  it('blocks a new spawn when the kill switch is active', () => {
    const svc = createBudgetService(db, () => ({ enabledProviders: ['claude'] }));
    svc.setKillSwitch(true);
    const d = svc.evaluateSpawn({ goalId: 'g1', model: 'opus' });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/kill switch/i);
  });

  it('allows spawn on a seat provider even over a cap (caps are metered-only)', () => {
    seedGoalSpend('g1', 'opus', 999);
    const svc = createBudgetService(db, () => ({
      providers: [{ id: 'claude', enabled: true, billingMode: 'seat', budget: { perGoalUsd: 1 } }],
    }));
    expect(svc.evaluateSpawn({ goalId: 'g1', model: 'opus' }).allowed).toBe(true);
  });

  it('blocks spawn on a metered provider over the per-goal cap', () => {
    seedGoalSpend('g1', 'opus', 12);
    const svc = createBudgetService(db, () => ({
      providers: [{ id: 'claude', enabled: true, billingMode: 'metered', budget: { perGoalUsd: 10 } }],
    }));
    const d = svc.evaluateSpawn({ goalId: 'g1', model: 'opus' });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/per-goal/i);
  });

  it('blocks spawn on a metered provider over the daily cap', () => {
    seedGoalSpend('g1', 'opus', 60);
    const svc = createBudgetService(db, () => ({
      providers: [{ id: 'claude', enabled: true, billingMode: 'metered', budget: { dailyUsd: 50 } }],
    }));
    const d = svc.evaluateSpawn({ goalId: 'g2', model: 'opus' });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/daily/i);
  });

  it('enforces per-provider concurrency', () => {
    const svc = createBudgetService(db, () => ({
      providers: [{ id: 'claude', enabled: true, billingMode: 'seat', maxConcurrent: 1 }],
    }));
    const d = svc.evaluateSpawn({ goalId: 'g1', model: 'opus', activeForProvider: 1 });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/concurren/i);
  });

  it('flags a burn-rate alarm above the tokens/min threshold', () => {
    const svc = createBudgetService(db, () => ({ enabledProviders: ['claude'] }), {
      burnRateTokensPerMin: 100_000,
    });
    expect(svc.checkBurnRate({ goalId: 'g1', tokens: 250_000, windowMs: 60_000 }).alarm).toBe(true);
    expect(svc.checkBurnRate({ goalId: 'g1', tokens: 1_000, windowMs: 60_000 }).alarm).toBe(false);
  });

  it('evaluateRunningGoals returns goals to pause on a metered over-cap', () => {
    seedGoalSpend('g1', 'opus', 12);
    const svc = createBudgetService(db, () => ({
      providers: [{ id: 'claude', enabled: true, billingMode: 'metered', budget: { perGoalUsd: 10 } }],
    }));
    expect(svc.evaluateRunningGoals(['g1'])).toContain('g1');
  });
});
