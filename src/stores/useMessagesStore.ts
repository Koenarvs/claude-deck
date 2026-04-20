import { create } from 'zustand';
import type { Message } from '../shared/types';

interface MessagesState {
  byGoalId: Record<string, Message[]>;
  bySessionId: Record<string, Message[]>;
  addMessage: (goalId: string | null, sessionId: string, message: Message) => void;
  setMessagesForSession: (sessionId: string, messages: Message[]) => void;
}

export const useMessagesStore = create<MessagesState>((set) => ({
  byGoalId: {},
  bySessionId: {},

  addMessage: (goalId, sessionId, message) =>
    set((state) => {
      const newBySession = { ...state.bySessionId };
      const sessionMsgs = newBySession[sessionId] ?? [];
      newBySession[sessionId] = [...sessionMsgs, message];

      const newByGoal = { ...state.byGoalId };
      if (goalId !== null) {
        const goalMsgs = newByGoal[goalId] ?? [];
        newByGoal[goalId] = [...goalMsgs, message];
      }

      return { bySessionId: newBySession, byGoalId: newByGoal };
    }),

  setMessagesForSession: (sessionId, messages) =>
    set((state) => ({
      bySessionId: { ...state.bySessionId, [sessionId]: messages },
    })),
}));
