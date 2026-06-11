export interface ProviderBudget {
  dailyUsd?: number;
  monthlyUsd?: number;
  perGoalUsd?: number;
}

export interface ProviderBudgetConfig {
  billingMode: 'metered' | 'seat';
  budget: ProviderBudget;
  /** Max concurrent sessions for this provider; null = unlimited. */
  maxConcurrent: number | null;
}

export interface BudgetConfig {
  providers: Record<string, ProviderBudgetConfig>;
  anyMetered: boolean;
}

interface RichProvider {
  id: string;
  enabled?: boolean;
  billingMode?: 'metered' | 'seat';
  budget?: ProviderBudget;
  maxConcurrent?: number | null;
}

/**
 * Normalizes whatever the config service returns into a budget view. Accepts both
 * the legacy `{ enabledProviders: string[] }` and the rich `{ providers: ProviderConfig[] }`
 * shapes. Missing budget/billingMode default to "no caps, seat mode" so callers never
 * crash on a partial config. 'claude' is always present.
 */
export function readBudgetConfig(cfg: unknown): BudgetConfig {
  const providers: Record<string, ProviderBudgetConfig> = {};
  const obj = (cfg ?? {}) as { providers?: RichProvider[]; enabledProviders?: string[] };

  if (Array.isArray(obj.providers)) {
    for (const p of obj.providers) {
      providers[p.id] = {
        billingMode: p.billingMode === 'metered' ? 'metered' : 'seat',
        budget: p.budget ?? {},
        maxConcurrent: typeof p.maxConcurrent === 'number' ? p.maxConcurrent : null,
      };
    }
  } else if (Array.isArray(obj.enabledProviders)) {
    for (const id of obj.enabledProviders) {
      providers[id] = { billingMode: 'seat', budget: {}, maxConcurrent: null };
    }
  }

  if (!providers['claude']) {
    providers['claude'] = { billingMode: 'seat', budget: {}, maxConcurrent: null };
  }

  const anyMetered = Object.values(providers).some((p) => p.billingMode === 'metered');
  return { providers, anyMetered };
}
