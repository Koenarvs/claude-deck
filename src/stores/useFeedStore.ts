import { create } from 'zustand';
import type { HookEvent } from '../shared/types';

const MAX_EVENTS = 500;

interface FeedState {
  events: HookEvent[];
  addEvent: (event: HookEvent) => void;
  setEvents: (events: HookEvent[]) => void;
}

export const useFeedStore = create<FeedState>((set) => ({
  events: [],

  addEvent: (event) =>
    set((state) => ({
      events: [event, ...state.events].slice(0, MAX_EVENTS),
    })),

  setEvents: (events) => set({ events }),
}));
