import { create } from 'zustand';
import type { Session } from '../shared/types';

interface SessionsState {
  sessions: Session[];
  setSessions: (sessions: Session[]) => void;
  upsertSession: (session: Session) => void;
}

export const useSessionsStore = create<SessionsState>((set) => ({
  sessions: [],

  setSessions: (sessions) => set({ sessions }),

  upsertSession: (session) =>
    set((state) => {
      const idx = state.sessions.findIndex((s) => s.id === session.id);
      if (idx >= 0) {
        const updated = [...state.sessions];
        updated[idx] = session;
        return { sessions: updated };
      }
      return { sessions: [...state.sessions, session] };
    }),
}));
