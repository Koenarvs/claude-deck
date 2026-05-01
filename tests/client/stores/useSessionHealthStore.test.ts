import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  useSessionHealthStore,
  estimateContextUsage,
} from '../../../src/stores/useSessionHealthStore';

// ── Tests ────────────────────────────────────────────────────────────────────

describe('useSessionHealthStore', () => {
  beforeEach(() => {
    useSessionHealthStore.setState({ bySessionId: {} });
    vi.restoreAllMocks();
  });

  // ── Initial state ──────────────────────────────────────────────────────────

  it('starts with empty bySessionId map', () => {
    expect(useSessionHealthStore.getState().bySessionId).toEqual({});
  });

  // ── updateHealth ──────────────────────────────────────────────────────────

  describe('updateHealth', () => {
    it('creates a new health entry with defaults when none exists', () => {
      const now = 1700001000000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      useSessionHealthStore.getState().updateHealth('sess-1', { totalTokensIn: 500 });

      const health = useSessionHealthStore.getState().bySessionId['sess-1'];
      expect(health).toBeDefined();
      expect(health.sessionId).toBe('sess-1');
      expect(health.goalId).toBeNull();
      expect(health.totalTokensIn).toBe(500);
      expect(health.totalTokensOut).toBe(0);
      expect(health.totalCost).toBe(0);
      expect(health.turnCount).toBe(0);
      expect(health.contextWindowUsed).toBe(0);
      expect(health.lastUpdated).toBe(now);
    });

    it('merges updates into existing health entry', () => {
      useSessionHealthStore.getState().updateHealth('sess-1', {
        totalTokensIn: 100,
        totalTokensOut: 50,
      });

      useSessionHealthStore.getState().updateHealth('sess-1', {
        totalTokensIn: 200,
        turnCount: 3,
      });

      const health = useSessionHealthStore.getState().bySessionId['sess-1'];
      expect(health.totalTokensIn).toBe(200);
      expect(health.totalTokensOut).toBe(50); // preserved from first update
      expect(health.turnCount).toBe(3);
    });

    it('always updates lastUpdated timestamp', () => {
      vi.spyOn(Date, 'now').mockReturnValue(1000);
      useSessionHealthStore.getState().updateHealth('sess-1', {});

      vi.spyOn(Date, 'now').mockReturnValue(2000);
      useSessionHealthStore.getState().updateHealth('sess-1', {});

      expect(useSessionHealthStore.getState().bySessionId['sess-1'].lastUpdated).toBe(2000);
    });

    it('tracks multiple sessions independently', () => {
      useSessionHealthStore.getState().updateHealth('sess-1', { totalCost: 0.05 });
      useSessionHealthStore.getState().updateHealth('sess-2', { totalCost: 0.10 });

      const state = useSessionHealthStore.getState().bySessionId;
      expect(state['sess-1'].totalCost).toBe(0.05);
      expect(state['sess-2'].totalCost).toBe(0.10);
    });

    it('does not affect other sessions when updating one', () => {
      useSessionHealthStore.getState().updateHealth('sess-1', { turnCount: 5 });
      useSessionHealthStore.getState().updateHealth('sess-2', { turnCount: 10 });
      useSessionHealthStore.getState().updateHealth('sess-1', { turnCount: 6 });

      expect(useSessionHealthStore.getState().bySessionId['sess-2'].turnCount).toBe(10);
    });

    it('sets goalId when provided', () => {
      useSessionHealthStore.getState().updateHealth('sess-1', { goalId: 'goal-abc' });
      expect(useSessionHealthStore.getState().bySessionId['sess-1'].goalId).toBe('goal-abc');
    });

    it('can update contextWindowUsed', () => {
      useSessionHealthStore.getState().updateHealth('sess-1', { contextWindowUsed: 75 });
      expect(useSessionHealthStore.getState().bySessionId['sess-1'].contextWindowUsed).toBe(75);
    });
  });

  // ── removeHealth ──────────────────────────────────────────────────────────

  describe('removeHealth', () => {
    it('removes a session health entry', () => {
      useSessionHealthStore.getState().updateHealth('sess-1', { turnCount: 5 });
      useSessionHealthStore.getState().removeHealth('sess-1');
      expect(useSessionHealthStore.getState().bySessionId).not.toHaveProperty('sess-1');
    });

    it('does nothing when session not found', () => {
      useSessionHealthStore.getState().updateHealth('sess-1', { turnCount: 5 });
      useSessionHealthStore.getState().removeHealth('nonexistent');
      expect(useSessionHealthStore.getState().bySessionId['sess-1']).toBeDefined();
    });

    it('handles removing from empty store', () => {
      useSessionHealthStore.getState().removeHealth('ghost');
      expect(useSessionHealthStore.getState().bySessionId).toEqual({});
    });

    it('does not affect other sessions', () => {
      useSessionHealthStore.getState().updateHealth('sess-1', { turnCount: 5 });
      useSessionHealthStore.getState().updateHealth('sess-2', { turnCount: 10 });
      useSessionHealthStore.getState().removeHealth('sess-1');

      const state = useSessionHealthStore.getState().bySessionId;
      expect(state).not.toHaveProperty('sess-1');
      expect(state['sess-2'].turnCount).toBe(10);
    });
  });
});

// ── estimateContextUsage (pure function) ────────────────────────────────────

describe('estimateContextUsage (1M context window)', () => {
  it('returns 0 for 0 tokens', () => {
    expect(estimateContextUsage(0)).toBe(0);
  });

  it('calculates 10% for 100K tokens', () => {
    expect(estimateContextUsage(100_000)).toBe(10);
  });

  it('calculates 50% for half window', () => {
    expect(estimateContextUsage(500_000)).toBe(50);
  });

  it('calculates 100% for exact window size', () => {
    expect(estimateContextUsage(1_000_000)).toBe(100);
  });

  it('caps at 100% for tokens over window size', () => {
    expect(estimateContextUsage(1_500_000)).toBe(100);
  });

  it('rounds to nearest integer', () => {
    // 33,333 / 1,000,000 = 0.033333 -> 3%
    expect(estimateContextUsage(33_333)).toBe(3);
  });

  it('returns 0% for small token count', () => {
    // 1,000 / 1,000,000 = 0.001 -> 0%
    expect(estimateContextUsage(1_000)).toBe(0);
  });

  it('returns 20% for 200K tokens', () => {
    expect(estimateContextUsage(200_000)).toBe(20);
  });
});
