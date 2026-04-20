import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import logger from './logger';

/**
 * Prunes old trace directories from disk and marks their sessions as pruned.
 *
 * A session is eligible for pruning when:
 *   ended_at + (pruneDays * 86400000) < now
 *
 * The pruner:
 * 1. Queries sessions with ended_at older than the threshold
 * 2. Removes the trace directory from disk (rm -rf equivalent)
 * 3. Sets trace_dir = NULL in the sessions table
 *
 * @param db - The SQLite database connection.
 * @param dataDir - The root data directory (traces live under <dataDir>/traces/).
 * @param pruneDays - Number of days after session end before pruning. Defaults to 90.
 * @returns The number of trace directories removed.
 */
export function pruneTraces(db: Database.Database, dataDir: string, pruneDays = 90): number {
  const cutoffMs = Date.now() - pruneDays * 86_400_000;
  const tracesDir = path.join(dataDir, 'traces');

  // Find sessions eligible for pruning
  const stmt = db.prepare(`
    SELECT id, trace_dir
    FROM sessions
    WHERE ended_at IS NOT NULL
      AND ended_at < ?
      AND trace_dir IS NOT NULL
  `);

  const rows = stmt.all(cutoffMs) as Array<{ id: string; trace_dir: string }>;

  if (rows.length === 0) {
    logger.debug({ cutoffMs, pruneDays }, 'No trace directories eligible for pruning');
    return 0;
  }

  const clearTraceDir = db.prepare(`
    UPDATE sessions SET trace_dir = NULL WHERE id = ?
  `);

  let pruned = 0;

  for (const row of rows) {
    const dir = row.trace_dir;

    // Safety: only remove directories under our traces/ root
    const resolved = path.resolve(dir);
    const tracesResolved = path.resolve(tracesDir);
    if (!resolved.startsWith(tracesResolved)) {
      logger.warn(
        { sessionId: row.id, traceDir: dir },
        'Skipping prune: trace_dir is outside traces/ root',
      );
      continue;
    }

    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        logger.debug({ sessionId: row.id, traceDir: dir }, 'Removed trace directory');
      }
      clearTraceDir.run(row.id);
      pruned++;
    } catch (err) {
      logger.error({ err, sessionId: row.id, traceDir: dir }, 'Failed to prune trace directory');
    }
  }

  logger.info({ pruned, total: rows.length, pruneDays }, 'Trace pruning complete');
  return pruned;
}
