import { useState, useEffect, useCallback } from 'react';
import { ChevronLeft, ChevronRight, ClipboardList } from 'lucide-react';
import { usePlanStore } from '@/stores/usePlanStore';
import { PlanRenderer } from './PlanRenderer';

interface GoalPlanPaneProps {
  goalId: string;
}

const COLLAPSE_KEY = 'claude-deck:plan-pane-collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeCollapsed(value: boolean): void {
  try {
    localStorage.setItem(COLLAPSE_KEY, value ? 'true' : 'false');
  } catch {
    // localStorage unavailable — no-op
  }
}

export default function GoalPlanPane({ goalId }: GoalPlanPaneProps) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const plan = usePlanStore((state) => state.byGoalId[goalId] ?? null);

  const toggleCollapse = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      writeCollapsed(next);
      return next;
    });
  }, []);

  // Sync collapse state from localStorage on mount
  useEffect(() => {
    setCollapsed(readCollapsed());
  }, []);

  if (collapsed) {
    return (
      <div
        className="flex h-full w-10 flex-col items-center border-l border-deck-border bg-deck-surface pt-3"
        data-testid="plan-pane-collapsed"
      >
        <button
          type="button"
          onClick={toggleCollapse}
          className="rounded p-1 text-deck-muted hover:bg-deck-border hover:text-deck-text transition-colors"
          aria-label="Expand plan pane"
          title="Expand plan pane"
        >
          <ChevronLeft size={16} />
        </button>
        <div className="mt-3">
          <ClipboardList size={16} className="text-deck-muted" />
        </div>
        {plan && plan.todos.length > 0 && (
          <span className="mt-2 text-xs text-deck-muted">
            {plan.todos.length}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      className="flex h-full w-full flex-col border-l border-deck-border bg-deck-surface"
      data-testid="plan-pane-expanded"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-deck-border px-4 py-3">
        <div className="flex items-center gap-2">
          <ClipboardList size={16} className="text-deck-accent" />
          <h3 className="text-sm font-medium text-deck-text">Plan</h3>
        </div>
        <button
          type="button"
          onClick={toggleCollapse}
          className="rounded p-1 text-deck-muted hover:bg-deck-border hover:text-deck-text transition-colors"
          aria-label="Collapse plan pane"
          title="Collapse plan pane"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {plan ? (
          <PlanRenderer todos={plan.todos} />
        ) : (
          <div className="flex flex-col items-center justify-center py-8 text-deck-muted">
            <ClipboardList size={24} className="mb-2 opacity-40" />
            <p className="text-sm">No plan yet</p>
            <p className="mt-1 text-xs opacity-60">
              Plan will appear when TodoWrite is called
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
