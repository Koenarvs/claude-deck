import { describe, it, expect, vi } from 'vitest';
import { drainSessions } from '../../server/drain';

vi.mock('../../server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('drainSessions (5D)', () => {
  it('persists resume state for each live goal before returning', () => {
    const persisted: string[] = [];
    drainSessions(['g1', 'g2'], (goalId) => {
      persisted.push(goalId);
    });
    expect(persisted).toEqual(['g1', 'g2']);
  });

  it('continues persisting even if one callback throws', () => {
    const persisted: string[] = [];
    drainSessions(['bad', 'good'], (goalId) => {
      if (goalId === 'bad') throw new Error('boom');
      persisted.push(goalId);
    });
    expect(persisted).toEqual(['good']);
  });
});
