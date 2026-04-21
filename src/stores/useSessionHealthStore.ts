import { create } from 'zustand';

export interface SessionHealth {
  sessionId: string;
  goalId: string | null;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCost: number;
  turnCount: number;
  contextWindowUsed: number; // estimated percentage 0-100
  lastUpdated: number;
}

interface SessionHealthState {
  bySessionId: Record<string, SessionHealth>;
  updateHealth: (sessionId: string, update: Partial<SessionHealth>) => void;
  removeHealth: (sessionId: string) => void;
}

// Claude model context windows (approximate)
const CONTEXT_WINDOWS: Record<string, number> = {
  opus: 200_000,
  sonnet: 200_000,
  haiku: 200_000,
  default: 200_000,
};

export function estimateContextUsage(tokensIn: number, tokensOut: number, model = 'default'): number {
  const window = CONTEXT_WINDOWS[model] ?? 200_000;
  const totalTokens = tokensIn + tokensOut;
  return Math.min(100, Math.round((totalTokens / window) * 100));
}

export const useSessionHealthStore = create<SessionHealthState>((set) => ({
  bySessionId: {},
  updateHealth: (sessionId, update) =>
    set((state) => {
      const existing = state.bySessionId[sessionId];
      const base: SessionHealth = existing ?? {
        sessionId,
        goalId: null,
        totalTokensIn: 0,
        totalTokensOut: 0,
        totalCost: 0,
        turnCount: 0,
        contextWindowUsed: 0,
        lastUpdated: Date.now(),
      };
      return {
        bySessionId: {
          ...state.bySessionId,
          [sessionId]: { ...base, ...update, lastUpdated: Date.now() },
        },
      };
    }),
  removeHealth: (sessionId) =>
    set((state) => {
      const next = { ...state.bySessionId };
      delete next[sessionId];
      return { bySessionId: next };
    }),
}));
