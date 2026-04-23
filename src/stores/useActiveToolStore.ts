import { create } from 'zustand';

interface ActiveToolState {
  bySessionId: Record<string, string | null>;
  setActiveTool: (sessionId: string, toolName: string | null) => void;
  clearSession: (sessionId: string) => void;
}

export const useActiveToolStore = create<ActiveToolState>((set) => ({
  bySessionId: {},
  setActiveTool: (sessionId, toolName) =>
    set((state) => ({
      bySessionId: { ...state.bySessionId, [sessionId]: toolName },
    })),
  clearSession: (sessionId) =>
    set((state) => {
      const next = { ...state.bySessionId };
      delete next[sessionId];
      return { bySessionId: next };
    }),
}));
