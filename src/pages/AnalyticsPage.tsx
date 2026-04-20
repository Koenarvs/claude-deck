import { useEffect, useState } from 'react';
import { BarChart3, Loader2 } from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from 'recharts';

interface ToolUsage {
  name: string;
  count: number;
}

interface DailyCost {
  date: string;
  cost: number;
  sessions: number;
}

const COLORS = ['#43949B', '#51A443', '#D38235', '#D32F2F', '#253746', '#1A6954'];

export default function AnalyticsPage() {
  const [toolUsage, setToolUsage] = useState<ToolUsage[]>([]);
  const [dailyCosts, setDailyCosts] = useState<DailyCost[]>([]);
  const [loading, setLoading] = useState(true);
  const [totals, setTotals] = useState({ sessions: 0, cost: 0, tokensIn: 0, tokensOut: 0 });

  useEffect(() => {
    Promise.all([
      fetch('/api/analytics/tool-usage').then((r) => (r.ok ? r.json() : [])),
      fetch('/api/analytics/daily-costs').then((r) => (r.ok ? r.json() : [])),
      fetch('/api/analytics/totals').then((r) => (r.ok ? r.json() : { sessions: 0, cost: 0, tokensIn: 0, tokensOut: 0 })),
    ])
      .then(([tools, costs, tots]) => {
        if (Array.isArray(tools)) setToolUsage(tools as ToolUsage[]);
        if (Array.isArray(costs)) setDailyCosts(costs as DailyCost[]);
        setTotals(tots as typeof totals);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-deck-muted" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <BarChart3 className="h-6 w-6 text-deck-accent" />
        <h1 className="text-2xl font-bold text-deck-text">Analytics</h1>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatBox label="Total Sessions" value={totals.sessions} />
        <StatBox label="Total Cost" value={`$${totals.cost.toFixed(2)}`} />
        <StatBox label="Tokens In" value={formatNumber(totals.tokensIn)} />
        <StatBox label="Tokens Out" value={formatNumber(totals.tokensOut)} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Daily cost chart */}
        <div className="rounded-lg border border-deck-border bg-deck-surface p-4">
          <h2 className="mb-4 text-sm font-medium text-deck-muted">Daily Cost (30 days)</h2>
          {dailyCosts.length > 0 ? (
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={dailyCosts}>
                <XAxis dataKey="date" tick={{ fill: '#9ca3af', fontSize: 10 }} />
                <YAxis tick={{ fill: '#9ca3af', fontSize: 10 }} tickFormatter={(v: number) => `$${v}`} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', color: '#e2e8f0' }}
                  formatter={(value: number) => [`$${value.toFixed(4)}`, 'Cost']}
                />
                <Bar dataKey="cost" fill="#43949B" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className="py-8 text-center text-sm text-deck-muted">No cost data yet</p>
          )}
        </div>

        {/* Tool usage pie chart */}
        <div className="rounded-lg border border-deck-border bg-deck-surface p-4">
          <h2 className="mb-4 text-sm font-medium text-deck-muted">Tool Usage</h2>
          {toolUsage.length > 0 ? (
            <ResponsiveContainer width="100%" height={250}>
              <PieChart>
                <Pie
                  data={toolUsage}
                  dataKey="count"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  outerRadius={80}
                  label={({ name, percent }: { name: string; percent: number }) =>
                    `${name} (${(percent * 100).toFixed(0)}%)`
                  }
                >
                  {toolUsage.map((_entry, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', color: '#e2e8f0' }}
                />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <p className="py-8 text-center text-sm text-deck-muted">No tool usage data yet</p>
          )}
        </div>
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

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
