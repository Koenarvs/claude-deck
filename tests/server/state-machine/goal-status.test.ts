import { describe, it, expect } from 'vitest';
import { canTransition, allowedTransitions } from '../../../server/state-machine/goal-status';
import type { GoalStatus } from '../../../src/shared/types';

describe('goal-status state machine', () => {
  describe('canTransition', () => {
    // ── Valid transitions ───────────────────────────────────────────────

    it('planning → active is allowed', () => {
      expect(canTransition('planning', 'active')).toBe(true);
    });

    it('planning → complete is allowed', () => {
      expect(canTransition('planning', 'complete')).toBe(true);
    });

    it('planning → archived is allowed', () => {
      expect(canTransition('planning', 'archived')).toBe(true);
    });

    it('active → waiting is allowed', () => {
      expect(canTransition('active', 'waiting')).toBe(true);
    });

    it('active → complete is allowed', () => {
      expect(canTransition('active', 'complete')).toBe(true);
    });

    it('active → archived is allowed', () => {
      expect(canTransition('active', 'archived')).toBe(true);
    });

    it('waiting → active is allowed', () => {
      expect(canTransition('waiting', 'active')).toBe(true);
    });

    it('waiting → complete is allowed', () => {
      expect(canTransition('waiting', 'complete')).toBe(true);
    });

    it('waiting → archived is allowed', () => {
      expect(canTransition('waiting', 'archived')).toBe(true);
    });

    it('complete → active is allowed (reopen)', () => {
      expect(canTransition('complete', 'active')).toBe(true);
    });

    it('complete → archived is allowed', () => {
      expect(canTransition('complete', 'archived')).toBe(true);
    });

    // ── Invalid transitions ─────────────────────────────────────────────

    it('archived → active is blocked (terminal state)', () => {
      expect(canTransition('archived', 'active')).toBe(false);
    });

    it('archived → planning is blocked', () => {
      expect(canTransition('archived', 'planning')).toBe(false);
    });

    it('archived → waiting is blocked', () => {
      expect(canTransition('archived', 'waiting')).toBe(false);
    });

    it('archived → complete is blocked', () => {
      expect(canTransition('archived', 'complete')).toBe(false);
    });

    it('planning → waiting is blocked (must go through active)', () => {
      expect(canTransition('planning', 'waiting')).toBe(false);
    });

    it('active → planning is blocked (no backward to planning)', () => {
      expect(canTransition('active', 'planning')).toBe(false);
    });

    it('waiting → planning is blocked', () => {
      expect(canTransition('waiting', 'planning')).toBe(false);
    });

    it('complete → planning is blocked', () => {
      expect(canTransition('complete', 'planning')).toBe(false);
    });

    it('complete → waiting is blocked', () => {
      expect(canTransition('complete', 'waiting')).toBe(false);
    });

    // ── Identity transitions ────────────────────────────────────────────

    it('same status → same status is blocked', () => {
      const statuses: GoalStatus[] = ['planning', 'active', 'waiting', 'complete', 'archived'];
      for (const s of statuses) {
        expect(canTransition(s, s)).toBe(false);
      }
    });
  });

  describe('allowedTransitions', () => {
    it('planning can reach active, complete, archived', () => {
      const targets = allowedTransitions('planning');
      expect(targets).toContain('active');
      expect(targets).toContain('complete');
      expect(targets).toContain('archived');
      expect(targets).toHaveLength(3);
    });

    it('active can reach waiting, complete, archived', () => {
      const targets = allowedTransitions('active');
      expect(targets).toContain('waiting');
      expect(targets).toContain('complete');
      expect(targets).toContain('archived');
      expect(targets).toHaveLength(3);
    });

    it('waiting can reach active, complete, archived', () => {
      const targets = allowedTransitions('waiting');
      expect(targets).toContain('active');
      expect(targets).toContain('complete');
      expect(targets).toContain('archived');
      expect(targets).toHaveLength(3);
    });

    it('complete can reach active, archived', () => {
      const targets = allowedTransitions('complete');
      expect(targets).toContain('active');
      expect(targets).toContain('archived');
      expect(targets).toHaveLength(2);
    });

    it('archived has no valid transitions', () => {
      const targets = allowedTransitions('archived');
      expect(targets).toHaveLength(0);
    });
  });
});
