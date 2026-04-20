import { useDroppable } from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { Inbox } from 'lucide-react';
import type { Goal, GoalStatus } from '../../shared/types';
import KanbanCard from './KanbanCard';

interface KanbanColumnProps {
  status: GoalStatus;
  goals: Goal[];
}

const COLUMN_LABELS: Record<GoalStatus, string> = {
  planning: 'Planning',
  active: 'Active',
  waiting: 'Waiting',
  complete: 'Complete',
  archived: 'Archived',
};

const COLUMN_HEADER_COLORS: Record<GoalStatus, string> = {
  planning: 'border-t-amber-500',
  active: 'border-t-indigo-500',
  waiting: 'border-t-gray-500',
  complete: 'border-t-emerald-500',
  archived: 'border-t-gray-600',
};

export default function KanbanColumn({ status, goals }: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: `column-${status}`,
    data: { status },
  });

  const goalIds = goals.map((g) => g.id);

  return (
    <div
      className={`flex min-h-0 w-72 flex-shrink-0 flex-col rounded-lg border-t-2 bg-deck-bg
        ${COLUMN_HEADER_COLORS[status]}
        ${isOver ? 'ring-2 ring-deck-accent/40' : ''}`}
    >
      {/* Column header */}
      <div className="flex items-center justify-between px-3 py-2.5">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-deck-text">
            {COLUMN_LABELS[status]}
          </h2>
          <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-deck-border px-1.5 text-xs text-deck-muted">
            {goals.length}
          </span>
        </div>
      </div>

      {/* Card list */}
      <div
        ref={setNodeRef}
        className="flex flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2"
      >
        <SortableContext items={goalIds} strategy={verticalListSortingStrategy}>
          {goals.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-deck-muted">
              <Inbox size={24} className="mb-2 opacity-50" />
              <p className="text-xs">No goals in this status</p>
            </div>
          ) : (
            goals.map((goal) => <KanbanCard key={goal.id} goal={goal} />)
          )}
        </SortableContext>
      </div>
    </div>
  );
}
