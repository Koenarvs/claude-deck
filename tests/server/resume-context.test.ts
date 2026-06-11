import { describe, it, expect } from 'vitest';
import { buildResumeContext } from '../../server/resume-context';
import type { Orphan } from '../../server/services/reconciliation-service';

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

describe('buildResumeContext (5D)', () => {
  it('prefers the workspace path as cwd', () => {
    const ctx = buildResumeContext(orphan());
    expect(ctx.goalId).toBe('g1');
    expect(ctx.model).toBe('sonnet');
    expect(ctx.cwd).toBe('C:/wt/g1');
    expect(ctx.permissionMode).toBe('supervised');
    expect(ctx.mcpServer).toBeNull();
  });

  it('falls back to goal cwd when there is no workspace, and default model', () => {
    const ctx = buildResumeContext(orphan({ workspacePath: null, model: null }));
    expect(ctx.cwd).toBe('C:/repo');
    expect(ctx.model).toBe('default');
  });
});
