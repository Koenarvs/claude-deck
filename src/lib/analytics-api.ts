// Typed client for the Phase 2 per-model analytics endpoints. Each helper takes
// an AbortSignal (the AnalyticsPage aborts in-flight requests when the time range
// changes, fixing the stale-response race) and returns a safe fallback on
// non-ok/abort so callers never need try/catch.

export interface ModelBreakdownRow {
  model: string;
  tier: string;
  provider: string;
  tokensIn: number;
  tokensOut: number;
  equivalentUsd: number;
  effectiveRatePerMTok: number;
  share: number;
  unpriced: boolean;
}
export interface ModelBreakdownResponse {
  label: 'cost' | 'equivalent_value';
  models: ModelBreakdownRow[];
}

export interface ModelMixBucket {
  date: string;
  models: Record<string, number>;
  topTierShare: number;
}
export interface ModelMixResponse {
  label: 'cost' | 'equivalent_value';
  series: ModelMixBucket[];
}

export interface ProviderValueRow {
  provider: string;
  label: 'cost' | 'equivalent_value';
  equivalentUsd: number;
  seatPriceUsdMonthly?: number;
  valueMultiplier?: number;
  budgetUsd?: number;
}
export interface ProviderValueResponse {
  providers: ProviderValueRow[];
}

export interface WindowUtilizationRow {
  provider: string;
  weightedUnits: number;
  estimatedWindowCap: number;
  utilizationPct: number;
  isEstimate: true;
}
export interface WindowUtilizationResponse {
  rows: WindowUtilizationRow[];
}

export interface CostPerGoalPoint {
  date: string;
  equivalentUsdPerGoal: number;
  completedGoals: number;
}
export interface CostPerGoalResponse {
  label: 'cost' | 'equivalent_value';
  series: CostPerGoalPoint[];
}

async function getJson<T>(url: string, signal: AbortSignal, fallback: T): Promise<T> {
  try {
    const r = await fetch(url, { signal });
    if (!r.ok) return fallback;
    const body: unknown = await r.json();
    // Merge over the fallback so a malformed/wrong-shape body (e.g. a bare array
    // or partial object) still yields the expected array fields — the UI relies
    // on .length/.map/.some never hitting undefined.
    if (body && typeof body === 'object') return { ...fallback, ...(body as object) } as T;
    return fallback;
  } catch {
    return fallback;
  }
}

export function fetchModelBreakdown(days: number, signal: AbortSignal): Promise<ModelBreakdownResponse> {
  return getJson(`/api/analytics/model-breakdown?days=${days}`, signal, { label: 'equivalent_value', models: [] });
}
export function fetchModelMix(days: number, signal: AbortSignal): Promise<ModelMixResponse> {
  return getJson(`/api/analytics/model-mix?days=${days}&bucket=day`, signal, { label: 'equivalent_value', series: [] });
}
export function fetchProviderValue(days: number, signal: AbortSignal): Promise<ProviderValueResponse> {
  return getJson(`/api/analytics/value?days=${days}`, signal, { providers: [] });
}
export function fetchWindowUtilization(signal: AbortSignal): Promise<WindowUtilizationResponse> {
  return getJson(`/api/analytics/window-utilization`, signal, { rows: [] });
}
export function fetchCostPerGoal(days: number, signal: AbortSignal): Promise<CostPerGoalResponse> {
  return getJson(`/api/analytics/cost-per-goal?days=${days}`, signal, { label: 'equivalent_value', series: [] });
}
