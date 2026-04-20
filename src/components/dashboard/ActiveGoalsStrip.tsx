import { useNavigate } from 'react-router';
import { ArrowRight } from 'lucide-react';
import type { Goal } from '../../shared/types';

interface ActiveGoalCardProps {
  goal: Goal;
  onClick: () => void;
}

function ActiveGoalCard({ goal, onClick }: ActiveGoalCardProps) {
  const modelLabel = goal.model ?? 'default';
  const updatedAgo = formatTimeAgo(goal.updated_at);

  return (
    <button
      onClick={onClick}
      className="group flex min-w-[220px] shrink-0 flex-col gap-2 rounded-lg border border-deck-border bg-deck-surface p-4 text-left transition-colors hover:border-deck-accent"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="line-clamp-2 text-sm font-medium text-deck-text">
          {goal.title}
        </h3>
        <ArrowRight
          size={14}
          className="mt-0.5 shrink-0 text-deck-muted opacity-0 transition-opacity group-hover:opacity-100"
        />
      </div>
      <div className="flex items-center gap-2 text-xs text-deck-muted">
        <span className="rounded bg-deck-border px-1.5 py-0.5">{modelLabel}</span>
        <span>{updatedAgo}</span>
      </div>
    </button>
  );
}

function formatTimeAgo(epochMs: number): string {
  const diffMs = Date.now() - epochMs;
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

export interface ActiveGoalsStripProps {
  goals: Goal[];
}

export default function ActiveGoalsStrip({ goals }: ActiveGoalsStripProps) {
  const navigate = useNavigate();

  if (goals.length === 0) {
    return (
      <div className="rounded-lg border border-deck-border bg-deck-surface p-6 text-center text-sm text-deck-muted">
        No active goals. Create one from the Board.
      </div>
    );
  }

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {goals.map((goal) => (
        <ActiveGoalCard
          key={goal.id}
          goal={goal}
          onClick={() => navigate(`/goals/${goal.id}`)}
        />
      ))}
    </div>
  );
}
