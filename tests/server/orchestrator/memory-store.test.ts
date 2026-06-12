import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../../server/orchestrator/memory-store';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-mem-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('MemoryStore', () => {
  it('returns a seeded default when the file does not exist (read does not create)', () => {
    const store = new MemoryStore(dir);
    expect(store.read()).toContain('# Orchestrator Memory');
    expect(existsSync(join(dir, 'orchestrator', 'memory.md'))).toBe(false);
  });

  it('write then read round-trips and creates the directory', () => {
    const store = new MemoryStore(dir);
    store.write('# Orchestrator Memory\n\nWatching goal X.');
    expect(store.read()).toContain('Watching goal X.');
    expect(existsSync(join(dir, 'orchestrator', 'memory.md'))).toBe(true);
  });

  it('write is atomic (no partial file left on the final path name)', () => {
    const store = new MemoryStore(dir);
    store.write('first');
    store.write('second');
    expect(readFileSync(join(dir, 'orchestrator', 'memory.md'), 'utf8')).toBe('second');
  });
});
