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
import { fmtCost } from '../../lib/format';
import type { DailyCost, SessionsPerDay, DurationBucket, WeeklyCount, CostPerGoalResponse } from '../../lib/analytics-api';
import { tooltipStyle, Empty, ChartError } from './shared';

export function DailyCostCard({ data, error }: { data: DailyCost[]; error: boolean }) {
  return (
    <div className="rounded-md border border-line bg-card p-4">
      <h2 className="mb-4 text-sm font-medium text-dim">Daily Cost</h2>
      {error ? (
        <ChartError />
      ) : data.length > 0 ? (
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={data}>
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
  );
}

export function SessionsPerDayCard({ data, error }: { data: SessionsPerDay[]; error: boolean }) {
  return (
    <div className="rounded-md border border-line bg-card p-4">
      <h2 className="mb-4 text-sm font-medium text-dim">Sessions Per Day</h2>
      {error ? (
        <ChartError />
      ) : data.length > 0 ? (
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={data}>
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
  );
}

export function SessionDurationCard({ data, error }: { data: DurationBucket[]; error: boolean }) {
  return (
    <div className="rounded-md border border-line bg-card p-4">
      <h2 className="mb-4 text-sm font-medium text-dim">Session Duration Distribution</h2>
      {error ? (
        <ChartError />
      ) : data.length > 0 ? (
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={data}>
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
  );
}

export function CostPerGoalCard({ costPerGoal }: { costPerGoal: CostPerGoalResponse }) {
  if (costPerGoal.series.length === 0) return null;
  return (
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
  );
}

export function OutputTrendsCard({ jiraStories, prsMerged }: { jiraStories: WeeklyCount[]; prsMerged: WeeklyCount[] }) {
  return (
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
  );
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
