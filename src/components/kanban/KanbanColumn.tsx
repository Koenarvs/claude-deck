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
  planning: 'border-t-[var(--cd-warn)]',
  active: 'border-t-[var(--cd-accent)]',
  waiting: 'border-t-[var(--cd-dim)]',
  complete: 'border-t-[var(--cd-ok)]',
  archived: 'border-t-[var(--cd-faint)]',
};

export default function KanbanColumn({ status, goals }: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: `column-${status}`,
    data: { status },
  });

  const goalIds = goals.map((g) => g.id);

  return (
    <div
      className={`flex min-h-0 w-72 flex-shrink-0 flex-col rounded-md border-t-2 bg-bg
        ${COLUMN_HEADER_COLORS[status]}
        ${isOver ? 'ring-2 ring-accent/40' : ''}`}
    >
      {/* Column header */}
      <div className="flex items-center justify-between px-3 py-2.5">
        <div className="flex items-center gap-2">
          <h2 className="text-[13px] font-semibold text-fg">
            {COLUMN_LABELS[status]}
          </h2>
          <span className="mono-tabular inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full border border-line bg-inset px-1.5 text-[10px] text-dim">
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
            <div className="flex flex-col items-center justify-center py-8 text-faint">
              <Inbox size={24} className="mb-2 opacity-50" />
              <p className="text-[11px]">No goals</p>
            </div>
          ) : (
            goals.map((goal) => <KanbanCard key={goal.id} goal={goal} />)
          )}
        </SortableContext>
      </div>
    </div>
  );
}
