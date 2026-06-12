import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SEED = `# Orchestrator Memory

_This file is the orchestrator's durable memory. It is loaded on every wake and
rewritten as the orchestrator acts. It is human-readable and may be edited by hand._

## Standing instructions

(none yet)

## What I've done

(nothing yet)

## Open threads awaiting a decision

(none yet)
`;

/**
 * Durable markdown memory for the orchestrator, stored at `<dataDir>/orchestrator/memory.md`.
 * Reads return a seeded default if the file is absent (without creating it). Writes are
 * atomic (write to a temp file, then rename).
 */
export class MemoryStore {
  private readonly dir: string;
  private readonly path: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'orchestrator');
    this.path = join(this.dir, 'memory.md');
  }

  /** The seeded default content used when the file is absent. */
  get seed(): string {
    return SEED;
  }

  /** Reads memory.md, or returns the seed if it does not exist. */
  read(): string {
    if (!existsSync(this.path)) return SEED;
    return readFileSync(this.path, 'utf8');
  }

  /** Atomically writes memory.md, creating the directory if needed. */
  write(content: string): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, this.path);
  }
}
