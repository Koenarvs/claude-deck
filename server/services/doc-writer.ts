import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import logger from '../logger';
import type { DocWriteResult } from '../../src/shared/types';

export interface ReadWithBaseResult {
  exists: boolean;
  content: string;
  /** sha256 of the on-disk content at read time; '' when the file does not exist. */
  baseHash: string;
  mtimeMs: number;
}

export interface WriteInput {
  path: string;
  content: string;
  /** Hash from the readWithBase() call the caller based its edit on. '' = expect no file. */
  baseHash: string;
  /** Attribution stamp identity, e.g. 'goal-42/codex'. */
  author: string;
}

const TRAILER_RE = /—\s*written by\s+\S+\s+@\s+\d{4}-\d{2}-\d{2}T/;

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Stateless writer for shared goal markdown (handoff.md, plan.md, …) with attribution. */
export function createDocWriter() {
  function readWithBase(path: string): ReadWithBaseResult {
    if (!existsSync(path)) {
      return { exists: false, content: '', baseHash: '', mtimeMs: 0 };
    }
    const content = readFileSync(path, 'utf-8');
    return { exists: true, content, baseHash: hashContent(content), mtimeMs: statSync(path).mtimeMs };
  }

  /**
   * Writes content with last-write-wins conflict detection. If the file's current
   * on-disk hash differs from baseHash (someone else wrote since the read), returns
   * { conflict: true, written: false } and does NOT touch the file. Otherwise appends
   * an attribution trailer (unless one is already present) and writes atomically.
   */
  function writeWithAttribution(input: WriteInput): DocWriteResult {
    const current = existsSync(input.path) ? readFileSync(input.path, 'utf-8') : null;
    const currentHash = current != null ? hashContent(current) : '';

    if (currentHash !== input.baseHash) {
      logger.warn({ path: input.path, author: input.author }, 'DocWriter conflict — base hash stale');
      return { conflict: true, written: false, path: input.path, baseHash: currentHash };
    }

    const trailer = `\n\n— written by ${input.author} @ ${new Date().toISOString()}\n`;
    const lastLine = input.content.trimEnd().split('\n').slice(-1)[0] ?? '';
    const stamped = TRAILER_RE.test(lastLine) ? input.content : input.content.replace(/\s*$/, '') + trailer;

    const tmp = `${input.path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, stamped, 'utf-8');
    renameSync(tmp, input.path);

    return { conflict: false, written: true, path: input.path, baseHash: hashContent(stamped) };
  }

  return { readWithBase, writeWithAttribution };
}

export type DocWriter = ReturnType<typeof createDocWriter>;
