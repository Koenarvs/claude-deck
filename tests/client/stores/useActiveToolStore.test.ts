import { describe, it, expect, beforeEach } from 'vitest';
import { useActiveToolStore } from '../../../src/stores/useActiveToolStore';

// ── Tests ────────────────────────────────────────────────────────────────────

describe('useActiveToolStore', () => {
  beforeEach(() => {
    useActiveToolStore.setState({ bySessionId: {} });
  });

  // ── Initial state ──────────────────────────────────────────────────────────

  it('starts with empty bySessionId map', () => {
    expect(useActiveToolStore.getState().bySessionId).toEqual({});
  });

  // ── setActiveTool ─────────────────────────────────────────────────────────

  describe('setActiveTool', () => {
    it('sets a tool name for a session', () => {
      useActiveToolStore.getState().setActiveTool('sess-1', 'Bash');
      expect(useActiveToolStore.getState().bySessionId['sess-1']).toBe('Bash');
    });

    it('sets null to clear the active tool for a session', () => {
      useActiveToolStore.getState().setActiveTool('sess-1', 'Bash');
      useActiveToolStore.getState().setActiveTool('sess-1', null);
      expect(useActiveToolStore.getState().bySessionId['sess-1']).toBeNull();
    });

    it('tracks multiple sessions independently', () => {
      useActiveToolStore.getState().setActiveTool('sess-1', 'Bash');
      useActiveToolStore.getState().setActiveTool('sess-2', 'Read');
      useActiveToolStore.getState().setActiveTool('sess-3', 'Write');

      const state = useActiveToolStore.getState().bySessionId;
      expect(state['sess-1']).toBe('Bash');
      expect(state['sess-2']).toBe('Read');
      expect(state['sess-3']).toBe('Write');
    });

    it('overwrites previous tool for same session', () => {
      useActiveToolStore.getState().setActiveTool('sess-1', 'Bash');
      useActiveToolStore.getState().setActiveTool('sess-1', 'Edit');
      expect(useActiveToolStore.getState().bySessionId['sess-1']).toBe('Edit');
    });

    it('does not affect other sessions when updating one', () => {
      useActiveToolStore.getState().setActiveTool('sess-1', 'Bash');
      useActiveToolStore.getState().setActiveTool('sess-2', 'Read');
      useActiveToolStore.getState().setActiveTool('sess-1', 'Write');

      expect(useActiveToolStore.getState().bySessionId['sess-2']).toBe('Read');
    });
  });

  // ── clearSession ──────────────────────────────────────────────────────────

  describe('clearSession', () => {
    it('removes a session entry from the map', () => {
      useActiveToolStore.getState().setActiveTool('sess-1', 'Bash');
      useActiveToolStore.getState().clearSession('sess-1');
      expect(useActiveToolStore.getState().bySessionId).not.toHaveProperty('sess-1');
    });

    it('does nothing when session id not found', () => {
      useActiveToolStore.getState().setActiveTool('sess-1', 'Bash');
      useActiveToolStore.getState().clearSession('nonexistent');
      expect(useActiveToolStore.getState().bySessionId['sess-1']).toBe('Bash');
    });

    it('clears from empty store without error', () => {
      useActiveToolStore.getState().clearSession('ghost');
      expect(useActiveToolStore.getState().bySessionId).toEqual({});
    });

    it('does not affect other sessions', () => {
      useActiveToolStore.getState().setActiveTool('sess-1', 'Bash');
      useActiveToolStore.getState().setActiveTool('sess-2', 'Read');
      useActiveToolStore.getState().clearSession('sess-1');

      const state = useActiveToolStore.getState().bySessionId;
      expect(state).not.toHaveProperty('sess-1');
      expect(state['sess-2']).toBe('Read');
    });

    it('allows re-setting tool after clearing', () => {
      useActiveToolStore.getState().setActiveTool('sess-1', 'Bash');
      useActiveToolStore.getState().clearSession('sess-1');
      useActiveToolStore.getState().setActiveTool('sess-1', 'Edit');
      expect(useActiveToolStore.getState().bySessionId['sess-1']).toBe('Edit');
    });
  });
});
