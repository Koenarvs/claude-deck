import cron from 'node-cron';
import type Database from 'better-sqlite3';
import { pruneLogFiles, pruneHookEvents } from './log-pruner';
import logger from './logger';

/**
 * Schedules a daily (03:10, offset from the 03:00 trace prune) retention job for
 * server log files and hook_events rows. Both retention getters are read on each
 * fire so Settings changes take effect without a restart. Returns the cron task
 * (call .stop() on shutdown).
 */
export function startLogPruneJob(
  db: Database.Database,
  logDir: string,
  getLogRetentionDays: () => number,
  getHookEventRetentionDays: () => number,
) {
  const task = cron.schedule('10 3 * * *', () => {
    try {
      const logDays = getLogRetentionDays();
      const files = pruneLogFiles(logDir, logDays);
      const hookDays = getHookEventRetentionDays();
      const rows = pruneHookEvents(db, hookDays);
      logger.info({ files, logDays, rows, hookDays }, 'Scheduled log/hook-event prune complete');
    } catch (err) {
      logger.error({ err }, 'Scheduled log/hook-event prune failed');
    }
  });
  logger.info('Log prune job scheduled (daily 03:10)');
  return task;
}
