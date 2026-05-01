import { describe, it, expect, beforeEach } from 'vitest';
import { useUIConfigStore } from '../../../src/stores/useUIConfigStore';
import type { Aesthetic, Theme, BoardLayout, LiveActivity } from '../../../src/stores/useUIConfigStore';

// ── Tests ────────────────────────────────────────────────────────────────────

describe('useUIConfigStore', () => {
  beforeEach(() => {
    // Reset to defaults (the persist middleware may retain state between tests)
    useUIConfigStore.setState({
      aesthetic: 'mission',
      theme: 'dark',
      boardLayout: 'columns',
      liveActivity: 'on',
      tweaksOpen: false,
    });
  });

  // ── Initial/default state ─────────────────────────────────────────────────

  it('has correct default aesthetic', () => {
    expect(useUIConfigStore.getState().aesthetic).toBe('mission');
  });

  it('has correct default theme', () => {
    expect(useUIConfigStore.getState().theme).toBe('dark');
  });

  it('has correct default boardLayout', () => {
    expect(useUIConfigStore.getState().boardLayout).toBe('columns');
  });

  it('has correct default liveActivity', () => {
    expect(useUIConfigStore.getState().liveActivity).toBe('on');
  });

  it('has tweaksOpen defaulting to false', () => {
    expect(useUIConfigStore.getState().tweaksOpen).toBe(false);
  });

  // ── setAesthetic ──────────────────────────────────────────────────────────

  describe('setAesthetic', () => {
    it('sets to studio', () => {
      useUIConfigStore.getState().setAesthetic('studio');
      expect(useUIConfigStore.getState().aesthetic).toBe('studio');
    });

    it('sets to console', () => {
      useUIConfigStore.getState().setAesthetic('console');
      expect(useUIConfigStore.getState().aesthetic).toBe('console');
    });

    it('sets to mission', () => {
      useUIConfigStore.getState().setAesthetic('studio');
      useUIConfigStore.getState().setAesthetic('mission');
      expect(useUIConfigStore.getState().aesthetic).toBe('mission');
    });

    it('does not affect other settings', () => {
      useUIConfigStore.getState().setAesthetic('studio');
      expect(useUIConfigStore.getState().theme).toBe('dark');
      expect(useUIConfigStore.getState().boardLayout).toBe('columns');
    });
  });

  // ── setTheme ──────────────────────────────────────────────────────────────

  describe('setTheme', () => {
    it('sets to light', () => {
      useUIConfigStore.getState().setTheme('light');
      expect(useUIConfigStore.getState().theme).toBe('light');
    });

    it('sets to dark', () => {
      useUIConfigStore.getState().setTheme('light');
      useUIConfigStore.getState().setTheme('dark');
      expect(useUIConfigStore.getState().theme).toBe('dark');
    });
  });

  // ── setBoardLayout ────────────────────────────────────────────────────────

  describe('setBoardLayout', () => {
    it('sets to compact', () => {
      useUIConfigStore.getState().setBoardLayout('compact');
      expect(useUIConfigStore.getState().boardLayout).toBe('compact');
    });

    it('sets to table', () => {
      useUIConfigStore.getState().setBoardLayout('table');
      expect(useUIConfigStore.getState().boardLayout).toBe('table');
    });

    it('sets to columns', () => {
      useUIConfigStore.getState().setBoardLayout('table');
      useUIConfigStore.getState().setBoardLayout('columns');
      expect(useUIConfigStore.getState().boardLayout).toBe('columns');
    });
  });

  // ── setLiveActivity ───────────────────────────────────────────────────────

  describe('setLiveActivity', () => {
    it('sets to subtle', () => {
      useUIConfigStore.getState().setLiveActivity('subtle');
      expect(useUIConfigStore.getState().liveActivity).toBe('subtle');
    });

    it('sets to off', () => {
      useUIConfigStore.getState().setLiveActivity('off');
      expect(useUIConfigStore.getState().liveActivity).toBe('off');
    });

    it('sets to on', () => {
      useUIConfigStore.getState().setLiveActivity('off');
      useUIConfigStore.getState().setLiveActivity('on');
      expect(useUIConfigStore.getState().liveActivity).toBe('on');
    });
  });

  // ── setTweaksOpen ─────────────────────────────────────────────────────────

  describe('setTweaksOpen', () => {
    it('opens tweaks panel', () => {
      useUIConfigStore.getState().setTweaksOpen(true);
      expect(useUIConfigStore.getState().tweaksOpen).toBe(true);
    });

    it('closes tweaks panel', () => {
      useUIConfigStore.getState().setTweaksOpen(true);
      useUIConfigStore.getState().setTweaksOpen(false);
      expect(useUIConfigStore.getState().tweaksOpen).toBe(false);
    });
  });

  // ── toggleTheme ───────────────────────────────────────────────────────────

  describe('toggleTheme', () => {
    it('toggles from dark to light', () => {
      useUIConfigStore.getState().toggleTheme();
      expect(useUIConfigStore.getState().theme).toBe('light');
    });

    it('toggles from light to dark', () => {
      useUIConfigStore.getState().setTheme('light');
      useUIConfigStore.getState().toggleTheme();
      expect(useUIConfigStore.getState().theme).toBe('dark');
    });

    it('toggles back and forth', () => {
      useUIConfigStore.getState().toggleTheme(); // dark -> light
      useUIConfigStore.getState().toggleTheme(); // light -> dark
      expect(useUIConfigStore.getState().theme).toBe('dark');
    });

    it('does not affect other settings', () => {
      useUIConfigStore.getState().setAesthetic('console');
      useUIConfigStore.getState().toggleTheme();
      expect(useUIConfigStore.getState().aesthetic).toBe('console');
    });
  });
});
