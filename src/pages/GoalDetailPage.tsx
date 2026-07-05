import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { apiGet, apiPost, apiPatch, ApiError } from '@/lib/api';
import { useGoalsStore } from '@/stores/useGoalsStore';
import { useMessagesStore } from '@/stores/useMessagesStore';
import { usePlanStore } from '@/stores/usePlanStore';
import type { Goal, GoalModel, GoalDetail } from '@shared/types';
import GoalHeader from '@/components/goal/GoalHeader';
import GoalSplitView from '@/components/goal/GoalSplitView';

export default function GoalDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isInterrupting, setIsInterrupting] = useState(false);

  const goal = useGoalsStore(
    (state) => state.goals.find((g) => g.id === id) ?? null,
  );
  const upsertGoal = useGoalsStore((state) => state.upsertGoal);
  const setPlan = usePlanStore((state) => state.setPlan);

  // Fetch goal detail on mount — populates goals, messages, and plan stores
  useEffect(() => {
    if (!id) return;

    let cancelled = false;

    async function fetchGoal() {
      setIsLoading(true);
      setError(null);
      try {
        const data = await apiGet<GoalDetail>(`/api/goals/${id}`).catch((err: unknown) => {
          if (err instanceof ApiError) {
            if (err.status === 404) {
              throw new Error('Goal not found');
            }
            throw new Error(`Failed to load goal: ${err.status}`);
          }
          throw err;
        });

        if (cancelled) return;

        // Populate all stores from the single GoalDetail response
        upsertGoal(data.goal);

        if (data.messages.length > 0) {
          useMessagesStore.setState((state) => ({
            byGoalId: {
              ...state.byGoalId,
              [id as string]: data.messages,
            },
          }));
        }

        if (data.plan) {
          setPlan(id as string, data.plan);
        }

        if (data.interGoalMessages && data.interGoalMessages.length > 0) {
          const { addInstruction } = useGoalsStore.getState();
          for (const msg of data.interGoalMessages) {
            addInstruction(msg);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : 'Failed to load goal',
          );
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void fetchGoal();
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- store actions are stable singletons
  }, [id]);

  // Title update handler (optimistic)
  const handleTitleUpdate = useCallback(
    async (title: string) => {
      if (!goal || !id) return;

      // Optimistic update
      const optimistic: Goal = { ...goal, title, updated_at: Date.now() };
      upsertGoal(optimistic);

      try {
        const updated = await apiPatch<Goal>(`/api/goals/${id}`, { title });
        upsertGoal(updated);
      } catch {
        // Revert on failure or network error
        upsertGoal(goal);
      }
    },
    [goal, id, upsertGoal],
  );

  // Model change handler
  const handleModelChange = useCallback(
    async (model: GoalModel) => {
      if (!goal || !id) return;

      const optimistic: Goal = { ...goal, model, updated_at: Date.now() };
      upsertGoal(optimistic);

      try {
        const updated = await apiPatch<Goal>(`/api/goals/${id}`, { model });
        upsertGoal(updated);
      } catch {
        upsertGoal(goal);
      }
    },
    [goal, id, upsertGoal],
  );

  // Interrupt handler
  const handleInterrupt = useCallback(async () => {
    if (!id) return;
    setIsInterrupting(true);

    try {
      await apiPost(`/api/goals/${id}/interrupt`, undefined);
      // Errors handled via WS goal:status event or user can retry
    } catch {
      // Network error — user can retry
    } finally {
      setIsInterrupting(false);
    }
  }, [id]);

  // Loading state
  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-deck-muted">
        <Loader2 size={32} className="animate-spin" />
      </div>
    );
  }

  // Error state
  if (error || !goal) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <div className="rounded-lg border border-deck-danger/30 bg-deck-danger/10 px-6 py-4 text-sm text-deck-danger">
          {error ?? 'Goal not found'}
        </div>
        <button
          type="button"
          onClick={() => void navigate('/board')}
          className="flex items-center gap-2 text-sm text-deck-accent hover:text-deck-accent-hover transition-colors"
        >
          <ArrowLeft size={16} />
          Back to Board
        </button>
      </div>
    );
  }

  return (
    <div
      className="flex h-full flex-col"
      data-testid="goal-detail-page"
    >
      <GoalHeader
        goal={goal}
        onTitleUpdate={handleTitleUpdate}
        onModelChange={handleModelChange}
        onInterrupt={handleInterrupt}
        isInterrupting={isInterrupting}
      />
      <GoalSplitView goalId={goal.id} goalStatus={goal.status} />
    </div>
  );
}
