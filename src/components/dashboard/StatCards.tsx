import {
  Target,
  Monitor,
  CheckCircle2,
} from 'lucide-react';
import type { ReactNode } from 'react';

interface StatCardProps {
  label: string;
  value: number;
  icon: ReactNode;
  color: string;
}

function StatCard({ label, value, icon, color }: StatCardProps) {
  return (
    <div className="flex items-center gap-4 rounded-lg border border-deck-border bg-deck-surface p-5">
      <div
        className="flex h-12 w-12 items-center justify-center rounded-lg"
        style={{ backgroundColor: `${color}20`, color }}
      >
        {icon}
      </div>
      <div>
        <p className="text-sm font-medium text-deck-muted">{label}</p>
        <p className="text-2xl font-bold text-deck-text">{value}</p>
      </div>
    </div>
  );
}

export interface StatCardsProps {
  activeGoals: number;
  activeSessions: number;
  totalCompleted: number;
}

export default function StatCards({
  activeGoals,
  activeSessions,
  totalCompleted,
}: StatCardsProps) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <StatCard
        label="Active Goals"
        value={activeGoals}
        icon={<Target size={24} />}
        color="#6366f1"
      />
      <StatCard
        label="Active Sessions"
        value={activeSessions}
        icon={<Monitor size={24} />}
        color="#22c55e"
      />
      <StatCard
        label="Total Completed"
        value={totalCompleted}
        icon={<CheckCircle2 size={24} />}
        color="#6366f1"
      />
    </div>
  );
}
