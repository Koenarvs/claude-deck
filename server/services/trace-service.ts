import path from 'node:path';
import fs from 'node:fs';
import { TraceWriter } from '../trace-writer';
import logger from '../logger';

/** Maximum number of concurrently open TraceWriters before eviction kicks in. */
const MAX_OPEN_WRITERS = 100;

/**
 * Manages TraceWriter lifecycle: creation, retrieval, eviction, and shutdown.
 *
 * Holds a registry of open TraceWriters keyed by session ID.
 * Provides get-or-create semantics so callers don't need to manage lifecycles.
 * On EMFILE pressure, evicts the least recently used writer.
 */
export class TraceService {
  private readonly writers = new Map<string, TraceWriter>();
  private readonly accessOrder: string[] = [];
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  /**
   * Returns an existing TraceWriter for the given session, or creates a new one.
   * The trace directory is `<dataDir>/traces/<sessionId>/`.
   * If the open writer count exceeds MAX_OPEN_WRITERS, the least recently
   * accessed writer is evicted (closed) first.
   *
   * @param sessionId - The session ID to get or create a writer for.
   * @returns The TraceWriter for the session.
   */
  getOrCreate(sessionId: string): TraceWriter {
    const existing = this.writers.get(sessionId);
    if (existing && !existing.closed) {
      this.touchAccessOrder(sessionId);
      return existing;
    }

    // Evict oldest if at capacity
    if (this.writers.size >= MAX_OPEN_WRITERS) {
      this.evictOldest();
    }

    const traceDir = path.join(this.dataDir, 'traces', sessionId);
    const writer = new TraceWriter(sessionId, traceDir);
    this.writers.set(sessionId, writer);
    this.touchAccessOrder(sessionId);

    logger.debug({ sessionId, traceDir }, 'Created TraceWriter');
    return writer;
  }

  /**
   * Returns the TraceWriter for a session if it exists and is still open.
   * Does not create a new one.
   *
   * @param sessionId - The session ID to look up.
   * @returns The TraceWriter, or undefined if not found or closed.
   */
  get(sessionId: string): TraceWriter | undefined {
    const writer = this.writers.get(sessionId);
    if (writer && !writer.closed) {
      return writer;
    }
    return undefined;
  }

  /**
   * Closes the TraceWriter for a specific session and removes it from the registry.
   *
   * @param sessionId - The session to close.
   */
  async closeSession(sessionId: string): Promise<void> {
    const writer = this.writers.get(sessionId);
    if (writer) {
      await writer.close();
      this.writers.delete(sessionId);
      this.removeFromAccessOrder(sessionId);
      logger.debug({ sessionId }, 'Closed TraceWriter');
    }
  }

  /**
   * Closes all open TraceWriters. Called during server shutdown.
   * Waits for all fsync operations to complete.
   */
  async closeAll(): Promise<void> {
    const entries = Array.from(this.writers.entries());
    logger.info({ count: entries.length }, 'Closing all TraceWriters');

    await Promise.all(
      entries.map(async ([sessionId, writer]) => {
        try {
          await writer.close();
        } catch (err) {
          logger.error({ err, sessionId }, 'Error closing TraceWriter during shutdown');
        }
      }),
    );

    this.writers.clear();
    this.accessOrder.length = 0;
  }

  /**
   * Returns the trace directory path for a session.
   * Does not verify the directory exists.
   *
   * @param sessionId - The session ID.
   * @returns Absolute path to the session's trace directory.
   */
  getTraceDir(sessionId: string): string {
    return path.join(this.dataDir, 'traces', sessionId);
  }

  /**
   * Returns true if a trace directory exists on disk for the given session.
   *
   * @param sessionId - The session ID to check.
   */
  traceDirExists(sessionId: string): boolean {
    return fs.existsSync(this.getTraceDir(sessionId));
  }

  /**
   * Returns the number of currently open (not closed) writers.
   */
  get openCount(): number {
    return this.writers.size;
  }

  /**
   * Moves a session ID to the end of the access-order list (most recently used).
   */
  private touchAccessOrder(sessionId: string): void {
    this.removeFromAccessOrder(sessionId);
    this.accessOrder.push(sessionId);
  }

  /**
   * Removes a session ID from the access-order list.
   */
  private removeFromAccessOrder(sessionId: string): void {
    const idx = this.accessOrder.indexOf(sessionId);
    if (idx !== -1) {
      this.accessOrder.splice(idx, 1);
    }
  }

  /**
   * Evicts (closes) the least recently accessed TraceWriter to free file descriptors.
   */
  private evictOldest(): void {
    if (this.accessOrder.length === 0) return;

    const oldestId = this.accessOrder[0];
    if (!oldestId) return;

    const writer = this.writers.get(oldestId);
    if (writer) {
      logger.info({ sessionId: oldestId }, 'Evicting oldest TraceWriter (EMFILE protection)');
      // Fire-and-forget close; we're in a sync path
      writer.close().catch((err) => {
        logger.error({ err, sessionId: oldestId }, 'Error during TraceWriter eviction');
      });
      this.writers.delete(oldestId);
    }
    this.removeFromAccessOrder(oldestId);
  }
}
