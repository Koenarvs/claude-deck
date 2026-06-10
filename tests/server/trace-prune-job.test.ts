import { describe, it, expect, vi, beforeEach } from 'vitest';

let registered: (() => void) | null = null;
vi.mock('node-cron', () => ({
  default: { schedule: (_expr: string, cb: () => void) => { registered = cb; return { stop: vi.fn() }; } },
}));

const pruneMock = vi.fn().mockReturnValue(0);
vi.mock('../../server/trace-pruner', () => ({ pruneTraces: (...a: unknown[]) => pruneMock(...a) }));

import Database from 'better-sqlite3';
import { runMigrations } from '../../server/db/migrate';
import { startTracePruneJob } from '../../server/trace-prune-job';

describe('startTracePruneJob', () => {
  beforeEach(() => { registered = null; pruneMock.mockClear(); });

  it('runs pruneTraces with the value from getPruneDays() each fire', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    let days = 90;
    const task = startTracePruneJob(db, '/data', () => days);
    expect(registered).toBeTypeOf('function');

    registered!();
    expect(pruneMock).toHaveBeenLastCalledWith(db, '/data', 90);

    days = 7; // Settings changed at runtime
    registered!();
    expect(pruneMock).toHaveBeenLastCalledWith(db, '/data', 7);

    task.stop();
    db.close();
  });
});
