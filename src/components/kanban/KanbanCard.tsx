import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useNavigate } from 'react-router';
import { Tag, Cpu, Archive } from 'lucide-react';
import { useGoalsStore } from '../../stores/useGoalsStore';
import type { Goal, GoalModel } from '../../shared/types';

interface KanbanCardProps {
  goal: Goal;
}

const STATUS_COLORS: Record<string, string> = {
  planning: 'bg-deck-warning',
  active: 'bg-deck-accent',
  waiting: 'bg-deck-muted',
  complete: 'bg-deck-success',
  archived: 'bg-gray-600',
};

const MODEL_LABELS: Record<GoalModel, string> = {
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  default: 'Default',
};

const MODEL_COLORS: Record<GoalModel, string> = {
  opus: 'text-amber-400',
  sonnet: 'text-indigo-400',
  haiku: 'text-emerald-400',
  default: 'text-deck-muted',
};

export default function KanbanCard({ goal }: KanbanCardProps) {
  const navigate = useNavigate();
  const removeGoal = useGoalsStore((s) => s.removeGoal);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: goal.id,
    data: { goal },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  function handleClick() {
    navigate(`/goals/${goal.id}`);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick();
    }
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      aria-label={`Goal: ${goal.title}`}
      className={`group cursor-pointer rounded-lg border border-deck-border bg-deck-surface p-3
        transition-all hover:border-deck-accent/50 hover:shadow-md
        focus:outline-none focus:ring-2 focus:ring-deck-accent focus:ring-offset-1 focus:ring-offset-deck-bg
        ${isDragging ? 'z-50 opacity-50 shadow-lg' : ''}`}
    >
      {/* Header: status dot + title */}
      <div className="flex items-start gap-2">
        <span
          className={`mt-1.5 inline-block h-2 w-2 flex-shrink-0 rounded-full ${STATUS_COLORS[goal.status] ?? 'bg-deck-muted'}`}
          aria-label={`Status: ${goal.status}`}
        />
        <h3 className="text-sm font-medium leading-snug text-deck-text line-clamp-2">
          {goal.title}
        </h3>
      </div>

      {/* Footer: tags + model badge */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {goal.tags.length > 0 && (
          <>
            <Tag size={12} className="text-deck-muted" />
            {goal.tags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="inline-flex rounded bg-deck-border px-1.5 py-0.5 text-xs text-deck-muted"
              >
                {tag}
              </span>
            ))}
            {goal.tags.length > 3 && (
              <span className="text-xs text-deck-muted">
                +{goal.tags.length - 3}
              </span>
            )}
          </>
        )}

        {goal.model && goal.model !== 'default' && (
          <span
            className={`inline-flex items-center gap-1 text-xs ${MODEL_COLORS[goal.model]}`}
          >
            <Cpu size={11} />
            {MODEL_LABELS[goal.model]}
          </span>
        )}

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            fetch(`/api/goals/${goal.id}`, { method: 'DELETE' })
              .then((res) => {
                if (res.ok) removeGoal(goal.id);
              })
              .catch(() => {});
          }}
          className="ml-auto rounded p-1 text-deck-muted opacity-0 transition-opacity hover:bg-deck-danger/20 hover:text-deck-danger group-hover:opacity-100"
          aria-label="Archive goal"
          title="Archive"
        >
          <Archive size={14} />
        </button>
      </div>
    </div>
  );
}
