import { useCallback, useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { useGoalsStore } from '../stores/useGoalsStore';
import { apiGet } from '../lib/api';
import { GoalSchema } from '../shared/schemas';
import type { Goal } from '../shared/types';
import KanbanBoard from '../components/kanban/KanbanBoard';
import NewGoalModal from '../components/kanban/NewGoalModal';
import { z } from 'zod';

const GoalsArraySchema = z.array(GoalSchema);

export default function KanbanPage() {
  const setGoals = useGoalsStore((s) => s.setGoals);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    async function loadGoals() {
      try {
        const goals = await apiGet<Goal[]>(
          '/api/goals',
          GoalsArraySchema,
          controller.signal,
        );
        setGoals(goals);
        setError(null);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Failed to load goals');
      } finally {
        setLoading(false);
      }
    }

    void loadGoals();

    return () => {
      controller.abort();
    };
  }, [setGoals]);

  const openModal = useCallback(() => setModalOpen(true), []);
  const closeModal = useCallback(() => setModalOpen(false), []);

  return (
    <div className="flex h-full flex-col">
      {/* Page header */}
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-deck-text">Board</h1>
        <button
          type="button"
          onClick={openModal}
          className="inline-flex items-center gap-2 rounded-md bg-deck-accent px-3 py-2 text-sm font-medium text-white
            transition-colors hover:bg-deck-accent-hover
            focus:outline-none focus:ring-2 focus:ring-deck-accent focus:ring-offset-1 focus:ring-offset-deck-bg"
        >
          <Plus size={16} />
          New Goal
        </button>
      </div>

      {/* Content area */}
      {loading && (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-deck-muted">Loading goals...</p>
        </div>
      )}

      {error && !loading && (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-deck-danger">{error}</p>
        </div>
      )}

      {!loading && !error && <KanbanBoard />}

      {/* New Goal Modal */}
      <NewGoalModal open={modalOpen} onClose={closeModal} />
    </div>
  );
}
