// Typed client for the Phase 2 per-model analytics endpoints. Each helper takes
// an AbortSignal (the AnalyticsPage aborts in-flight requests when the time range
// changes, fixing the stale-response race) and returns a safe fallback on
// non-ok/abort so callers never need try/catch.

// ── Core analytics endpoint shapes ──────────────────────────────────────────

export interface ToolUsage { name: string; count: number; }
export interface DailyCost { date: string; cost: number; sessions: number; }
export interface HeatmapDay { date: string; count: number; }
export interface SessionsPerDay { date: string; sessions: number; dashboard: number; external: number; }
export interface DurationBucket { bucket: string; count: number; }
export interface WeeklyCount { date: string; count: number; }
export interface ContextItem { name: string; type: string; usageCount: number; lastUsed: number | null; estimatedSize: number; }
export interface AnalyticsTotals { sessions: number; cost: number; tokensIn: number; tokensOut: number; }

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

export interface HeadroomStatsResponse {
  enabled: boolean;
  requests: number;
  totalInputTokens: number;
  tokensSaved: number;
  savingsPercent: number;
  compressionSavingsUsd: number;
  avgCompressionPct: number;
  bestCompressionPct: number;
  cacheHitRate: number;
  netTokens: number;
  lifetimeTokensSaved: number;
  savingsHistory: Array<Record<string, number>>;
}

export const EMPTY_HEADROOM_STATS: HeadroomStatsResponse = {
  enabled: false,
  requests: 0,
  totalInputTokens: 0,
  tokensSaved: 0,
  savingsPercent: 0,
  compressionSavingsUsd: 0,
  avgCompressionPct: 0,
  bestCompressionPct: 0,
  cacheHitRate: 0,
  netTokens: 0,
  lifetimeTokensSaved: 0,
  savingsHistory: [],
};

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

// ── Core analytics fetchers (Phase 1 endpoints) ─────────────────────────────
// These preserve the AnalyticsPage's original inline-fetch semantics exactly:
// - "strict" endpoints throw on a non-ok response (or network/JSON failure),
//   letting the caller flag a per-endpoint error;
// - "lenient" endpoints resolve to [] on a non-ok response and only reject on
//   network/JSON failure (the caller swallows that rejection);
// - a non-array body resolves to null, meaning "leave existing state alone".

async function getArrayStrict<T>(url: string): Promise<T[] | null> {
  const r = await fetch(url);
  if (!r.ok) throw new Error();
  const data: unknown = await r.json();
  return Array.isArray(data) ? (data as T[]) : null;
}

async function getArrayLenient<T>(url: string): Promise<T[] | null> {
  const r = await fetch(url);
  const data: unknown = r.ok ? await r.json() : [];
  return Array.isArray(data) ? (data as T[]) : null;
}

export function fetchToolUsage(days: number): Promise<ToolUsage[] | null> {
  return getArrayStrict(`/api/analytics/tool-usage?days=${days}`);
}
export function fetchDailyCosts(days: number): Promise<DailyCost[] | null> {
  return getArrayStrict(`/api/analytics/daily-costs?days=${days}`);
}
export async function fetchTotals(days: number): Promise<AnalyticsTotals> {
  const r = await fetch(`/api/analytics/totals?days=${days}`);
  if (!r.ok) throw new Error();
  return (await r.json()) as AnalyticsTotals;
}
export function fetchActivityHeatmap(days: number): Promise<HeatmapDay[] | null> {
  return getArrayStrict(`/api/analytics/activity-heatmap?days=${days}`);
}
export function fetchSessionsPerDay(days: number): Promise<SessionsPerDay[] | null> {
  return getArrayStrict(`/api/analytics/sessions-per-day?days=${days}`);
}
export function fetchSessionDurations(days: number): Promise<DurationBucket[] | null> {
  return getArrayStrict(`/api/analytics/session-durations?days=${days}`);
}
export function fetchJiraStories(days: number): Promise<WeeklyCount[] | null> {
  return getArrayLenient(`/api/analytics/jira-stories?days=${days}`);
}
export function fetchPrsMerged(days: number): Promise<WeeklyCount[] | null> {
  return getArrayLenient(`/api/analytics/prs-merged?days=${days}`);
}
export function fetchContextInventory(days: number): Promise<ContextItem[] | null> {
  return getArrayLenient(`/api/analytics/context-inventory?days=${days}`);
}

// ── Phase 2 per-model fetchers ───────────────────────────────────────────────

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
export function fetchHeadroomStats(signal: AbortSignal): Promise<HeadroomStatsResponse> {
  return getJson(`/api/analytics/headroom-stats`, signal, EMPTY_HEADROOM_STATS);
}
