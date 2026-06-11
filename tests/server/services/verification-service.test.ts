import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeMigratedDb } from '../helpers/db-fixture';
import { createVerificationService } from '../../../server/services/verification-service';
import type { Goal } from '../../../src/shared/types';
import type Database from 'better-sqlite3';

vi.mock('../../../server/ws', () => ({ broadcast: vi.fn() }));
vi.mock('../../../server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let db: Database.Database;
beforeEach(() => {
  db = makeMigratedDb();
});
afterEach(() => db.close());

const noDeps = { resolveDoneCommand: () => null, resolveWorkspace: (g: Goal) => g.cwd };

describe('VerificationService records & queries', () => {
  it('records a result and reads it back as the latest for a goal', () => {
    const svc = createVerificationService(db, noDeps);
    const r = svc.record({
      goal_id: 'g1',
      session_id: 's1',
      status: 'pass',
      command: 'npm test',
      workspace: '/repo',
      exit_code: 0,
      output: 'ok',
      duration_ms: 100,
      model: 'opus',
    });
    expect(r.id).toBeTruthy();
    expect(svc.latestForGoal('g1')?.status).toBe('pass');
    expect(svc.latestForGoal('g1')?.command).toBe('npm test');
  });

  it('truncates output to 16k characters', () => {
    const svc = createVerificationService(db, noDeps);
    const r = svc.record({
      goal_id: 'g1',
      session_id: null,
      status: 'fail',
      command: 'npm test',
      workspace: '/repo',
      exit_code: 1,
      output: 'x'.repeat(20_000),
      duration_ms: 100,
      model: null,
    });
    expect(r.output!.length).toBe(16_000);
  });

  it('computes a model scorecard (pass rate per model, ignoring skipped/running)', () => {
    const svc = createVerificationService(db, noDeps);
    const base = { session_id: null, command: 'c', workspace: '/r', exit_code: 0, output: '', duration_ms: 1 };
    svc.record({ ...base, goal_id: 'g1', status: 'pass', model: 'opus' });
    svc.record({ ...base, goal_id: 'g2', status: 'pass', model: 'opus' });
    svc.record({ ...base, goal_id: 'g3', status: 'fail', model: 'opus' });
    svc.record({ ...base, goal_id: 'g4', status: 'skipped', model: 'opus' });
    svc.record({ ...base, goal_id: 'g5', status: 'pass', model: 'sonnet' });
    const opus = svc.modelScorecard().find((r) => r.model === 'opus')!;
    expect(opus.total).toBe(3);
    expect(opus.pass).toBe(2);
    expect(opus.fail).toBe(1);
    expect(opus.passRate).toBeCloseTo(2 / 3);
  });
});

describe('VerificationService runForGoal', () => {
  const goal = { id: 'g1', cwd: process.cwd(), model: 'opus' } as unknown as Goal;

  it('records "skipped" when no doneCommand is configured', async () => {
    const svc = createVerificationService(db, noDeps);
    const r = await svc.runForGoal(goal, 's1');
    expect(r.status).toBe('skipped');
    expect(r.command).toBeNull();
  });

  it('records "pass" when the command exits 0', async () => {
    const svc = createVerificationService(db, {
      resolveDoneCommand: () => 'node -e "process.exit(0)"',
      resolveWorkspace: (g) => g.cwd,
    });
    const r = await svc.runForGoal(goal, 's1');
    expect(r.status).toBe('pass');
    expect(r.exit_code).toBe(0);
    expect(r.model).toBe('opus');
  });

  it('records "fail" when the command exits non-zero and captures output', async () => {
    const svc = createVerificationService(db, {
      resolveDoneCommand: () => 'node -e "console.error(\'boom\'); process.exit(1)"',
      resolveWorkspace: (g) => g.cwd,
    });
    const r = await svc.runForGoal(goal, 's1');
    expect(r.status).toBe('fail');
    expect(r.exit_code).toBe(1);
    expect(r.output).toContain('boom');
  });
});
