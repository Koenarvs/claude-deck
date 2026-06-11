import { describe, it, expect, vi } from 'vitest';
import { resumeOrphans } from '../../server/resume-driver';
import type { Orphan } from '../../server/services/reconciliation-service';

vi.mock('../../server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function orphan(over: Partial<Orphan> = {}): Orphan {
  return {
    goalId: 'g1',
    sessionId: 'g1',
    providerSessionId: 'g1',
    workspacePath: 'C:/wt/g1',
    model: 'sonnet',
    cwd: 'C:/repo',
    permissionMode: 'supervised',
    ...over,
  };
}

describe('resumeOrphans (5D)', () => {
  it('resumes each orphan via the injected resume callback', () => {
    const resumed: string[] = [];
    resumeOrphans([orphan({ goalId: 'a' }), orphan({ goalId: 'b' })], {
      canResume: () => true,
      resume: (o) => resumed.push(o.goalId),
    });
    expect(resumed).toEqual(['a', 'b']);
  });

  it('skips orphans whose provider cannot resume', () => {
    const resumed: string[] = [];
    resumeOrphans([orphan({ goalId: 'a', model: 'codex' })], {
      canResume: (model) => model !== 'codex',
      resume: (o) => resumed.push(o.goalId),
    });
    expect(resumed).toEqual([]);
  });

  it('skips orphans missing a providerSessionId (nothing to resume)', () => {
    const resumed: string[] = [];
    resumeOrphans([orphan({ providerSessionId: null })], {
      canResume: () => true,
      resume: (o) => resumed.push(o.goalId),
    });
    expect(resumed).toEqual([]);
  });

  it('continues the batch even if one resume throws', () => {
    const resumed: string[] = [];
    resumeOrphans([orphan({ goalId: 'bad' }), orphan({ goalId: 'good' })], {
      canResume: () => true,
      resume: (o) => {
        if (o.goalId === 'bad') throw new Error('boom');
        resumed.push(o.goalId);
      },
    });
    expect(resumed).toEqual(['good']);
  });
});
