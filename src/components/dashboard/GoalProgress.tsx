import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import type { GoalStatus } from '../../shared/types';

const STATUS_COLORS: Record<GoalStatus, string> = {
  planning: '#6366f1',
  active: '#22c55e',
  waiting: '#f59e0b',
  complete: '#6b7280',
  archived: '#4b5563',
};

const STATUS_LABELS: Record<GoalStatus, string> = {
  planning: 'Planning',
  active: 'Active',
  waiting: 'Waiting',
  complete: 'Complete',
  archived: 'Archived',
};

interface GoalStatusCount {
  status: GoalStatus;
  label: string;
  count: number;
  fill: string;
}

export interface GoalProgressProps {
  statusCounts: Record<GoalStatus, number>;
}

export default function GoalProgress({ statusCounts }: GoalProgressProps) {
  const statuses: GoalStatus[] = ['planning', 'active', 'waiting', 'complete', 'archived'];

  const data: GoalStatusCount[] = statuses.map((status) => ({
    status,
    label: STATUS_LABELS[status],
    count: statusCounts[status],
    fill: STATUS_COLORS[status],
  }));

  const totalGoals = data.reduce((sum, d) => sum + d.count, 0);

  if (totalGoals === 0) {
    return (
      <div className="rounded-lg border border-deck-border bg-deck-surface p-6 text-center text-sm text-deck-muted">
        No goals to chart. Create one from the Board.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-deck-border bg-deck-surface p-4">
      <h3 className="mb-4 text-sm font-medium text-deck-text">Goals by Status</h3>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} layout="vertical" margin={{ left: 20, right: 20 }}>
          <XAxis
            type="number"
            allowDecimals={false}
            tick={{ fill: '#6b7280', fontSize: 12 }}
            axisLine={{ stroke: '#2a2d3a' }}
            tickLine={false}
          />
          <YAxis
            type="category"
            dataKey="label"
            width={80}
            tick={{ fill: '#6b7280', fontSize: 12 }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            cursor={{ fill: 'rgba(99,102,241,0.08)' }}
            contentStyle={{
              backgroundColor: '#1a1d27',
              border: '1px solid #2a2d3a',
              borderRadius: '8px',
              color: '#e2e4e9',
              fontSize: '12px',
            }}
            formatter={(value: number) => [value, 'Goals']}
          />
          <Bar dataKey="count" radius={[0, 4, 4, 0]} maxBarSize={28}>
            {data.map((entry) => (
              <Cell key={entry.status} fill={entry.fill} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
