import fs from 'node:fs';
import path from 'node:path';
import logger from './logger';

/**
 * Per-session trace writer that appends raw stream-json events, hook payloads,
 * and stderr output to JSONL/log files on disk. Maintains counters for each
 * stream type. All writes are append-mode; close() fsyncs before closing.
 *
 * Files produced per session:
 * - stream.jsonl  — raw CLI stdout events (one JSON object per line)
 * - hooks.jsonl   — raw hook payloads (one JSON object per line)
 * - stderr.log    — CLI stderr output (raw text)
 * - meta.json     — session metadata written on close
 */
export class TraceWriter {
  readonly sessionId: string;
  readonly traceDir: string;

  private streamFd: number | null = null;
  private hooksFd: number | null = null;
  private stderrFd: number | null = null;

  private _streamEventCount = 0;
  private _hookEventCount = 0;
  private _stderrBytes = 0;
  private _closed = false;

  constructor(sessionId: string, traceDir: string) {
    this.sessionId = sessionId;
    this.traceDir = traceDir;

    fs.mkdirSync(traceDir, { recursive: true });

    this.streamFd = fs.openSync(path.join(traceDir, 'stream.jsonl'), 'a');
    this.hooksFd = fs.openSync(path.join(traceDir, 'hooks.jsonl'), 'a');
    this.stderrFd = fs.openSync(path.join(traceDir, 'stderr.log'), 'a');
  }

  /** Number of lines written to stream.jsonl. */
  get streamEventCount(): number {
    return this._streamEventCount;
  }

  /** Number of lines written to hooks.jsonl. */
  get hookEventCount(): number {
    return this._hookEventCount;
  }

  /** Total bytes written to stderr.log. */
  get stderrBytes(): number {
    return this._stderrBytes;
  }

  /** Whether close() has been called. */
  get closed(): boolean {
    return this._closed;
  }

  /**
   * Appends a raw stream-json line to stream.jsonl.
   * Ensures the line ends with a newline character.
   * Increments stream_event_count.
   *
   * @param rawLine - A single line of stream-json output from the CLI.
   */
  appendStream(rawLine: string): void {
    this.assertOpen();
    const line = rawLine.endsWith('\n') ? rawLine : rawLine + '\n';
    const buf = Buffer.from(line, 'utf-8');
    fs.writeSync(this.streamFd!, buf);
    this._streamEventCount++;
  }

  /**
   * Appends a hook payload object to hooks.jsonl.
   * Serializes to JSON and appends a newline.
   * Increments hook_event_count.
   *
   * @param payload - The hook payload object to serialize and append.
   */
  appendHook(payload: Record<string, unknown>): void {
    this.assertOpen();
    const line = JSON.stringify(payload) + '\n';
    const buf = Buffer.from(line, 'utf-8');
    fs.writeSync(this.hooksFd!, buf);
    this._hookEventCount++;
  }

  /**
   * Appends raw stderr output to stderr.log.
   * Increments stderr_bytes by the byte length of the chunk.
   *
   * @param chunk - Raw stderr text from the CLI subprocess.
   */
  appendStderr(chunk: string): void {
    this.assertOpen();
    const buf = Buffer.from(chunk, 'utf-8');
    fs.writeSync(this.stderrFd!, buf);
    this._stderrBytes += buf.byteLength;
  }

  /**
   * Writes session metadata to meta.json in the trace directory.
   * Called on session end to record final counters and timing.
   *
   * @param meta - Metadata object to persist (typically includes session_id,
   *               counters, cost, timestamps).
   */
  async writeMeta(meta: Record<string, unknown>): Promise<void> {
    const metaPath = path.join(this.traceDir, 'meta.json');
    const content = JSON.stringify(meta, null, 2) + '\n';
    fs.writeFileSync(metaPath, content, 'utf-8');
  }

  /**
   * Fsyncs all open file descriptors and closes them.
   * Idempotent: subsequent calls are no-ops.
   */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;

    const fds = [this.streamFd, this.hooksFd, this.stderrFd];
    for (const fd of fds) {
      if (fd !== null) {
        try {
          fs.fsyncSync(fd);
          fs.closeSync(fd);
        } catch (err) {
          logger.error({ err, sessionId: this.sessionId }, 'Error closing trace file descriptor');
        }
      }
    }

    this.streamFd = null;
    this.hooksFd = null;
    this.stderrFd = null;
  }

  /**
   * Throws if the writer has already been closed.
   */
  private assertOpen(): void {
    if (this._closed) {
      throw new Error(`TraceWriter for session ${this.sessionId} is closed`);
    }
  }
}
