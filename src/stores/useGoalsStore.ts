import { create } from 'zustand';
import type { Goal, GoalStatus } from '../shared/types';

interface GoalsState {
  goals: Goal[];
  setGoals: (goals: Goal[]) => void;
  upsertGoal: (goal: Goal) => void;
  removeGoal: (id: string) => void;
  goalsByStatus: (status: GoalStatus) => Goal[];
}

export const useGoalsStore = create<GoalsState>((set, get) => ({
  goals: [],

  setGoals: (goals) => set({ goals }),

  upsertGoal: (goal) =>
    set((state) => {
      const idx = state.goals.findIndex((g) => g.id === goal.id);
      if (idx >= 0) {
        const updated = [...state.goals];
        updated[idx] = goal;
        return { goals: updated };
      }
      return { goals: [...state.goals, goal] };
    }),

  removeGoal: (id) =>
    set((state) => ({
      goals: state.goals.filter((g) => g.id !== id),
    })),

  goalsByStatus: (status) =>
    get()
      .goals.filter((g) => g.status === status)
      .sort((a, b) => a.kanban_order - b.kanban_order),
}));
