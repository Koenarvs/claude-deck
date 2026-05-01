import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useApprovalsStore } from '../../../src/stores/useApprovalsStore';
import type { Approval, ApprovalDecision } from '../../../src/shared/types';

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: 'approval-1',
    session_id: 'sess-1',
    goal_id: 'goal-1',
    tool_name: 'Bash',
    tool_args: '{"command":"rm -rf /tmp/test"}',
    status: 'pending',
    decided_reason: null,
    requested_at: 1700000000000,
    resolved_at: null,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('useApprovalsStore', () => {
  beforeEach(() => {
    useApprovalsStore.setState({ pending: [], resolved: [] });
    vi.restoreAllMocks();
  });

  // ── Initial state ──────────────────────────────────────────────────────────

  it('starts with empty pending and resolved arrays', () => {
    const state = useApprovalsStore.getState();
    expect(state.pending).toEqual([]);
    expect(state.resolved).toEqual([]);
  });

  // ── addPending ─────────────────────────────────────────────────────────────

  describe('addPending', () => {
    it('adds an approval to pending', () => {
      const approval = makeApproval({ id: 'a1' });
      useApprovalsStore.getState().addPending(approval);
      expect(useApprovalsStore.getState().pending).toHaveLength(1);
      expect(useApprovalsStore.getState().pending[0].id).toBe('a1');
    });

    it('appends multiple pending approvals', () => {
      useApprovalsStore.getState().addPending(makeApproval({ id: 'a1' }));
      useApprovalsStore.getState().addPending(makeApproval({ id: 'a2' }));
      useApprovalsStore.getState().addPending(makeApproval({ id: 'a3' }));
      expect(useApprovalsStore.getState().pending).toHaveLength(3);
    });

    it('does not affect resolved list', () => {
      useApprovalsStore.getState().addPending(makeApproval());
      expect(useApprovalsStore.getState().resolved).toEqual([]);
    });

    it('allows duplicate ids (no dedup)', () => {
      const approval = makeApproval({ id: 'dup' });
      useApprovalsStore.getState().addPending(approval);
      useApprovalsStore.getState().addPending(approval);
      expect(useApprovalsStore.getState().pending).toHaveLength(2);
    });
  });

  // ── markResolved ───────────────────────────────────────────────────────────

  describe('markResolved', () => {
    it('moves approval from pending to resolved with approved decision', () => {
      const now = 1700001000000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      useApprovalsStore.getState().addPending(makeApproval({ id: 'a1' }));
      useApprovalsStore.getState().markResolved('a1', 'approved');

      const state = useApprovalsStore.getState();
      expect(state.pending).toHaveLength(0);
      expect(state.resolved).toHaveLength(1);
      expect(state.resolved[0].id).toBe('a1');
      expect(state.resolved[0].status).toBe('approved');
      expect(state.resolved[0].resolved_at).toBe(now);
    });

    it('moves approval from pending to resolved with denied decision', () => {
      useApprovalsStore.getState().addPending(makeApproval({ id: 'a1' }));
      useApprovalsStore.getState().markResolved('a1', 'denied');

      const state = useApprovalsStore.getState();
      expect(state.pending).toHaveLength(0);
      expect(state.resolved[0].status).toBe('denied');
    });

    it('moves approval from pending to resolved with timeout decision', () => {
      useApprovalsStore.getState().addPending(makeApproval({ id: 'a1' }));
      useApprovalsStore.getState().markResolved('a1', 'timeout');

      const state = useApprovalsStore.getState();
      expect(state.resolved[0].status).toBe('timeout');
    });

    it('does nothing when id not found in pending', () => {
      useApprovalsStore.getState().addPending(makeApproval({ id: 'a1' }));
      useApprovalsStore.getState().markResolved('nonexistent', 'approved');

      const state = useApprovalsStore.getState();
      expect(state.pending).toHaveLength(1);
      expect(state.resolved).toHaveLength(0);
    });

    it('prepends resolved items (most recent first)', () => {
      useApprovalsStore.getState().addPending(makeApproval({ id: 'a1' }));
      useApprovalsStore.getState().addPending(makeApproval({ id: 'a2' }));

      useApprovalsStore.getState().markResolved('a1', 'approved');
      useApprovalsStore.getState().markResolved('a2', 'denied');

      const resolved = useApprovalsStore.getState().resolved;
      expect(resolved[0].id).toBe('a2');
      expect(resolved[1].id).toBe('a1');
    });

    it('only removes the matching approval from pending', () => {
      useApprovalsStore.getState().addPending(makeApproval({ id: 'a1' }));
      useApprovalsStore.getState().addPending(makeApproval({ id: 'a2' }));
      useApprovalsStore.getState().addPending(makeApproval({ id: 'a3' }));

      useApprovalsStore.getState().markResolved('a2', 'approved');

      const pending = useApprovalsStore.getState().pending;
      expect(pending).toHaveLength(2);
      expect(pending.map((a) => a.id)).toEqual(['a1', 'a3']);
    });

    it('caps resolved at MAX_RESOLVED (100)', () => {
      // Pre-fill 100 resolved items
      const preResolved = Array.from({ length: 100 }, (_, i) =>
        makeApproval({ id: `pre-${i}`, status: 'approved', resolved_at: 1700000000000 + i }),
      );
      useApprovalsStore.setState({ pending: [], resolved: preResolved });

      // Add one more pending and resolve it
      useApprovalsStore.getState().addPending(makeApproval({ id: 'overflow' }));
      useApprovalsStore.getState().markResolved('overflow', 'approved');

      const resolved = useApprovalsStore.getState().resolved;
      expect(resolved).toHaveLength(100);
      expect(resolved[0].id).toBe('overflow'); // newest is first
      expect(resolved[99].id).toBe('pre-98'); // oldest pre-filled dropped off
    });

    it('handles empty pending gracefully', () => {
      useApprovalsStore.getState().markResolved('ghost', 'approved');

      const state = useApprovalsStore.getState();
      expect(state.pending).toEqual([]);
      expect(state.resolved).toEqual([]);
    });
  });
});
