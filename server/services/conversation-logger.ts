import { existsSync, statSync, openSync, readSync, closeSync, writeFileSync, appendFileSync, watchFile, unwatchFile } from 'node:fs';
import { join } from 'node:path';
import type { ServerEvent } from '../../src/shared/events';
import { findJsonlFile } from './transcript-service';
import logger from '../logger';

const OUTPUT_FILENAME = 'conversation.md';
const WATCH_INTERVAL_MS = 1000;
const DEBOUNCE_MS = 300;
const RETRY_INTERVAL_MS = 3000;
const MAX_RETRIES = 14;

type BroadcastFn = (event: ServerEvent) => void;

export class ConversationLogger {
  private readonly goalId: string;
  private readonly goalCwd: string;
  private readonly broadcast: BroadcastFn;
  private jsonlPath: string | null = null;
  private lastByteOffset = 0;
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private watching = false;

  constructor(goalId: string, goalCwd: string, broadcast: BroadcastFn) {
    this.goalId = goalId;
    this.goalCwd = goalCwd;
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
    this.rebuildFromFull();
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
      this.rebuildFromFull();
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
      this.debounceTimer = setTimeout(() => this.processNewEntries(), DEBOUNCE_MS);
    });
  }

  private rebuildFromFull(): void {
    if (!this.jsonlPath || !existsSync(this.jsonlPath)) return;

    try {
      const stat = statSync(this.jsonlPath);
      const buffer = Buffer.alloc(stat.size);
      const fd = openSync(this.jsonlPath, 'r');
      readSync(fd, buffer, 0, stat.size, 0);
      closeSync(fd);

      this.lastByteOffset = stat.size;

      const text = buffer.toString('utf-8');
      const lines = text.split('\n').filter(l => l.trim());
      const chunks: string[] = [];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const md = this.formatEntry(entry);
          if (md) chunks.push(md);
        } catch { /* skip malformed */ }
      }

      const outputPath = join(this.goalCwd, OUTPUT_FILENAME);
      writeFileSync(outputPath, chunks.join(''), 'utf-8');
      logger.info({ goalId: this.goalId, entries: chunks.length }, 'ConversationLogger: rebuilt conversation.md');

      this.broadcast({ type: 'conversation:updated', goal_id: this.goalId } as ServerEvent);
    } catch (err) {
      logger.warn({ err, goalId: this.goalId }, 'ConversationLogger: rebuild failed');
    }
  }

  private processNewEntries(): void {
    if (!this.jsonlPath || this.stopped) return;

    try {
      if (!existsSync(this.jsonlPath)) return;
      const stat = statSync(this.jsonlPath);
      if (stat.size <= this.lastByteOffset) return;

      const bytesToRead = stat.size - this.lastByteOffset;
      const buffer = Buffer.alloc(bytesToRead);
      const fd = openSync(this.jsonlPath, 'r');
      readSync(fd, buffer, 0, bytesToRead, this.lastByteOffset);
      closeSync(fd);

      this.lastByteOffset = stat.size;

      const newText = buffer.toString('utf-8');
      const lines = newText.split('\n').filter(l => l.trim());
      const chunks: string[] = [];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const md = this.formatEntry(entry);
          if (md) chunks.push(md);
        } catch { /* skip malformed */ }
      }

      if (chunks.length > 0) {
        const outputPath = join(this.goalCwd, OUTPUT_FILENAME);
        appendFileSync(outputPath, chunks.join(''), 'utf-8');

        this.broadcast({ type: 'conversation:updated', goal_id: this.goalId } as ServerEvent);
      }
    } catch (err) {
      logger.warn({ err, goalId: this.goalId }, 'ConversationLogger: processNewEntries failed');
    }
  }

  private formatEntry(entry: Record<string, unknown>): string | null {
    const type = entry.type as string;
    if (type !== 'user' && type !== 'assistant') return null;

    const timestamp = entry.timestamp as string | undefined;
    const timeStr = timestamp ? this.formatTime(timestamp) : '';
    const msg = entry.message as Record<string, unknown> | undefined;
    if (!msg) return null;

    const content = msg.content;

    if (type === 'user') {
      if (typeof content === 'string' && content.trim()) {
        return `### You — ${timeStr}\n\n${content.trim()}\n\n---\n\n`;
      }
      if (Array.isArray(content)) {
        return this.formatToolResults(content);
      }
      return null;
    }

    if (type === 'assistant' && Array.isArray(content)) {
      return this.formatAssistantBlocks(content, timeStr);
    }

    return null;
  }

  private formatAssistantBlocks(blocks: unknown[], timeStr: string): string | null {
    const parts: string[] = [];
    let hasTextHeader = false;

    for (const block of blocks) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;
      const blockType = b.type as string;

      if (blockType === 'text' && typeof b.text === 'string' && b.text.trim()) {
        if (!hasTextHeader) {
          parts.push(`### Claude — ${timeStr}\n\n`);
          hasTextHeader = true;
        }
        parts.push(`${b.text.trim()}\n\n`);
      } else if (blockType === 'tool_use') {
        const toolName = b.name as string;
        const toolInput = (b.input as Record<string, unknown>) ?? {};
        const summary = this.summarizeToolInput(toolName, toolInput);
        const label = summary ? `\`${toolName}\` — ${summary}` : `\`${toolName}\``;
        parts.push(`> **Tool:** ${label}\n\n`);
      }
      // Skip 'thinking' blocks
    }

    if (parts.length === 0) return null;
    parts.push('---\n\n');
    return parts.join('');
  }

  private formatToolResults(blocks: unknown[]): string | null {
    const parts: string[] = [];

    for (const block of blocks) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b.type !== 'tool_result') continue;

      const isError = b.is_error === true;
      const content = b.content;
      let summary: string;

      if (isError) {
        const text = typeof content === 'string' ? content : '';
        summary = 'Error: ' + (text.length > 100 ? text.slice(0, 97) + '...' : text);
      } else if (typeof content === 'string') {
        summary = content.length > 80 ? `${content.length} chars` : content;
      } else {
        summary = 'ok';
      }

      parts.push(`> **Result:** ${summary}\n\n`);
    }

    if (parts.length === 0) return null;
    parts.push('---\n\n');
    return parts.join('');
  }

  private summarizeToolInput(name: string, input: Record<string, unknown>): string {
    const lastSegments = (p: string) => p.replace(/\\/g, '/').split('/').slice(-2).join('/');

    switch (name) {
      case 'Read':
        return lastSegments(String(input.file_path ?? ''));
      case 'Write':
      case 'Edit':
        return lastSegments(String(input.file_path ?? ''));
      case 'Bash': {
        const cmd = String(input.command ?? '');
        return cmd.length > 120 ? cmd.slice(0, 117) + '...' : cmd;
      }
      case 'Grep': {
        const pattern = String(input.pattern ?? '');
        const grepPath = lastSegments(String(input.path ?? '.'));
        return `\`${pattern}\` in ${grepPath}`;
      }
      case 'Glob':
        return String(input.pattern ?? '');
      case 'Agent':
        return String(input.description ?? '');
      default:
        return '';
    }
  }

  private formatTime(isoTimestamp: string): string {
    try {
      const date = new Date(isoTimestamp);
      return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    } catch {
      return '';
    }
  }
}
