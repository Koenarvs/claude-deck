import { useEffect, useRef, useCallback, useState } from 'react';
import { useNavigate } from 'react-router';

/**
 * Route targets for G-then-key goto shortcuts.
 */
const GOTO_MAP: Record<string, string> = {
  b: '/board',
  d: '/dashboard',
  f: '/feed',
  a: '/analytics',
  s: '/settings',
};

/** Time window for G-then-key chord in ms. */
const CHORD_TIMEOUT_MS = 1000;

/**
 * Global keyboard shortcuts hook.
 *
 * - `Cmd/Ctrl+K` — opens command palette (stub modal)
 * - `G then B/D/F/A/S` — goto navigation
 * - `Esc` — closes modals (fires onEscape callback)
 *
 * Returns state and callbacks for the command palette.
 */
export function useKeyboardShortcuts(): {
  isCommandPaletteOpen: boolean;
  closeCommandPalette: () => void;
} {
  const navigate = useNavigate();
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const gPressedRef = useRef(false);
  const chordTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const closeCommandPalette = useCallback(() => {
    setIsCommandPaletteOpen(false);
  }, []);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      const target = e.target as HTMLElement;

      // Skip shortcuts when typing in inputs/textareas/contenteditable
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      ) {
        // Allow Esc even in inputs
        if (e.key === 'Escape') {
          setIsCommandPaletteOpen(false);
        }
        return;
      }

      // Cmd/Ctrl + K — command palette
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setIsCommandPaletteOpen((prev) => !prev);
        return;
      }

      // Esc — close modals
      if (e.key === 'Escape') {
        setIsCommandPaletteOpen(false);
        return;
      }

      // G-then-key chord for navigation
      if (e.key.toLowerCase() === 'g' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        gPressedRef.current = true;

        if (chordTimerRef.current !== null) {
          clearTimeout(chordTimerRef.current);
        }

        chordTimerRef.current = setTimeout(() => {
          gPressedRef.current = false;
          chordTimerRef.current = null;
        }, CHORD_TIMEOUT_MS);

        return;
      }

      // If G was pressed recently, check for goto target
      if (gPressedRef.current) {
        const key = e.key.toLowerCase();
        const route = GOTO_MAP[key];

        if (route) {
          e.preventDefault();
          navigate(route);
        }

        // Reset chord state
        gPressedRef.current = false;
        if (chordTimerRef.current !== null) {
          clearTimeout(chordTimerRef.current);
          chordTimerRef.current = null;
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (chordTimerRef.current !== null) {
        clearTimeout(chordTimerRef.current);
      }
    };
  }, [navigate]);

  return { isCommandPaletteOpen, closeCommandPalette };
}
