import { existsSync, watchFile, unwatchFile } from 'node:fs';
import type { ServerEvent } from '../../src/shared/events';
import { findJsonlFile } from './transcript-service';
import logger from '../logger';

const WATCH_INTERVAL_MS = 1000;
const DEBOUNCE_MS = 300;
const RETRY_INTERVAL_MS = 3000;
const MAX_RETRIES = 14;

type BroadcastFn = (event: ServerEvent) => void;

/**
 * Watches Claude Code's JSONL log file for changes and broadcasts
 * `conversation:updated` WebSocket events. Does NOT read or write
 * any files — conversation content is served on-demand from the
 * JSONL via the transcript service.
 */
export class ConversationLogger {
  private readonly goalId: string;
  private readonly broadcast: BroadcastFn;
  private jsonlPath: string | null = null;
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private watching = false;

  constructor(goalId: string, broadcast: BroadcastFn) {
    this.goalId = goalId;
    this.broadcast = broadcast;
  }

  start(): void {
    this.stopped = false;
    this.tryLocateAndWatch(0);
  }

  rebuild(): void {
    this.stopped = false;
    const found = findJsonlFile(this.goalId);
    if (!found) {
      logger.debug({ goalId: this.goalId }, 'ConversationLogger: no JSONL found for rebuild, starting poll');
      this.tryLocateAndWatch(0);
      return;
    }
    this.jsonlPath = found;
    this.notifyUpdate();
    this.startWatching();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    if (this.watching && this.jsonlPath) {
      try { unwatchFile(this.jsonlPath); } catch { /* ignore */ }
      this.watching = false;
    }
  }

  private tryLocateAndWatch(attempt: number): void {
    if (this.stopped || attempt >= MAX_RETRIES) return;

    const found = findJsonlFile(this.goalId);
    if (found) {
      this.jsonlPath = found;
      logger.info({ goalId: this.goalId, path: found }, 'ConversationLogger: found JSONL');
      this.notifyUpdate();
      this.startWatching();
      return;
    }

    this.retryTimer = setTimeout(() => this.tryLocateAndWatch(attempt + 1), RETRY_INTERVAL_MS);
  }

  private startWatching(): void {
    if (this.stopped || !this.jsonlPath || this.watching) return;
    this.watching = true;

    watchFile(this.jsonlPath, { interval: WATCH_INTERVAL_MS }, (curr, prev) => {
      if (this.stopped) return;
      if (curr.mtimeMs <= prev.mtimeMs) return;

      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => this.notifyUpdate(), DEBOUNCE_MS);
    });
  }

  private notifyUpdate(): void {
    if (this.stopped) return;
    if (!this.jsonlPath || !existsSync(this.jsonlPath)) return;
    this.broadcast({ type: 'conversation:updated', goal_id: this.goalId } as ServerEvent);
  }
}
