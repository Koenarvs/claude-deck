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
import { fmtCost, fmtTokens } from '../lib/format';

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
    const days = timeRangeToDays(timeRange);
    const qs = `?days=${days}`;
    Promise.all([
      fetch(`/api/analytics/tool-usage${qs}`).then((r) => (r.ok ? r.json() : [])),
      fetch(`/api/analytics/daily-costs${qs}`).then((r) => (r.ok ? r.json() : [])),
      fetch(`/api/analytics/totals${qs}`).then((r) => (r.ok ? r.json() : { sessions: 0, cost: 0, tokensIn: 0, tokensOut: 0 })),
      fetch(`/api/analytics/activity-heatmap${qs}`).then((r) => (r.ok ? r.json() : [])),
      fetch(`/api/analytics/sessions-per-day${qs}`).then((r) => (r.ok ? r.json() : [])),
      fetch(`/api/analytics/session-durations${qs}`).then((r) => (r.ok ? r.json() : [])),
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-6 w-6 text-accent" />
          <h1 className="text-2xl font-bold text-fg">Analytics</h1>
        </div>
        <TimeRangeSelector value={timeRange} onChange={setTimeRange} />
      </div>

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
          {dailyCosts.length > 0 ? (
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
          {sessionsPerDay.length > 0 ? (
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
          {categoryData.length > 0 ? (
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
          {durations.length > 0 ? (
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

// ── Helpers ─────────────────────────────────────────────────────────────────

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
