import { create } from 'zustand';
import type { AppConfig } from '../shared/types';
import type { AgentCatalogEntry } from '../shared/agents/types';

interface ConfigState {
  config: AppConfig | null;
  /** Derived provider catalog from GET /api/config — drives every model picker. */
  catalog: AgentCatalogEntry[];
  setConfig: (config: AppConfig) => void;
  setCatalog: (catalog: AgentCatalogEntry[]) => void;
}

export const useConfigStore = create<ConfigState>((set) => ({
  config: null,
  catalog: [],

  setConfig: (config) => set({ config }),
  setCatalog: (catalog) => set({ catalog }),
}));
