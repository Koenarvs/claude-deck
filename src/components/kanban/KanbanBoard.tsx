import { useCallback, useRef } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCorners,
} from '@dnd-kit/core';
import type { DragStartEvent, DragEndEvent } from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { useGoalsStore } from '../../stores/useGoalsStore';
import { apiPatch } from '../../lib/api';
import { GoalSchema } from '../../shared/schemas';
import type { Goal, GoalStatus } from '../../shared/types';
import KanbanColumn from './KanbanColumn';
import KanbanCard from './KanbanCard';

/** Visible column statuses on the board (excludes archived). */
const VISIBLE_STATUSES: GoalStatus[] = [
  'planning',
  'active',
  'waiting',
  'complete',
];

/**
 * Computes kanban_order for a goal dropped at a given index within a column.
 *
 * - At start: first_existing / 2 (min 0.5)
 * - Between two cards: (before + after) / 2
 * - At end: last_existing + 1.0
 * - Empty column: 1.0
 */
function computeKanbanOrder(
  columnGoals: Goal[],
  dropIndex: number,
  draggedGoalId: string,
): number {
  // Filter out the dragged goal if it was in this column
  const filtered = columnGoals.filter((g) => g.id !== draggedGoalId);

  if (filtered.length === 0) return 1.0;

  if (dropIndex <= 0) {
    const first = filtered[0];
    return first ? first.kanban_order / 2 : 1.0;
  }

  if (dropIndex >= filtered.length) {
    const last = filtered[filtered.length - 1];
    return last ? last.kanban_order + 1.0 : 1.0;
  }

  const before = filtered[dropIndex - 1];
  const after = filtered[dropIndex];
  if (before && after) {
    return (before.kanban_order + after.kanban_order) / 2;
  }

  return dropIndex + 1.0;
}

/**
 * Extracts the GoalStatus from a droppable container ID.
 * Container IDs are formatted as "column-{status}" for columns,
 * or are goal IDs for sortable items.
 */
function resolveDropStatus(
  containerId: string,
  goals: Goal[],
): GoalStatus | null {
  if (containerId.startsWith('column-')) {
    return containerId.replace('column-', '') as GoalStatus;
  }
  // It's a goal ID -- find which status that goal belongs to
  const goal = goals.find((g) => g.id === containerId);
  return goal ? goal.status : null;
}

export default function KanbanBoard() {
  const goals = useGoalsStore((s) => s.goals);
  const goalsByStatus = useGoalsStore((s) => s.goalsByStatus);
  const upsertGoal = useGoalsStore((s) => s.upsertGoal);
  const activeGoalRef = useRef<Goal | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const goal = goals.find((g) => g.id === event.active.id);
      activeGoalRef.current = goal ?? null;
    },
    [goals],
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      activeGoalRef.current = null;

      const { active, over } = event;
      if (!over) return;

      const draggedGoal = goals.find((g) => g.id === active.id);
      if (!draggedGoal) return;

      // Determine target status
      const targetStatus = resolveDropStatus(
        String(over.id),
        goals,
      );
      if (!targetStatus) return;

      // Determine drop index within target column
      const targetGoals = goalsByStatus(targetStatus);
      let dropIndex: number;

      if (String(over.id).startsWith('column-')) {
        // Dropped on the column itself (empty area) -- place at end
        dropIndex = targetGoals.length;
      } else {
        // Dropped on a specific card -- find its index
        const overIndex = targetGoals.findIndex((g) => g.id === over.id);
        dropIndex = overIndex >= 0 ? overIndex : targetGoals.length;
      }

      const newOrder = computeKanbanOrder(
        targetGoals,
        dropIndex,
        draggedGoal.id,
      );

      const statusChanged = draggedGoal.status !== targetStatus;
      const orderChanged = draggedGoal.kanban_order !== newOrder;

      if (!statusChanged && !orderChanged) return;

      // Build the update payload
      const patch: { status?: GoalStatus; kanban_order?: number } = {};
      if (statusChanged) patch.status = targetStatus;
      if (orderChanged || statusChanged) patch.kanban_order = newOrder;

      // Optimistic update
      const optimisticGoal: Goal = {
        ...draggedGoal,
        status: targetStatus,
        kanban_order: newOrder,
        updated_at: Date.now(),
      };
      upsertGoal(optimisticGoal);

      try {
        const updated = await apiPatch(
          `/api/goals/${draggedGoal.id}`,
          patch,
          GoalSchema,
        );
        upsertGoal(updated as Goal);
      } catch {
        // Rollback on failure
        upsertGoal(draggedGoal);
      }
    },
    [goals, goalsByStatus, upsertGoal],
  );

  const activeGoal = activeGoalRef.current;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="flex gap-4 overflow-x-auto pb-4">
        {VISIBLE_STATUSES.map((status) => (
          <KanbanColumn
            key={status}
            status={status}
            goals={goalsByStatus(status)}
          />
        ))}
      </div>

      <DragOverlay dropAnimation={null}>
        {activeGoal ? (
          <div className="w-72 rotate-2 opacity-90">
            <KanbanCard goal={activeGoal} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
