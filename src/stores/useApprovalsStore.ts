import { create } from 'zustand';
import type { Approval, ApprovalDecision } from '../shared/types';

const MAX_RESOLVED = 100;

interface ApprovalsState {
  pending: Approval[];
  resolved: Approval[];
  addPending: (approval: Approval) => void;
  markResolved: (id: string, decision: ApprovalDecision) => void;
}

export const useApprovalsStore = create<ApprovalsState>((set) => ({
  pending: [],
  resolved: [],

  addPending: (approval) =>
    set((state) => ({
      pending: [...state.pending, approval],
    })),

  markResolved: (id, decision) =>
    set((state) => {
      const approval = state.pending.find((a) => a.id === id);
      if (!approval) return state;

      const resolvedApproval: Approval = {
        ...approval,
        status: decision,
        resolved_at: Date.now(),
      };

      const newResolved = [resolvedApproval, ...state.resolved].slice(0, MAX_RESOLVED);

      return {
        pending: state.pending.filter((a) => a.id !== id),
        resolved: newResolved,
      };
    }),
}));
