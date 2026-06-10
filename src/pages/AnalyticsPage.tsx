import React, { useEffect, useState } from 'react';
import { MemoryRouter, useSearchParams } from 'react-router';
import { BarChart3, Loader2, Calendar } from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
} from 'recharts';
import { fmtCost, fmtTokens } from '../lib/format';
import {
  fetchModelBreakdown, fetchModelMix, fetchProviderValue,
  fetchWindowUtilization, fetchCostPerGoal,
  type ModelBreakdownResponse, type ModelMixResponse, type ProviderValueResponse,
  type WindowUtilizationResponse, type CostPerGoalResponse,
} from '../lib/analytics-api';
import { resolveModel } from '../shared/agents/model-registry';

// ── Tool Category Taxonomy (from cc-lens) ──────────────────────────────────

const TOOL_CATEGORIES: Record<string, string> = {
  Read: 'file-io', Write: 'file-io', Edit: 'file-io', Glob: 'file-io', Grep: 'file-io', NotebookEdit: 'file-io',
  Bash: 'shell',
  Agent: 'agent', Task: 'agent', TaskCreate: 'agent', TaskUpdate: 'agent', TaskList: 'agent', TaskOutput: 'agent', TaskStop: 'agent', TaskGet: 'agent',
  WebSearch: 'web', WebFetch: 'web',
  EnterPlanMode: 'planning', ExitPlanMode: 'planning', AskUserQuestion: 'planning',
  TodoWrite: 'todo',
  Skill: 'skill', ToolSearch: 'skill', ListMcpResourcesTool: 'skill', ReadMcpResourceTool: 'skill',
};

const CATEGORY_LABELS: Record<string, string> = {
  'file-io': 'File I/O',
  'shell': 'Shell',
  'agent': 'Agents',
  'web': 'Web',
  'planning': 'Planning',
  'todo': 'Tasks',
  'skill': 'Skills',
  'mcp': 'MCP',
  'other': 'Other',
};

const CATEGORY_COLORS: Record<string, string> = {
  'file-io': '#43949B',
  'shell': '#D38235',
  'agent': '#51A443',
  'web': '#8B5CF6',
  'planning': '#EC4899',
  'todo': '#F59E0B',
  'skill': '#06B6D4',
  'mcp': '#1A6954',
  'other': '#6B7280',
};

function categorize(toolName: string): string {
  if (toolName.startsWith('mcp__')) return 'mcp';
  return TOOL_CATEGORIES[toolName] ?? 'other';
}

// ── Types ───────────────────────────────────────────────────────────────────

interface ToolUsage { name: string; count: number; }
interface DailyCost { date: string; cost: number; sessions: number; }
interface HeatmapDay { date: string; count: number; }
interface SessionsPerDay { date: string; sessions: number; dashboard: number; external: number; }
interface DurationBucket { bucket: string; count: number; }
interface WeeklyCount { date: string; count: number; }
interface ContextItem { name: string; type: string; usageCount: number; lastUsed: number | null; estimatedSize: number; }

type ContextFilter = 'all' | 'skill' | 'mcp' | 'plugin' | 'hook';
type TabId = 'analytics' | 'context';
type TimeRange = '7d' | '30d' | '90d' | 'all';

function timeRangeToDays(range: TimeRange): number {
  if (range === '7d') return 7;
  if (range === '30d') return 30;
  if (range === '90d') return 90;
  return 0;
}

function timeRangeLabel(range: TimeRange): string {
  if (range === '7d') return '7 days';
  if (range === '30d') return '30 days';
  if (range === '90d') return '90 days';
  return 'all time';
}

// ── Router Fallback ────────────────────────────────────────────────────────

class RouterFallback extends React.Component<
  { children: React.ReactNode },
  { needsRouter: boolean }
> {
  state = { needsRouter: false };
  static getDerivedStateFromError() { return { needsRouter: true }; }
  render() {
    if (this.state.needsRouter) {
      return <MemoryRouter>{this.props.children}</MemoryRouter>;
    }
    return this.props.children;
  }
}

export default function AnalyticsPage() {
  return (
    <RouterFallback>
      <AnalyticsPageContent />
    </RouterFallback>
  );
}

// ── Component ───────────────────────────────────────────────────────────────

function AnalyticsPageContent() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab: TabId = searchParams.get('tab') === 'context' ? 'context' : 'analytics';
  const setActiveTab = (tab: TabId) => setSearchParams({ tab }, { replace: true });
  const [toolUsage, setToolUsage] = useState<ToolUsage[]>([]);
  const [dailyCosts, setDailyCosts] = useState<DailyCost[]>([]);
  const [heatmap, setHeatmap] = useState<HeatmapDay[]>([]);
  const [sessionsPerDay, setSessionsPerDay] = useState<SessionsPerDay[]>([]);
  const [durations, setDurations] = useState<DurationBucket[]>([]);
  const [loading, setLoading] = useState(true);
  const [totals, setTotals] = useState({ sessions: 0, cost: 0, tokensIn: 0, tokensOut: 0 });
  const [timeRange, setTimeRange] = useState<TimeRange>('30d');
  const [errors, setErrors] = useState<Record<string, boolean>>({});
  const [jiraStories, setJiraStories] = useState<WeeklyCount[]>([]);
  const [prsMerged, setPrsMerged] = useState<WeeklyCount[]>([]);
  const [contextItems, setContextItems] = useState<ContextItem[]>([]);
  const [contextFilter, setContextFilter] = useState<ContextFilter>('all');
  // Phase 2 per-model analytics (loaded race-safe via AbortController below).
  const [modelBreakdown, setModelBreakdown] = useState<ModelBreakdownResponse>({ label: 'equivalent_value', models: [] });
  const [modelMix, setModelMix] = useState<ModelMixResponse>({ label: 'equivalent_value', series: [] });
  const [providerValue, setProviderValue] = useState<ProviderValueResponse>({ providers: [] });
  const [windowUtil, setWindowUtil] = useState<WindowUtilizationResponse>({ rows: [] });
  const [costPerGoal, setCostPerGoal] = useState<CostPerGoalResponse>({ label: 'equivalent_value', series: [] });

  useEffect(() => {
    setLoading(true);
    const days = timeRangeToDays(timeRange);
    const qs = `?days=${days}`;
    const errs: Record<string, boolean> = {};

    const fetches = [
      fetch(`/api/analytics/tool-usage${qs}`)
        .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
        .then((data) => { if (Array.isArray(data)) setToolUsage(data as ToolUsage[]); })
        .catch(() => { errs['tool-usage'] = true; }),
      fetch(`/api/analytics/daily-costs${qs}`)
        .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
        .then((data) => { if (Array.isArray(data)) setDailyCosts(data as DailyCost[]); })
        .catch(() => { errs['daily-costs'] = true; }),
      fetch(`/api/analytics/totals${qs}`)
        .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
        .then((data) => setTotals(data as typeof totals))
        .catch(() => { errs['totals'] = true; }),
      fetch(`/api/analytics/activity-heatmap${qs}`)
        .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
        .then((data) => { if (Array.isArray(data)) setHeatmap(data as HeatmapDay[]); })
        .catch(() => { errs['activity-heatmap'] = true; }),
      fetch(`/api/analytics/sessions-per-day${qs}`)
        .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
        .then((data) => { if (Array.isArray(data)) setSessionsPerDay(data as SessionsPerDay[]); })
        .catch(() => { errs['sessions-per-day'] = true; }),
      fetch(`/api/analytics/session-durations${qs}`)
        .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
        .then((data) => { if (Array.isArray(data)) setDurations(data as DurationBucket[]); })
        .catch(() => { errs['session-durations'] = true; }),
      fetch(`/api/analytics/jira-stories${qs}`)
        .then((r) => (r.ok ? r.json() : []))
        .then((data) => { if (Array.isArray(data)) setJiraStories(data as WeeklyCount[]); })
        .catch(() => {}),
      fetch(`/api/analytics/prs-merged${qs}`)
        .then((r) => (r.ok ? r.json() : []))
        .then((data) => { if (Array.isArray(data)) setPrsMerged(data as WeeklyCount[]); })
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
      fetch(`/api/analytics/context-inventory?days=${days}`)
        .then((r) => (r.ok ? r.json() : []))
        .then((data) => { if (Array.isArray(data)) setContextItems(data as ContextItem[]); })
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
    ]).catch(() => { /* helpers already fall back to defaults */ });
    return () => ctrl.abort();
  }, [timeRange]);

  // Categorize tools
  const categoryData = categorizeTools(toolUsage);

  const rangeLabel = timeRangeLabel(timeRange);
  const heatmapDayCount = timeRangeToDays(timeRange) || 90;

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-dim" />
      </div>
    );
  }

  const tabs: Array<{ id: TabId; label: string }> = [
    { id: 'analytics', label: 'Analytics' },
    { id: 'context', label: 'Context Management' },
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="flex-shrink-0 flex items-center justify-between pb-4">
        <div className="flex items-center gap-3">
          <BarChart3 className="h-6 w-6 text-accent" />
          <div className="flex gap-1">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
                  activeTab === tab.id
                    ? 'border-accent text-accent'
                    : 'border-transparent text-dim hover:text-fg'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
        <TimeRangeSelector value={timeRange} onChange={setTimeRange} />
      </div>

      <div className="flex-1 overflow-y-auto">
      {activeTab === 'analytics' && (
        <div className="space-y-6">
          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatBox label="Total Sessions" value={totals.sessions} />
            <StatBox label="Total Cost" value={fmtCost(totals.cost)} />
            <StatBox label="Tokens In" value={fmtTokens(totals.tokensIn)} />
            <StatBox label="Tokens Out" value={fmtTokens(totals.tokensOut)} />
          </div>

          {/* Activity Heatmap */}
          <div className="rounded-md border border-line bg-card p-4">
            <div className="mb-3 flex items-center gap-2">
              <Calendar size={16} className="text-dim" />
              <h2 className="text-sm font-medium text-dim">Activity ({rangeLabel})</h2>
            </div>
            <ActivityHeatmap data={heatmap} dayCount={heatmapDayCount} />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            {/* Daily cost chart */}
            <div className="rounded-md border border-line bg-card p-4">
              <h2 className="mb-4 text-sm font-medium text-dim">Daily Cost</h2>
              {errors['daily-costs'] ? (
                <ChartError />
              ) : dailyCosts.length > 0 ? (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={dailyCosts}>
                    <XAxis dataKey="date" tick={{ fill: 'var(--cd-faint)', fontSize: 10 }} />
                    <YAxis tick={{ fill: 'var(--cd-faint)', fontSize: 10 }} tickFormatter={(v: number) => `$${v}`} />
                    <Tooltip contentStyle={tooltipStyle} formatter={(value: number) => [fmtCost(value), 'Cost']} />
                    <Bar dataKey="cost" fill="var(--cd-accent)" radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <Empty text="No cost data yet" />
              )}
            </div>

            {/* Sessions per day trend */}
            <div className="rounded-md border border-line bg-card p-4">
              <h2 className="mb-4 text-sm font-medium text-dim">Sessions Per Day</h2>
              {errors['sessions-per-day'] ? (
                <ChartError />
              ) : sessionsPerDay.length > 0 ? (
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={sessionsPerDay}>
                    <XAxis dataKey="date" tick={{ fill: 'var(--cd-faint)', fontSize: 10 }} />
                    <YAxis tick={{ fill: 'var(--cd-faint)', fontSize: 10 }} />
                    <Tooltip contentStyle={tooltipStyle} />
                    <Line type="monotone" dataKey="sessions" stroke="var(--cd-accent)" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="dashboard" stroke="var(--cd-ok)" strokeWidth={1} dot={false} strokeDasharray="4 2" />
                    <Line type="monotone" dataKey="external" stroke="var(--cd-warn)" strokeWidth={1} dot={false} strokeDasharray="4 2" />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <Empty text="No session data yet" />
              )}
            </div>

            {/* Tool usage by category */}
            <div className="rounded-md border border-line bg-card p-4">
              <h2 className="mb-4 text-sm font-medium text-dim">Tool Usage by Category</h2>
              {errors['tool-usage'] ? (
                <ChartError />
              ) : categoryData.length > 0 ? (
                <div className="space-y-2">
                  {categoryData.map((cat) => (
                    <div key={cat.category} className="flex items-center gap-3">
                      <span className="w-16 text-right text-xs text-dim">{cat.label}</span>
                      <div className="flex-1 h-6 bg-inset rounded overflow-hidden">
                        <div
                          className="h-full rounded transition-all"
                          style={{
                            width: `${(cat.count / Math.max(...categoryData.map((c) => c.count))) * 100}%`,
                            backgroundColor: cat.color,
                          }}
                        />
                      </div>
                      <span className="w-10 text-right mono-tabular text-[10px] text-faint">{cat.count}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty text="No tool usage data yet" />
              )}
            </div>

            {/* Session duration distribution */}
            <div className="rounded-md border border-line bg-card p-4">
              <h2 className="mb-4 text-sm font-medium text-dim">Session Duration Distribution</h2>
              {errors['session-durations'] ? (
                <ChartError />
              ) : durations.length > 0 ? (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={durations}>
                    <XAxis dataKey="bucket" tick={{ fill: 'var(--cd-faint)', fontSize: 11 }} />
                    <YAxis tick={{ fill: 'var(--cd-faint)', fontSize: 10 }} />
                    <Tooltip contentStyle={tooltipStyle} />
                    <Bar dataKey="count" fill="var(--cd-info)" radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <Empty text="No completed sessions yet" />
              )}
            </div>
          </div>

          {/* Model Breakdown */}
          <div className="rounded-md border border-line bg-card p-4">
            <h2 className="mb-4 text-sm font-medium text-dim">Model Breakdown</h2>
            {modelBreakdown.models.length > 0 ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-dim">
                    <th className="px-3 py-2 font-medium">Model</th>
                    <th className="px-3 py-2 font-medium">Tier</th>
                    <th className="px-3 py-2 font-medium">Tokens In</th>
                    <th className="px-3 py-2 font-medium">Tokens Out</th>
                    <th className="px-3 py-2 font-medium">
                      {modelBreakdown.label === 'cost' ? 'Cost' : 'Equivalent $'}
                    </th>
                    <th className="px-3 py-2 font-medium">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {modelBreakdown.models.map((m) => (
                    <tr key={m.model} className={`border-b border-line last:border-0 ${m.unpriced ? 'opacity-70' : ''}`}>
                      <td className="px-3 py-2 text-fg">
                        {m.model}
                        {m.unpriced && (
                          <span className="ml-2 rounded-sm bg-inset px-1.5 py-0.5 text-[10px] text-faint" data-testid="unpriced-badge">
                            unpriced
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-dim">{m.tier}</td>
                      <td className="px-3 py-2 mono-tabular text-fg">{fmtTokens(m.tokensIn)}</td>
                      <td className="px-3 py-2 mono-tabular text-fg">{fmtTokens(m.tokensOut)}</td>
                      <td className="px-3 py-2 mono-tabular text-fg">{m.unpriced ? '—' : fmtCost(m.equivalentUsd)}</td>
                      <td className="px-3 py-2 mono-tabular text-dim">{Math.round(m.share * 100)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty text="No per-model usage yet" />
            )}
          </div>

          {/* Model Mix + top-tier-share */}
          <div className="rounded-md border border-line bg-card p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-medium text-dim">Model Mix</h2>
              <span className="text-xs text-dim">
                top-tier share (latest):{' '}
                <span className="mono-tabular text-fg">
                  {modelMix.series.length > 0
                    ? `${Math.round(modelMix.series[modelMix.series.length - 1].topTierShare * 100)}%`
                    : '—'}
                </span>
              </span>
            </div>
            {modelMix.series.length > 0 ? (
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={modelMix.series.map((b) => ({ date: b.date, topTier: Math.round(b.topTierShare * 100) }))}>
                  <XAxis dataKey="date" tick={{ fill: 'var(--cd-faint)', fontSize: 10 }} />
                  <YAxis tick={{ fill: 'var(--cd-faint)', fontSize: 10 }} tickFormatter={(v: number) => `${v}%`} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [`${v}%`, 'Top-tier share']} />
                  <Line type="monotone" dataKey="topTier" stroke="var(--cd-accent)" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <Empty text="No model mix data yet" />
            )}
          </div>

          {/* Subscription Value (seat providers) */}
          {providerValue.providers.some((p) => p.label === 'equivalent_value') && (
            <div className="rounded-md border border-line bg-card p-4">
              <h2 className="mb-4 text-sm font-medium text-dim">Subscription Value</h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {providerValue.providers.filter((p) => p.label === 'equivalent_value').map((p) => (
                  <div key={p.provider} className="rounded-md border border-line bg-inset p-4">
                    <p className="text-xs text-dim capitalize">{p.provider}</p>
                    <p className="mt-1 mono-tabular text-2xl font-bold text-fg">
                      {p.valueMultiplier ? `${p.valueMultiplier}x` : '—'}
                    </p>
                    <p className="mt-1 text-xs text-dim">
                      {fmtCost(p.equivalentUsd)} value{p.seatPriceUsdMonthly ? ` / ${fmtCost(p.seatPriceUsdMonthly)}/mo` : ''}
                    </p>
                    <p className="mt-2 text-[10px] text-faint" title="Replacement value: what the same tokens would cost at metered API rates. Overstates somewhat at zero marginal cost.">
                      replacement value — overstates at zero marginal cost
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Window Utilization (seat only, estimate) */}
          {windowUtil.rows.length > 0 && (
            <div className="rounded-md border border-line bg-card p-4">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-sm font-medium text-dim">Window Utilization</h2>
                <span className="rounded-sm bg-inset px-1.5 py-0.5 text-[10px] text-faint">estimate</span>
              </div>
              <div className="space-y-3">
                {windowUtil.rows.map((r) => (
                  <div key={r.provider} className="flex items-center gap-3">
                    <span className="w-24 text-xs text-dim capitalize">{r.provider}</span>
                    <div className="flex-1 h-4 bg-inset rounded overflow-hidden">
                      <div className="h-full rounded bg-accent transition-all" style={{ width: `${Math.min(100, r.utilizationPct)}%` }} />
                    </div>
                    <span className="w-12 text-right mono-tabular text-xs text-fg">{r.utilizationPct}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Budget vs Spend (metered providers — work profile) */}
          {providerValue.providers.some((p) => p.label === 'cost') && (
            <div className="rounded-md border border-line bg-card p-4">
              <h2 className="mb-4 text-sm font-medium text-dim">Budget vs Spend</h2>
              <div className="space-y-3">
                {providerValue.providers.filter((p) => p.label === 'cost').map((p) => {
                  const pct = p.budgetUsd && p.budgetUsd > 0 ? Math.min(100, (p.equivalentUsd / p.budgetUsd) * 100) : 0;
                  const over = p.budgetUsd !== undefined && p.equivalentUsd > p.budgetUsd;
                  return (
                    <div key={p.provider} className="flex items-center gap-3">
                      <span className="w-24 text-xs text-dim capitalize">{p.provider}</span>
                      <div className="flex-1 h-4 bg-inset rounded overflow-hidden">
                        <div className="h-full rounded transition-all" style={{ width: `${pct}%`, backgroundColor: over ? 'var(--cd-warn)' : 'var(--cd-ok)' }} />
                      </div>
                      <span className="w-28 text-right mono-tabular text-xs text-fg">
                        {fmtCost(p.equivalentUsd)}{p.budgetUsd !== undefined ? ` / ${fmtCost(p.budgetUsd)}` : ''}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Model Scorecard */}
          {modelBreakdown.models.length > 0 && (
            <div className="rounded-md border border-line bg-card p-4">
              <h2 className="mb-1 text-sm font-medium text-dim">Model Scorecard</h2>
              <p className="mb-3 text-[10px] text-faint">
                Verification pass/fail lands with the Phase 5 verification gate; columns below are cost/speed/quota only.
              </p>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-dim">
                    <th className="px-3 py-2 font-medium">Model</th>
                    <th className="px-3 py-2 font-medium">Tier</th>
                    <th className="px-3 py-2 font-medium">Eff. $/MTok</th>
                    <th className="px-3 py-2 font-medium">Quota Weight</th>
                    <th className="px-3 py-2 font-medium">Verification</th>
                  </tr>
                </thead>
                <tbody>
                  {modelBreakdown.models.map((m) => {
                    const entry = resolveModel(m.model);
                    return (
                      <tr key={m.model} className="border-b border-line last:border-0">
                        <td className="px-3 py-2 text-fg">{m.model}</td>
                        <td className="px-3 py-2 text-dim">{m.tier}</td>
                        <td className="px-3 py-2 mono-tabular text-fg">{m.unpriced ? '—' : `$${m.effectiveRatePerMTok.toFixed(2)}`}</td>
                        <td className="px-3 py-2 mono-tabular text-dim">{entry?.quotaWeight ?? '—'}</td>
                        <td className="px-3 py-2 text-faint">—</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Cost per Completed Goal */}
          {costPerGoal.series.length > 0 && (
            <div className="rounded-md border border-line bg-card p-4">
              <h2 className="mb-4 text-sm font-medium text-dim">
                {costPerGoal.label === 'cost' ? 'Cost' : 'Equivalent $'} per Completed Goal
              </h2>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={costPerGoal.series.map((p) => ({ date: p.date, usd: p.equivalentUsdPerGoal }))}>
                  <XAxis dataKey="date" tick={{ fill: 'var(--cd-faint)', fontSize: 10 }} />
                  <YAxis tick={{ fill: 'var(--cd-faint)', fontSize: 10 }} tickFormatter={(v: number) => `$${v}`} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [fmtCost(v), 'Per goal']} />
                  <Line type="monotone" dataKey="usd" stroke="var(--cd-accent)" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Output Trends */}
          <div className="rounded-md border border-line bg-card p-4">
            <h2 className="mb-4 text-sm font-medium text-dim">Output Trends</h2>
            {jiraStories.length > 0 || prsMerged.length > 0 ? (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={mergeOutputTrends(jiraStories, prsMerged)}>
                  <XAxis dataKey="date" tick={{ fill: 'var(--cd-faint)', fontSize: 10 }} />
                  <YAxis tick={{ fill: 'var(--cd-faint)', fontSize: 10 }} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="stories" name="Jira Stories" fill="var(--cd-accent)" radius={[2, 2, 0, 0]} />
                  <Bar dataKey="prs" name="PRs Merged" fill="var(--cd-ok)" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <Empty text="No output data available" />
            )}
          </div>
        </div>
      )}

      {activeTab === 'context' && (
        <div className="space-y-6">
          <ContextTab items={contextItems} filter={contextFilter} onFilterChange={setContextFilter} />
        </div>
      )}
      </div>
    </div>
  );
}

// ── Subcomponents ───────────────────────────────────────────────────────────

const tooltipStyle = { backgroundColor: 'var(--cd-card)', border: '1px solid var(--cd-line)', color: 'var(--cd-fg)' };

function TimeRangeSelector({ value, onChange }: { value: TimeRange; onChange: (v: TimeRange) => void }) {
  const options: { value: TimeRange; label: string }[] = [
    { value: '7d', label: '7 days' },
    { value: '30d', label: '30 days' },
    { value: '90d', label: '90 days' },
    { value: 'all', label: 'All time' },
  ];
  return (
    <div className="flex gap-1 rounded-md border border-line p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`rounded-sm px-3 py-1 text-xs font-medium transition-colors ${
            value === opt.value
              ? 'bg-accent text-accent-fg'
              : 'text-dim hover:text-fg'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function ActivityHeatmap({ data, dayCount }: { data: HeatmapDay[]; dayCount: number }) {
  const today = new Date();
  const days: { date: string; count: number; dayOfWeek: number }[] = [];
  const countMap = new Map(data.map((d) => [d.date, d.count]));

  for (let i = dayCount - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    days.push({ date: dateStr, count: countMap.get(dateStr) ?? 0, dayOfWeek: d.getDay() });
  }

  const maxCount = Math.max(1, ...days.map((d) => d.count));

  function intensity(count: number): string {
    if (count === 0) return 'bg-inset';
    const ratio = count / maxCount;
    if (ratio <= 0.25) return 'bg-accent/20';
    if (ratio <= 0.5) return 'bg-accent/40';
    if (ratio <= 0.75) return 'bg-accent/70';
    return 'bg-accent';
  }

  // Group into weeks
  const weeks: typeof days[] = [];
  let currentWeek: typeof days = [];
  for (const day of days) {
    if (day.dayOfWeek === 0 && currentWeek.length > 0) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
    currentWeek.push(day);
  }
  if (currentWeek.length > 0) weeks.push(currentWeek);

  return (
    <div className="flex gap-1 overflow-x-auto">
      {weeks.map((week, wi) => (
        <div key={wi} className="flex flex-col gap-1">
          {week.map((day) => (
            <div
              key={day.date}
              className={`h-3 w-3 rounded-sm ${intensity(day.count)}`}
              title={`${day.date}: ${day.count} session${day.count !== 1 ? 's' : ''}`}
            />
          ))}
        </div>
      ))}
      <div className="ml-2 flex items-end gap-1 text-[10px] text-faint">
        <span>Less</span>
        <div className="h-3 w-3 rounded-sm bg-inset" />
        <div className="h-3 w-3 rounded-sm bg-accent/20" />
        <div className="h-3 w-3 rounded-sm bg-accent/40" />
        <div className="h-3 w-3 rounded-sm bg-accent/70" />
        <div className="h-3 w-3 rounded-sm bg-accent" />
        <span>More</span>
      </div>
    </div>
  );
}

function StatBox({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-line bg-card p-4">
      <p className="text-xs text-dim">{label}</p>
      <p className="mt-1 mono-tabular text-xl font-bold text-fg">{value}</p>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="py-8 text-center text-sm text-faint">{text}</p>;
}

function ChartError() {
  return <p data-testid="chart-error" className="py-8 text-center text-sm text-red-500">Failed to load data</p>;
}

const CONTEXT_FILTERS: Array<{ value: ContextFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'skill', label: 'Skills' },
  { value: 'mcp', label: 'MCP' },
  { value: 'plugin', label: 'Plugins' },
  { value: 'hook', label: 'Hooks' },
];

function ContextTab({ items, filter, onFilterChange }: { items: ContextItem[]; filter: ContextFilter; onFilterChange: (f: ContextFilter) => void }) {
  const filtered = filter === 'all' ? items : items.filter((i) => i.type === filter);
  const sorted = [...filtered].sort((a, b) => b.usageCount - a.usageCount);
  const totalSize = items.reduce((sum, i) => sum + i.estimatedSize, 0);

  return (
    <>
      <div className="flex items-center justify-between">
        <p className="text-sm text-dim">{items.length} items, {formatSize(totalSize)} total</p>
        <div className="flex gap-1 rounded-md border border-line p-0.5">
          {CONTEXT_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => onFilterChange(f.value)}
              className={`rounded-sm px-3 py-1 text-xs font-medium transition-colors ${
                filter === f.value
                  ? 'bg-accent text-accent-fg'
                  : 'text-dim hover:text-fg'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-md border border-line bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-dim">
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Type</th>
              <th className="px-4 py-2 font-medium">Usage Count</th>
              <th className="px-4 py-2 font-medium">Last Used</th>
              <th className="px-4 py-2 font-medium">Est. Size</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((item) => (
              <tr
                key={`${item.type}-${item.name}`}
                className={`border-b border-line last:border-0 ${item.usageCount === 0 ? 'opacity-50' : ''}`}
                {...(item.usageCount === 0 ? { 'data-zero-usage': '' } : {})}
              >
                <td className="px-4 py-2 text-fg">{item.name}</td>
                <td className="px-4 py-2 text-dim">{item.type}</td>
                <td className="px-4 py-2 mono-tabular text-fg">{item.usageCount}</td>
                <td className="px-4 py-2 text-dim">{item.lastUsed ? formatRelativeTime(item.lastUsed) : '–'}</td>
                <td className="px-4 py-2 mono-tabular text-dim">{formatSize(item.estimatedSize)}</td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr><td colSpan={5}><Empty text="No items found" /></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatSize(chars: number): string {
  if (chars === 0) return '0';
  if (chars < 1000) return `${chars}`;
  return `${(chars / 1000).toFixed(1)}K`;
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function mergeOutputTrends(stories: WeeklyCount[], prs: WeeklyCount[]): Array<{ date: string; stories: number; prs: number }> {
  const map = new Map<string, { stories: number; prs: number }>();
  for (const s of stories) map.set(s.date, { stories: s.count, prs: 0 });
  for (const p of prs) {
    const existing = map.get(p.date) ?? { stories: 0, prs: 0 };
    existing.prs = p.count;
    map.set(p.date, existing);
  }
  return [...map.entries()]
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function categorizeTools(tools: ToolUsage[]): Array<{ category: string; label: string; color: string; count: number }> {
  const cats = new Map<string, number>();
  for (const t of tools) {
    const cat = categorize(t.name);
    cats.set(cat, (cats.get(cat) ?? 0) + t.count);
  }
  return [...cats.entries()]
    .map(([category, count]) => ({
      category,
      label: CATEGORY_LABELS[category] ?? category,
      color: CATEGORY_COLORS[category] ?? '#6B7280',
      count,
    }))
    .sort((a, b) => b.count - a.count);
}
