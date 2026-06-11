import type Database from 'better-sqlite3';
import { resolveModel } from '../../src/shared/agents/model-registry';
import { readBudgetConfig, type BudgetConfig } from './budget-config';
import logger from '../logger';

export interface BudgetServiceOptions {
  /** tokens/min above which a burn-rate alarm fires. Default 500k. */
  burnRateTokensPerMin?: number;
}

export interface SpawnDecision {
  allowed: boolean;
  reason: string;
}

export interface BurnRateResult {
  alarm: boolean;
  tokensPerMin: number;
}

/** Reads the live config each call so Settings changes take effect without restart. */
export type ConfigReader = () => unknown;

function providerForModel(model: string): string {
  return resolveModel(model)?.provider ?? 'claude';
}

export function createBudgetService(
  db: Database.Database,
  readConfig: ConfigReader,
  options: BudgetServiceOptions = {},
) {
  const burnRateThreshold = options.burnRateTokensPerMin ?? 500_000;

  const killReadStmt = db.prepare<[], { value_json: string }>(
    "SELECT value_json FROM budget_state WHERE key = 'kill_switch'",
  );
  const killWriteStmt = db.prepare<[string, number]>(
    `INSERT INTO budget_state (key, value_json, updated_at) VALUES ('kill_switch', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  );

  function isKillSwitchActive(): boolean {
    const row = killReadStmt.get();
    if (!row) return false;
    try {
      return Boolean((JSON.parse(row.value_json) as { active?: boolean }).active);
    } catch {
      return false;
    }
  }

  function setKillSwitch(active: boolean): void {
    killWriteStmt.run(JSON.stringify({ active }), Date.now());
    logger.warn({ active }, 'Budget kill switch set');
  }

  function spentForGoalUsd(goalId: string): number {
    const row = db
      .prepare(`
        SELECT COALESCE(SUM(su.estimated_cost_usd), 0) as cost
        FROM session_usage su JOIN sessions s ON su.session_id = s.id
        WHERE s.goal_id = ?
      `)
      .get(goalId) as { cost: number };
    return row.cost;
  }

  function spentTodayUsd(): number {
    const row = db
      .prepare(`
        SELECT COALESCE(SUM(estimated_cost_usd), 0) as cost
        FROM session_usage WHERE session_date = date('now')
      `)
      .get() as { cost: number };
    return row.cost;
  }

  function config(): BudgetConfig {
    return readBudgetConfig(readConfig());
  }

  /**
   * Decides whether a goal may spawn/continue. Order: kill switch → concurrency →
   * (metered only) per-goal cap → daily cap. Seat providers never hit caps.
   */
  function evaluateSpawn(input: {
    goalId: string;
    model: string;
    activeForProvider?: number;
  }): SpawnDecision {
    if (isKillSwitchActive()) {
      return { allowed: false, reason: 'Global kill switch is active' };
    }

    const cfg = config();
    const providerId = providerForModel(input.model);
    const provider = cfg.providers[providerId] ?? cfg.providers['claude']!;

    if (provider.maxConcurrent !== null && (input.activeForProvider ?? 0) >= provider.maxConcurrent) {
      return { allowed: false, reason: `Provider concurrency limit reached (${provider.maxConcurrent})` };
    }

    if (provider.billingMode === 'metered') {
      const goalSpend = spentForGoalUsd(input.goalId);
      if (provider.budget.perGoalUsd != null && goalSpend >= provider.budget.perGoalUsd) {
        return { allowed: false, reason: `Per-goal cap reached ($${provider.budget.perGoalUsd})` };
      }
      if (provider.budget.dailyUsd != null && spentTodayUsd() >= provider.budget.dailyUsd) {
        return { allowed: false, reason: `Daily cap reached ($${provider.budget.dailyUsd})` };
      }
    }

    return { allowed: true, reason: 'within budget' };
  }

  /** Of the given running goal ids, returns those that must be paused (metered over-cap or kill switch). */
  function evaluateRunningGoals(runningGoalIds: string[]): string[] {
    if (isKillSwitchActive()) return [...runningGoalIds];
    const cfg = config();
    const toPause: string[] = [];
    const metered = Object.values(cfg.providers).filter((p) => p.billingMode === 'metered');
    const dailyCap = metered.reduce<number | null>((min, p) => {
      if (p.budget.dailyUsd == null) return min;
      return min == null ? p.budget.dailyUsd : Math.min(min, p.budget.dailyUsd);
    }, null);
    const dailyOver = dailyCap != null && spentTodayUsd() >= dailyCap;

    for (const goalId of runningGoalIds) {
      if (dailyOver) {
        toPause.push(goalId);
        continue;
      }
      const goalSpend = spentForGoalUsd(goalId);
      const overPerGoal = metered.some(
        (p) => p.budget.perGoalUsd != null && goalSpend >= p.budget.perGoalUsd,
      );
      if (overPerGoal) toPause.push(goalId);
    }
    return toPause;
  }

  function checkBurnRate(input: { goalId: string; tokens: number; windowMs: number }): BurnRateResult {
    const minutes = input.windowMs / 60_000;
    const tokensPerMin = minutes > 0 ? input.tokens / minutes : 0;
    const alarm = tokensPerMin > burnRateThreshold;
    if (alarm) logger.warn({ goalId: input.goalId, tokensPerMin }, 'Burn-rate alarm');
    return { alarm, tokensPerMin };
  }

  return {
    isKillSwitchActive,
    setKillSwitch,
    evaluateSpawn,
    evaluateRunningGoals,
    checkBurnRate,
    spentForGoalUsd,
    spentTodayUsd,
  };
}

export type BudgetService = ReturnType<typeof createBudgetService>;
