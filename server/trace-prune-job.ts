import cron from 'node-cron';
import type Database from 'better-sqlite3';
import { pruneTraces } from './trace-pruner';
import logger from './logger';

/**
 * Schedules a daily (03:00) trace-pruning job. `getPruneDays` is read on each
 * fire so Settings changes take effect without a restart. `dataDir` is the base
 * data directory (pruneTraces resolves <dataDir>/traces/ itself). Returns the
 * cron task (call .stop() on shutdown).
 */
export function startTracePruneJob(
  db: Database.Database,
  dataDir: string,
  getPruneDays: () => number,
) {
  const task = cron.schedule('0 3 * * *', () => {
    try {
      const days = getPruneDays();
      const pruned = pruneTraces(db, dataDir, days);
      logger.info({ pruned, days }, 'Scheduled trace prune complete');
    } catch (err) {
      logger.error({ err }, 'Scheduled trace prune failed');
    }
  });
  logger.info('Trace prune job scheduled (daily 03:00)');
  return task;
}
