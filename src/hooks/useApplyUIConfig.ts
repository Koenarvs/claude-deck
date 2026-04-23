import { useEffect } from 'react';
import { useUIConfigStore } from '../stores/useUIConfigStore';

/**
 * Applies aesthetic/theme/live-activity to <html> as data-* attrs.
 * Call once near the root of the app (AppShell).
 */
export function useApplyUIConfig() {
  const aesthetic = useUIConfigStore((s) => s.aesthetic);
  const theme = useUIConfigStore((s) => s.theme);
  const liveActivity = useUIConfigStore((s) => s.liveActivity);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-aesthetic', aesthetic);
    root.setAttribute('data-theme', theme);
    root.setAttribute('data-live', liveActivity);
  }, [aesthetic, theme, liveActivity]);
}
