import { useEffect, useState } from 'react';
import {
  fetchToolUsage, fetchDailyCosts, fetchTotals, fetchActivityHeatmap,
  fetchSessionsPerDay, fetchSessionDurations, fetchJiraStories, fetchPrsMerged,
  fetchContextInventory,
  fetchModelBreakdown, fetchModelMix, fetchProviderValue,
  fetchWindowUtilization, fetchCostPerGoal, fetchHeadroomStats,
  EMPTY_HEADROOM_STATS,
} from '../lib/analytics-api';
import type {
  ToolUsage, DailyCost, HeatmapDay, SessionsPerDay, DurationBucket,
  WeeklyCount, ContextItem, AnalyticsTotals,
  ModelBreakdownResponse, ModelMixResponse, ProviderValueResponse,
  WindowUtilizationResponse, CostPerGoalResponse, HeadroomStatsResponse,
} from '../lib/analytics-api';

export type TabId = 'analytics' | 'context';
export type TimeRange = '7d' | '30d' | '90d' | 'all';

export function timeRangeToDays(range: TimeRange): number {
  if (range === '7d') return 7;
  if (range === '30d') return 30;
  if (range === '90d') return 90;
  return 0;
}

export function timeRangeLabel(range: TimeRange): string {
  if (range === '7d') return '7 days';
  if (range === '30d') return '30 days';
  if (range === '90d') return '90 days';
  return 'all time';
}

export interface AnalyticsData {
  loading: boolean;
  errors: Record<string, boolean>;
  totals: AnalyticsTotals;
  toolUsage: ToolUsage[];
  dailyCosts: DailyCost[];
  heatmap: HeatmapDay[];
  sessionsPerDay: SessionsPerDay[];
  durations: DurationBucket[];
  jiraStories: WeeklyCount[];
  prsMerged: WeeklyCount[];
  contextItems: ContextItem[];
  modelBreakdown: ModelBreakdownResponse;
  modelMix: ModelMixResponse;
  providerValue: ProviderValueResponse;
  windowUtil: WindowUtilizationResponse;
  costPerGoal: CostPerGoalResponse;
  headroomStats: HeadroomStatsResponse;
}

// Owns all analytics data fetching for the AnalyticsPage. Refetch triggers:
// - core endpoints + per-model endpoints refetch when `timeRange` changes;
// - the context inventory is fetched lazily, only while the Context Management
//   tab is active (and refetched when the time range changes).
export function useAnalyticsData(timeRange: TimeRange, activeTab: TabId): AnalyticsData {
  const [toolUsage, setToolUsage] = useState<ToolUsage[]>([]);
  const [dailyCosts, setDailyCosts] = useState<DailyCost[]>([]);
  const [heatmap, setHeatmap] = useState<HeatmapDay[]>([]);
  const [sessionsPerDay, setSessionsPerDay] = useState<SessionsPerDay[]>([]);
  const [durations, setDurations] = useState<DurationBucket[]>([]);
  const [loading, setLoading] = useState(true);
  const [totals, setTotals] = useState<AnalyticsTotals>({ sessions: 0, cost: 0, tokensIn: 0, tokensOut: 0 });
  const [errors, setErrors] = useState<Record<string, boolean>>({});
  const [jiraStories, setJiraStories] = useState<WeeklyCount[]>([]);
  const [prsMerged, setPrsMerged] = useState<WeeklyCount[]>([]);
  const [contextItems, setContextItems] = useState<ContextItem[]>([]);
  // Phase 2 per-model analytics state (fetched via the race-safe AbortController effect below).
  const [modelBreakdown, setModelBreakdown] = useState<ModelBreakdownResponse>({ label: 'equivalent_value', models: [] });
  const [modelMix, setModelMix] = useState<ModelMixResponse>({ label: 'equivalent_value', series: [] });
  const [providerValue, setProviderValue] = useState<ProviderValueResponse>({ providers: [] });
  const [windowUtil, setWindowUtil] = useState<WindowUtilizationResponse>({ rows: [] });
  const [costPerGoal, setCostPerGoal] = useState<CostPerGoalResponse>({ label: 'equivalent_value', series: [] });
  const [headroomStats, setHeadroomStats] = useState<HeadroomStatsResponse>(EMPTY_HEADROOM_STATS);

  useEffect(() => {
    setLoading(true);
    const days = timeRangeToDays(timeRange);
    const errs: Record<string, boolean> = {};

    const fetches = [
      fetchToolUsage(days)
        .then((data) => { if (data) setToolUsage(data); })
        .catch(() => { errs['tool-usage'] = true; }),
      fetchDailyCosts(days)
        .then((data) => { if (data) setDailyCosts(data); })
        .catch(() => { errs['daily-costs'] = true; }),
      fetchTotals(days)
        .then((data) => setTotals(data))
        .catch(() => { errs['totals'] = true; }),
      fetchActivityHeatmap(days)
        .then((data) => { if (data) setHeatmap(data); })
        .catch(() => { errs['activity-heatmap'] = true; }),
      fetchSessionsPerDay(days)
        .then((data) => { if (data) setSessionsPerDay(data); })
        .catch(() => { errs['sessions-per-day'] = true; }),
      fetchSessionDurations(days)
        .then((data) => { if (data) setDurations(data); })
        .catch(() => { errs['session-durations'] = true; }),
      fetchJiraStories(days)
        .then((data) => { if (data) setJiraStories(data); })
        .catch(() => {}),
      fetchPrsMerged(days)
        .then((data) => { if (data) setPrsMerged(data); })
        .catch(() => {}),
    ];

    Promise.all(fetches).then(() => {
      setErrors(errs);
      setLoading(false);
    });
  }, [timeRange]);

  useEffect(() => {
    if (activeTab === 'context') {
      const days = timeRangeToDays(timeRange);
      fetchContextInventory(days)
        .then((data) => { if (data) setContextItems(data); })
        .catch(() => {});
    }
  }, [activeTab, timeRange]);

  // Per-model analytics, race-safe: a single AbortController aborted on cleanup so
  // a stale time-range's responses are discarded.
  useEffect(() => {
    const ctrl = new AbortController();
    const days = timeRangeToDays(timeRange);
    Promise.all([
      fetchModelBreakdown(days, ctrl.signal).then(setModelBreakdown),
      fetchModelMix(days, ctrl.signal).then(setModelMix),
      fetchProviderValue(days, ctrl.signal).then(setProviderValue),
      fetchWindowUtilization(ctrl.signal).then(setWindowUtil),
      fetchCostPerGoal(days, ctrl.signal).then(setCostPerGoal),
      fetchHeadroomStats(ctrl.signal).then(setHeadroomStats),
    ]).catch(() => { /* helpers already fall back to defaults */ });
    return () => ctrl.abort();
  }, [timeRange]);

  return {
    loading, errors, totals, toolUsage, dailyCosts, heatmap, sessionsPerDay,
    durations, jiraStories, prsMerged, contextItems,
    modelBreakdown, modelMix, providerValue, windowUtil, costPerGoal, headroomStats,
  };
}
