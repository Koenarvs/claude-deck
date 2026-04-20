import { create } from 'zustand';
import type { PlanJson } from '../shared/types';

interface PlanState {
  byGoalId: Record<string, PlanJson>;
  setPlan: (goalId: string, plan: PlanJson) => void;
}

export const usePlanStore = create<PlanState>((set) => ({
  byGoalId: {},

  setPlan: (goalId, plan) =>
    set((state) => ({
      byGoalId: { ...state.byGoalId, [goalId]: plan },
    })),
}));
