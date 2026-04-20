import { useEffect, useState } from 'react';
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

type TimeRange = '7d' | '30d' | '90d' | 'all';

// ── Component ───────────────────────────────────────────────────────────────

export default function AnalyticsPage() {
  const [toolUsage, setToolUsage] = useState<ToolUsage[]>([]);
  const [dailyCosts, setDailyCosts] = useState<DailyCost[]>([]);
  const [heatmap, setHeatmap] = useState<HeatmapDay[]>([]);
  const [sessionsPerDay, setSessionsPerDay] = useState<SessionsPerDay[]>([]);
  const [durations, setDurations] = useState<DurationBucket[]>([]);
  const [loading, setLoading] = useState(true);
  const [totals, setTotals] = useState({ sessions: 0, cost: 0, tokensIn: 0, tokensOut: 0 });
  const [timeRange, setTimeRange] = useState<TimeRange>('30d');

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch('/api/analytics/tool-usage').then((r) => (r.ok ? r.json() : [])),
      fetch('/api/analytics/daily-costs').then((r) => (r.ok ? r.json() : [])),
      fetch('/api/analytics/totals').then((r) => (r.ok ? r.json() : { sessions: 0, cost: 0, tokensIn: 0, tokensOut: 0 })),
      fetch('/api/analytics/activity-heatmap').then((r) => (r.ok ? r.json() : [])),
      fetch('/api/analytics/sessions-per-day').then((r) => (r.ok ? r.json() : [])),
      fetch('/api/analytics/session-durations').then((r) => (r.ok ? r.json() : [])),
    ])
      .then(([tools, costs, tots, heat, spd, dur]) => {
        if (Array.isArray(tools)) setToolUsage(tools as ToolUsage[]);
        if (Array.isArray(costs)) setDailyCosts(costs as DailyCost[]);
        setTotals(tots as typeof totals);
        if (Array.isArray(heat)) setHeatmap(heat as HeatmapDay[]);
        if (Array.isArray(spd)) setSessionsPerDay(spd as SessionsPerDay[]);
        if (Array.isArray(dur)) setDurations(dur as DurationBucket[]);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Filter costs by time range
  const filteredCosts = filterByRange(dailyCosts, timeRange);

  // Categorize tools
  const categoryData = categorizeTools(toolUsage);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-deck-muted" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-6 w-6 text-deck-accent" />
          <h1 className="text-2xl font-bold text-deck-text">Analytics</h1>
        </div>
        <TimeRangeSelector value={timeRange} onChange={setTimeRange} />
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatBox label="Total Sessions" value={totals.sessions} />
        <StatBox label="Total Cost" value={`$${totals.cost.toFixed(2)}`} />
        <StatBox label="Tokens In" value={formatNumber(totals.tokensIn)} />
        <StatBox label="Tokens Out" value={formatNumber(totals.tokensOut)} />
      </div>

      {/* Activity Heatmap */}
      <div className="rounded-lg border border-deck-border bg-deck-surface p-4">
        <div className="mb-3 flex items-center gap-2">
          <Calendar size={16} className="text-deck-muted" />
          <h2 className="text-sm font-medium text-deck-muted">Activity (90 days)</h2>
        </div>
        <ActivityHeatmap data={heatmap} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Daily cost chart */}
        <div className="rounded-lg border border-deck-border bg-deck-surface p-4">
          <h2 className="mb-4 text-sm font-medium text-deck-muted">Daily Cost</h2>
          {filteredCosts.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={filteredCosts}>
                <XAxis dataKey="date" tick={{ fill: '#9ca3af', fontSize: 10 }} />
                <YAxis tick={{ fill: '#9ca3af', fontSize: 10 }} tickFormatter={(v: number) => `$${v}`} />
                <Tooltip contentStyle={tooltipStyle} formatter={(value: number) => [`$${value.toFixed(4)}`, 'Cost']} />
                <Bar dataKey="cost" fill="#43949B" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <Empty text="No cost data yet" />
          )}
        </div>

        {/* Sessions per day trend */}
        <div className="rounded-lg border border-deck-border bg-deck-surface p-4">
          <h2 className="mb-4 text-sm font-medium text-deck-muted">Sessions Per Day</h2>
          {sessionsPerDay.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={sessionsPerDay}>
                <XAxis dataKey="date" tick={{ fill: '#9ca3af', fontSize: 10 }} />
                <YAxis tick={{ fill: '#9ca3af', fontSize: 10 }} />
                <Tooltip contentStyle={tooltipStyle} />
                <Line type="monotone" dataKey="sessions" stroke="#43949B" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="dashboard" stroke="#51A443" strokeWidth={1} dot={false} strokeDasharray="4 2" />
                <Line type="monotone" dataKey="external" stroke="#D38235" strokeWidth={1} dot={false} strokeDasharray="4 2" />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <Empty text="No session data yet" />
          )}
        </div>

        {/* Tool usage by category */}
        <div className="rounded-lg border border-deck-border bg-deck-surface p-4">
          <h2 className="mb-4 text-sm font-medium text-deck-muted">Tool Usage by Category</h2>
          {categoryData.length > 0 ? (
            <div className="space-y-2">
              {categoryData.map((cat) => (
                <div key={cat.category} className="flex items-center gap-3">
                  <span className="w-16 text-right text-xs text-deck-muted">{cat.label}</span>
                  <div className="flex-1 h-6 bg-deck-bg rounded overflow-hidden">
                    <div
                      className="h-full rounded transition-all"
                      style={{
                        width: `${(cat.count / Math.max(...categoryData.map((c) => c.count))) * 100}%`,
                        backgroundColor: cat.color,
                      }}
                    />
                  </div>
                  <span className="w-10 text-right text-xs font-mono text-deck-muted">{cat.count}</span>
                </div>
              ))}
            </div>
          ) : (
            <Empty text="No tool usage data yet" />
          )}
        </div>

        {/* Session duration distribution */}
        <div className="rounded-lg border border-deck-border bg-deck-surface p-4">
          <h2 className="mb-4 text-sm font-medium text-deck-muted">Session Duration Distribution</h2>
          {durations.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={durations}>
                <XAxis dataKey="bucket" tick={{ fill: '#9ca3af', fontSize: 11 }} />
                <YAxis tick={{ fill: '#9ca3af', fontSize: 10 }} />
                <Tooltip contentStyle={tooltipStyle} />
                <Bar dataKey="count" fill="#8B5CF6" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <Empty text="No completed sessions yet" />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Subcomponents ───────────────────────────────────────────────────────────

const tooltipStyle = { backgroundColor: '#1e293b', border: '1px solid #334155', color: '#e2e8f0' };

function TimeRangeSelector({ value, onChange }: { value: TimeRange; onChange: (v: TimeRange) => void }) {
  const options: { value: TimeRange; label: string }[] = [
    { value: '7d', label: '7 days' },
    { value: '30d', label: '30 days' },
    { value: '90d', label: '90 days' },
    { value: 'all', label: 'All time' },
  ];
  return (
    <div className="flex gap-1 rounded-lg border border-deck-border p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
            value === opt.value
              ? 'bg-deck-accent text-white'
              : 'text-deck-muted hover:text-deck-text'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function ActivityHeatmap({ data }: { data: HeatmapDay[] }) {
  // Build 90-day grid
  const today = new Date();
  const days: { date: string; count: number; dayOfWeek: number }[] = [];
  const countMap = new Map(data.map((d) => [d.date, d.count]));

  for (let i = 89; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    days.push({ date: dateStr, count: countMap.get(dateStr) ?? 0, dayOfWeek: d.getDay() });
  }

  const maxCount = Math.max(1, ...days.map((d) => d.count));

  function intensity(count: number): string {
    if (count === 0) return 'bg-deck-bg';
    const ratio = count / maxCount;
    if (ratio <= 0.25) return 'bg-deck-accent/20';
    if (ratio <= 0.5) return 'bg-deck-accent/40';
    if (ratio <= 0.75) return 'bg-deck-accent/70';
    return 'bg-deck-accent';
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
      <div className="ml-2 flex items-end gap-1 text-[10px] text-deck-muted">
        <span>Less</span>
        <div className="h-3 w-3 rounded-sm bg-deck-bg" />
        <div className="h-3 w-3 rounded-sm bg-deck-accent/20" />
        <div className="h-3 w-3 rounded-sm bg-deck-accent/40" />
        <div className="h-3 w-3 rounded-sm bg-deck-accent/70" />
        <div className="h-3 w-3 rounded-sm bg-deck-accent" />
        <span>More</span>
      </div>
    </div>
  );
}

function StatBox({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-deck-border bg-deck-surface p-4">
      <p className="text-xs text-deck-muted">{label}</p>
      <p className="mt-1 text-xl font-bold text-deck-text">{value}</p>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="py-8 text-center text-sm text-deck-muted">{text}</p>;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function filterByRange(data: DailyCost[], range: TimeRange): DailyCost[] {
  if (range === 'all') return data;
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  return data.filter((d) => d.date >= cutoffStr);
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
