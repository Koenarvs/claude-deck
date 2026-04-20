import { memo } from 'react';
import { Check, Circle, Loader2 } from 'lucide-react';
import type { PlanTodo } from '@shared/types';

interface PlanRendererProps {
  todos: PlanTodo[];
  depth?: number;
}

const statusConfig: Record<
  PlanTodo['status'],
  { icon: typeof Check; colorClass: string; label: string }
> = {
  completed: {
    icon: Check,
    colorClass: 'text-deck-success',
    label: 'Completed',
  },
  in_progress: {
    icon: Loader2,
    colorClass: 'text-deck-accent',
    label: 'In progress',
  },
  pending: {
    icon: Circle,
    colorClass: 'text-deck-muted',
    label: 'Pending',
  },
};

function TodoItem({ todo, depth }: { todo: PlanTodo; depth: number }) {
  const config = statusConfig[todo.status];
  const Icon = config.icon;
  const isSpinning = todo.status === 'in_progress';

  return (
    <li data-testid={`plan-todo-${todo.status}`}>
      <div
        className="flex items-start gap-2 py-1"
        style={{ paddingLeft: `${depth * 16}px` }}
      >
        <div className="mt-0.5 flex-shrink-0">
          <Icon
            size={16}
            className={`${config.colorClass} ${isSpinning ? 'animate-spin' : ''}`}
            aria-label={config.label}
          />
        </div>
        <span
          className={`text-sm ${
            todo.status === 'completed'
              ? 'text-deck-muted line-through'
              : 'text-deck-text'
          }`}
        >
          {todo.content}
        </span>
      </div>
      {todo.children.length > 0 && (
        <ul className="list-none">
          {todo.children.map((child, idx) => (
            <TodoItem
              key={`${depth}-${idx}-${child.content.slice(0, 20)}`}
              todo={child}
              depth={depth + 1}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function PlanRendererInner({ todos, depth = 0 }: PlanRendererProps) {
  if (todos.length === 0) {
    return (
      <div className="py-4 text-center text-sm text-deck-muted" data-testid="plan-empty">
        No plan items yet
      </div>
    );
  }

  const completedCount = countByStatus(todos, 'completed');
  const totalCount = countAll(todos);
  const progressPct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  return (
    <div data-testid="plan-renderer">
      {/* Progress bar */}
      <div className="mb-3">
        <div className="flex items-center justify-between text-xs text-deck-muted mb-1">
          <span>Progress</span>
          <span>
            {completedCount}/{totalCount} ({progressPct}%)
          </span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-deck-border">
          <div
            className="h-1.5 rounded-full bg-deck-success transition-all duration-300"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      {/* Todo list */}
      <ul className="list-none space-y-0.5">
        {todos.map((todo, idx) => (
          <TodoItem
            key={`${depth}-${idx}-${todo.content.slice(0, 20)}`}
            todo={todo}
            depth={depth}
          />
        ))}
      </ul>
    </div>
  );
}

/** Count todos with a specific status, recursively including children. */
function countByStatus(todos: PlanTodo[], status: PlanTodo['status']): number {
  let count = 0;
  for (const todo of todos) {
    if (todo.status === status) count++;
    count += countByStatus(todo.children, status);
  }
  return count;
}

/** Count all todos recursively. */
function countAll(todos: PlanTodo[]): number {
  let count = 0;
  for (const todo of todos) {
    count++;
    count += countAll(todo.children);
  }
  return count;
}

export const PlanRenderer = memo(PlanRendererInner);
