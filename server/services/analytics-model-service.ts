import type Database from 'better-sqlite3';

function windowStart(days: number): number {
  return days > 0 ? Date.now() - days * 86_400_000 : 0;
}

export interface ModelBreakdownRow {
  model: string;
  tier: string;
  provider: string;
  tokensIn: number; // input + cache_creation + cache_read
  tokensOut: number; // output
  equivalentUsd: number;
  effectiveRatePerMTok: number; // equivalentUsd per 1M total tokens (0 when unpriced/empty)
  share: number; // share of total equivalentUsd across all models (0..1)
  unpriced: boolean;
}

export function getModelBreakdown(db: Database.Database, days: number): ModelBreakdownRow[] {
  const since = windowStart(days);
  const rows = db.prepare(`
    SELECT model,
      MAX(tier) AS tier,
      MAX(provider) AS provider,
      COALESCE(SUM(input_tokens + cache_creation_tokens + cache_read_tokens), 0) AS tokensIn,
      COALESCE(SUM(output_tokens), 0) AS tokensOut,
      COALESCE(SUM(estimated_cost_usd), 0) AS equivalentUsd,
      MAX(unpriced) AS unpriced
    FROM session_model_usage
    WHERE first_message_at > ?
    GROUP BY model
    ORDER BY equivalentUsd DESC, tokensIn DESC
  `).all(since) as Array<{
    model: string; tier: string; provider: string;
    tokensIn: number; tokensOut: number; equivalentUsd: number; unpriced: number;
  }>;

  const totalUsd = rows.reduce((s, r) => s + r.equivalentUsd, 0);

  return rows.map((r) => {
    const totalTokens = r.tokensIn + r.tokensOut;
    return {
      model: r.model,
      tier: r.tier,
      provider: r.provider,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
      equivalentUsd: Math.round(r.equivalentUsd * 10000) / 10000,
      effectiveRatePerMTok: totalTokens > 0 ? (r.equivalentUsd / totalTokens) * 1_000_000 : 0,
      share: totalUsd > 0 ? r.equivalentUsd / totalUsd : 0,
      unpriced: r.unpriced === 1,
    };
  });
}

export interface ModelMixBucket {
  date: string;
  models: Record<string, number>; // model -> total tokens that day
  topTierShare: number; // frontier tokens / all tokens that day (0..1)
}

export function getModelMix(db: Database.Database, days: number, bucket: 'day' = 'day'): ModelMixBucket[] {
  const since = windowStart(days);
  void bucket; // only 'day' supported today; param reserved for week/month later
  const rows = db.prepare(`
    SELECT session_date AS date, model, tier,
      COALESCE(SUM(total_tokens), 0) AS tokens
    FROM session_model_usage
    WHERE first_message_at > ?
    GROUP BY session_date, model
    ORDER BY session_date
  `).all(since) as Array<{ date: string; model: string; tier: string; tokens: number }>;

  const byDate = new Map<string, { models: Record<string, number>; frontier: number; total: number }>();
  for (const r of rows) {
    const b = byDate.get(r.date) ?? { models: {}, frontier: 0, total: 0 };
    b.models[r.model] = (b.models[r.model] ?? 0) + r.tokens;
    b.total += r.tokens;
    if (r.tier === 'frontier') b.frontier += r.tokens;
    byDate.set(r.date, b);
  }

  return [...byDate.entries()]
    .map(([date, b]) => ({
      date,
      models: b.models,
      topTierShare: b.total > 0 ? b.frontier / b.total : 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export interface CostPerGoalPoint {
  date: string; // ISO week-start date
  equivalentUsdPerGoal: number;
  completedGoals: number;
}

export function getCostPerGoal(db: Database.Database, days: number): CostPerGoalPoint[] {
  const since = windowStart(days);
  // Equivalent$ per goal = sum of the goal's sessions' per-model cost,
  // grouped by the goal's completion week. Only completed goals count.
  const rows = db.prepare(`
    SELECT g.id AS goal_id, g.completed_at AS completed_at,
      COALESCE(SUM(smu.estimated_cost_usd), 0) AS usd
    FROM goals g
    JOIN sessions s ON s.goal_id = g.id
    JOIN session_model_usage smu ON smu.session_id = s.id
    WHERE g.status = 'complete' AND g.completed_at IS NOT NULL AND g.completed_at > ?
    GROUP BY g.id
  `).all(since) as Array<{ goal_id: string; completed_at: number; usd: number }>;

  const byWeek = new Map<string, { usd: number; goals: number }>();
  for (const r of rows) {
    const d = new Date(r.completed_at);
    d.setDate(d.getDate() - d.getDay()); // week start (Sunday)
    const week = d.toISOString().split('T')[0];
    const acc = byWeek.get(week) ?? { usd: 0, goals: 0 };
    acc.usd += r.usd;
    acc.goals += 1;
    byWeek.set(week, acc);
  }

  return [...byWeek.entries()]
    .map(([date, v]) => ({
      date,
      equivalentUsdPerGoal: v.goals > 0 ? Math.round((v.usd / v.goals) * 10000) / 10000 : 0,
      completedGoals: v.goals,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
