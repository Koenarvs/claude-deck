import type Database from 'better-sqlite3';
import { resolveModel } from '../../src/shared/agents/model-registry';
import type { ProviderConfig } from '../../src/shared/agents/provider-config';

function windowStart(days: number): number {
  return days > 0 ? Date.now() - days * 86_400_000 : 0;
}

export interface ProviderValueRow {
  provider: string;
  label: 'cost' | 'equivalent_value';
  equivalentUsd: number; // tokens × registry pricing (always computed)
  seatPriceUsdMonthly?: number; // seat only
  valueMultiplier?: number; // seat only: equivalentUsd ÷ seatPriceUsdMonthly
  budgetUsd?: number; // metered only: monthly budget cap
}

export function getProviderValue(db: Database.Database, days: number, providers: ProviderConfig[]): ProviderValueRow[] {
  const since = windowStart(days);
  const rows = db.prepare(`
    SELECT provider, COALESCE(SUM(estimated_cost_usd), 0) AS usd
    FROM session_model_usage
    WHERE first_message_at > ?
    GROUP BY provider
  `).all(since) as Array<{ provider: string; usd: number }>;
  const usdByProvider = new Map(rows.map((r) => [r.provider, r.usd]));

  return providers.filter((p) => p.enabled).map((p): ProviderValueRow => {
    const equivalentUsd = Math.round((usdByProvider.get(p.id) ?? 0) * 10000) / 10000;
    if (p.billingMode === 'seat') {
      const seat = p.seatPriceUsdMonthly;
      return {
        provider: p.id,
        label: 'equivalent_value',
        equivalentUsd,
        seatPriceUsdMonthly: seat,
        valueMultiplier: seat && seat > 0 ? Math.round((equivalentUsd / seat) * 100) / 100 : undefined,
      };
    }
    return {
      provider: p.id,
      label: 'cost',
      equivalentUsd,
      budgetUsd: p.budget?.monthlyUsd,
    };
  });
}

export interface WindowUtilizationRow {
  provider: string;
  weightedUnits: number; // Σ(tokens × quotaWeight)
  estimatedWindowCap: number; // heuristic cap (NOT a vendor figure)
  utilizationPct: number; // weightedUnits / cap × 100, clamped 0..100
  isEstimate: true;
}

/**
 * Quota-weighted consumption over the provider's rolling window (5-hour default
 * for subscription seats) vs an ESTIMATED cap. No vendor quota API exists — the
 * cap is a heuristic and every row is flagged isEstimate.
 */
export function getWindowUtilization(db: Database.Database, providers: ProviderConfig[]): WindowUtilizationRow[] {
  const ROLLING_WINDOW_MS = 5 * 60 * 60 * 1000; // 5h subscription window
  const ESTIMATED_WINDOW_CAP_UNITS = 2_000_000; // heuristic weighted-token cap per window
  const since = Date.now() - ROLLING_WINDOW_MS;

  const seatProviders = providers.filter((p) => p.enabled && p.billingMode === 'seat');
  const out: WindowUtilizationRow[] = [];

  for (const p of seatProviders) {
    const modelRows = db.prepare(`
      SELECT model, COALESCE(SUM(total_tokens), 0) AS tokens
      FROM session_model_usage
      WHERE provider = ? AND first_message_at > ?
      GROUP BY model
    `).all(p.id, since) as Array<{ model: string; tokens: number }>;

    let weighted = 0;
    for (const r of modelRows) {
      const entry = resolveModel(r.model);
      const weight = entry?.quotaWeight ?? 1;
      weighted += r.tokens * weight;
    }
    out.push({
      provider: p.id,
      weightedUnits: Math.round(weighted),
      estimatedWindowCap: ESTIMATED_WINDOW_CAP_UNITS,
      utilizationPct: Math.min(100, Math.round((weighted / ESTIMATED_WINDOW_CAP_UNITS) * 1000) / 10),
      isEstimate: true,
    });
  }
  return out;
}
