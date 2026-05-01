import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { useKeyboardShortcuts } from '../../../src/hooks/useKeyboardShortcuts';

// ── Mock navigate ────────────────────────────────────────────────────────────

const mockNavigate = vi.fn();
vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// ── Test component ──────────────────────────────────────────────────────────

interface TestHarnessResult {
  isCommandPaletteOpen: boolean;
  closeCommandPalette: () => void;
}

let hookResult: TestHarnessResult;

function TestHarness() {
  const result = useKeyboardShortcuts();
  hookResult = result;
  return (
    <div>
      <span data-testid="palette-state">
        {result.isCommandPaletteOpen ? 'open' : 'closed'}
      </span>
    </div>
  );
}

function renderHook() {
  return render(
    <MemoryRouter>
      <TestHarness />
    </MemoryRouter>,
  );
}

function fireKey(
  key: string,
  opts: Partial<KeyboardEventInit> = {},
  target: EventTarget = document,
) {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...opts,
  });
  act(() => {
    target.dispatchEvent(event);
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('useKeyboardShortcuts', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Command palette ────────────────────────────────────────────────────────

  describe('command palette (Ctrl/Cmd+K)', () => {
    it('starts with command palette closed', () => {
      renderHook();
      expect(hookResult.isCommandPaletteOpen).toBe(false);
    });

    it('opens command palette with Ctrl+K', () => {
      renderHook();
      fireKey('k', { ctrlKey: true });
      expect(hookResult.isCommandPaletteOpen).toBe(true);
    });

    it('opens command palette with Meta+K', () => {
      renderHook();
      fireKey('k', { metaKey: true });
      expect(hookResult.isCommandPaletteOpen).toBe(true);
    });

    it('toggles command palette on repeated Ctrl+K', () => {
      renderHook();
      fireKey('k', { ctrlKey: true });
      expect(hookResult.isCommandPaletteOpen).toBe(true);

      fireKey('k', { ctrlKey: true });
      expect(hookResult.isCommandPaletteOpen).toBe(false);
    });

    it('closes command palette with Escape', () => {
      renderHook();
      fireKey('k', { ctrlKey: true });
      expect(hookResult.isCommandPaletteOpen).toBe(true);

      fireKey('Escape');
      expect(hookResult.isCommandPaletteOpen).toBe(false);
    });

    it('closeCommandPalette callback closes palette', () => {
      renderHook();
      fireKey('k', { ctrlKey: true });
      expect(hookResult.isCommandPaletteOpen).toBe(true);

      act(() => {
        hookResult.closeCommandPalette();
      });
      expect(hookResult.isCommandPaletteOpen).toBe(false);
    });
  });

  // ── G-then-key goto navigation ─────────────────────────────────────────────

  describe('goto navigation (G then key)', () => {
    it('navigates to /board with G then B', () => {
      renderHook();
      fireKey('g');
      fireKey('b');
      expect(mockNavigate).toHaveBeenCalledWith('/board');
    });

    it('navigates to /dashboard with G then D', () => {
      renderHook();
      fireKey('g');
      fireKey('d');
      expect(mockNavigate).toHaveBeenCalledWith('/dashboard');
    });

    it('navigates to /feed with G then F', () => {
      renderHook();
      fireKey('g');
      fireKey('f');
      expect(mockNavigate).toHaveBeenCalledWith('/feed');
    });

    it('navigates to /analytics with G then A', () => {
      renderHook();
      fireKey('g');
      fireKey('a');
      expect(mockNavigate).toHaveBeenCalledWith('/analytics');
    });

    it('navigates to /settings with G then S', () => {
      renderHook();
      fireKey('g');
      fireKey('s');
      expect(mockNavigate).toHaveBeenCalledWith('/settings');
    });

    it('does not navigate for unrecognized key after G', () => {
      renderHook();
      fireKey('g');
      fireKey('z');
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('does not navigate without pressing G first', () => {
      renderHook();
      fireKey('b');
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('handles uppercase G', () => {
      renderHook();
      fireKey('G');
      fireKey('b');
      expect(mockNavigate).toHaveBeenCalledWith('/board');
    });

    it('handles uppercase destination key', () => {
      renderHook();
      fireKey('g');
      fireKey('B');
      expect(mockNavigate).toHaveBeenCalledWith('/board');
    });

    it('does not trigger G chord when modifier keys are held', () => {
      renderHook();
      fireKey('g', { ctrlKey: true });
      fireKey('b');
      expect(mockNavigate).not.toHaveBeenCalled();
    });
  });

  // ── Input suppression ─────────────────────────────────────────────────────

  describe('input element suppression', () => {
    it('does not trigger shortcuts when typing in INPUT', () => {
      const { container } = renderHook();
      const input = document.createElement('input');
      container.appendChild(input);

      fireKey('g', {}, input);
      fireKey('b', {}, input);
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('does not trigger shortcuts when typing in TEXTAREA', () => {
      const { container } = renderHook();
      const textarea = document.createElement('textarea');
      container.appendChild(textarea);

      fireKey('g', {}, textarea);
      fireKey('b', {}, textarea);
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('does not trigger shortcuts when typing in SELECT', () => {
      const { container } = renderHook();
      const select = document.createElement('select');
      container.appendChild(select);

      fireKey('g', {}, select);
      fireKey('b', {}, select);
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('allows Escape even in input elements', () => {
      renderHook();
      fireKey('k', { ctrlKey: true });
      expect(hookResult.isCommandPaletteOpen).toBe(true);

      const input = document.createElement('input');
      document.body.appendChild(input);
      fireKey('Escape', {}, input);
      expect(hookResult.isCommandPaletteOpen).toBe(false);
      document.body.removeChild(input);
    });
  });
});
