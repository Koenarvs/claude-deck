import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Aesthetic = 'studio' | 'console' | 'mission';
export type Theme = 'dark' | 'light';
export type BoardLayout = 'columns' | 'compact' | 'table';
export type LiveActivity = 'on' | 'subtle' | 'off';

interface UIConfig {
  aesthetic: Aesthetic;
  theme: Theme;
  boardLayout: BoardLayout;
  liveActivity: LiveActivity;
  tweaksOpen: boolean;
}

interface UIConfigState extends UIConfig {
  setAesthetic: (a: Aesthetic) => void;
  setTheme: (t: Theme) => void;
  setBoardLayout: (l: BoardLayout) => void;
  setLiveActivity: (l: LiveActivity) => void;
  setTweaksOpen: (b: boolean) => void;
  toggleTheme: () => void;
}

export const useUIConfigStore = create<UIConfigState>()(
  persist(
    (set) => ({
      aesthetic: 'mission',
      theme: 'dark',
      boardLayout: 'columns',
      liveActivity: 'on',
      tweaksOpen: false,

      setAesthetic: (aesthetic) => set({ aesthetic }),
      setTheme: (theme) => set({ theme }),
      setBoardLayout: (boardLayout) => set({ boardLayout }),
      setLiveActivity: (liveActivity) => set({ liveActivity }),
      setTweaksOpen: (tweaksOpen) => set({ tweaksOpen }),
      toggleTheme: () =>
        set((s) => ({ theme: s.theme === 'dark' ? 'light' : 'dark' })),
    }),
    { name: 'cd-ui-config', version: 1 },
  ),
);
