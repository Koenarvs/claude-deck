import { create } from 'zustand';
import type { OrchestratorMessage, OrchestratorStatus } from '../shared/orchestrator';

export interface ToolLogEntry {
  tool: string;
  summary: string;
}

interface OrchestratorState {
  messages: OrchestratorMessage[];
  status: OrchestratorStatus;
  /** Live tool calls for the current/last wake (transparency). Cleared when a new wake starts. */
  toolLog: ToolLogEntry[];
  loaded: boolean;
  hydrate: (messages: OrchestratorMessage[], status: OrchestratorStatus) => void;
  addMessage: (message: OrchestratorMessage) => void;
  setStatus: (status: OrchestratorStatus) => void;
  addTool: (entry: ToolLogEntry) => void;
}

export const useOrchestratorStore = create<OrchestratorState>((set) => ({
  messages: [],
  status: 'idle',
  toolLog: [],
  loaded: false,

  hydrate: (messages, status) => set({ messages, status, loaded: true }),

  addMessage: (message) =>
    set((s) =>
      s.messages.some((m) => m.id === message.id) ? s : { messages: [...s.messages, message] },
    ),

  // A transition into 'waking' marks a new wake — clear the live tool log so it reflects this run.
  setStatus: (status) => set(status === 'waking' ? { status, toolLog: [] } : { status }),

  addTool: (entry) => set((s) => ({ toolLog: [...s.toolLog, entry] })),
}));
