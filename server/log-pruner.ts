import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import logger from './logger';

const LOG_FILE_RE = /^deck-(\d{4})-(\d{2})-(\d{2})\.log$/;

/**
 * Delete daily log files older than `retentionDays`. The date is taken from the
 * filename (deck-YYYY-MM-DD.log, written by the rotating sink in logger.ts) so
 * pruning never has to stat or parse file contents. Returns deleted count.
 */
export function pruneLogFiles(logDir: string, retentionDays: number): number {
  if (retentionDays < 1 || !existsSync(logDir)) return 0;
  const cutoff = Date.now() - retentionDays * 86_400_000;
  let deleted = 0;
  for (const name of readdirSync(logDir)) {
    const m = LOG_FILE_RE.exec(name);
    if (!m) continue;
    const fileDate = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (fileDate.getTime() >= cutoff) continue;
    try {
      rmSync(join(logDir, name));
      deleted += 1;
    } catch (err) {
      logger.warn({ err, file: name }, 'log prune: failed to delete file');
    }
  }
  return deleted;
}

/**
 * Delete hook_events rows older than `retentionDays` (created_at is epoch ms).
 * Bounds the tool-usage analytics table, which otherwise grows without limit.
 */
export function pruneHookEvents(db: Database.Database, retentionDays: number): number {
  if (retentionDays < 1) return 0;
  const cutoff = Date.now() - retentionDays * 86_400_000;
  const result = db.prepare('DELETE FROM hook_events WHERE created_at < ?').run(cutoff);
  return result.changes;
}
