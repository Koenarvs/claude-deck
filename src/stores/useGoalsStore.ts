import { create } from 'zustand';
import type { Goal, GoalStatus, InterGoalMessage } from '../shared/types';

interface GoalsState {
  goals: Goal[];
  pendingInstructions: Map<string, InterGoalMessage[]>;
  setGoals: (goals: Goal[]) => void;
  upsertGoal: (goal: Goal) => void;
  removeGoal: (id: string) => void;
  addInstruction: (message: InterGoalMessage) => void;
  goalsByStatus: (status: GoalStatus) => Goal[];
}

export const useGoalsStore = create<GoalsState>((set, get) => ({
  goals: [],
  pendingInstructions: new Map(),

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

  addInstruction: (message) =>
    set((state) => {
      const map = new Map(state.pendingInstructions);
      const existing = map.get(message.to_goal_id) ?? [];
      if (!existing.some((m) => m.id === message.id)) {
        map.set(message.to_goal_id, [...existing, message]);
      }
      return { pendingInstructions: map };
    }),

  goalsByStatus: (status) =>
    get()
      .goals.filter((g) => g.status === status)
      .sort((a, b) => a.kanban_order - b.kanban_order),
}));
