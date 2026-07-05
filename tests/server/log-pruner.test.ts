import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { pruneLogFiles, pruneHookEvents } from '../../server/log-pruner';
import { createRotatingFileStream } from '../../server/logger';

const dayFile = (daysAgo: number): string => {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `deck-${date}.log`;
};

describe('pruneLogFiles', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'log-prune-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('deletes files older than retention, keeps newer ones', () => {
    writeFileSync(join(dir, dayFile(0)), 'today', 'utf8');
    writeFileSync(join(dir, dayFile(5)), 'recent', 'utf8');
    writeFileSync(join(dir, dayFile(40)), 'old', 'utf8');
    writeFileSync(join(dir, dayFile(400)), 'ancient', 'utf8');

    const deleted = pruneLogFiles(dir, 30);

    expect(deleted).toBe(2);
    const remaining = readdirSync(dir).sort();
    expect(remaining).toEqual([dayFile(5), dayFile(0)].sort());
  });

  it('ignores files that do not match the deck-YYYY-MM-DD.log pattern', () => {
    writeFileSync(join(dir, 'other.log'), 'keep', 'utf8');
    writeFileSync(join(dir, 'deck-notadate.log'), 'keep', 'utf8');
    expect(pruneLogFiles(dir, 1)).toBe(0);
    expect(readdirSync(dir)).toHaveLength(2);
  });

  it('no-ops on a missing directory or non-positive retention', () => {
    expect(pruneLogFiles(join(dir, 'nope'), 30)).toBe(0);
    writeFileSync(join(dir, dayFile(40)), 'old', 'utf8');
    expect(pruneLogFiles(dir, 0)).toBe(0);
  });
});

describe('pruneHookEvents', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(
      'CREATE TABLE hook_events (id TEXT PRIMARY KEY, session_id TEXT, event_type TEXT, tool_name TEXT, payload TEXT, created_at INTEGER)',
    );
  });
  afterEach(() => db.close());

  const insert = (id: string, ageDays: number) =>
    db
      .prepare('INSERT INTO hook_events (id, created_at) VALUES (?, ?)')
      .run(id, Date.now() - ageDays * 86_400_000);

  it('deletes rows older than retention', () => {
    insert('new', 1);
    insert('borderline', 89);
    insert('old', 91);
    insert('ancient', 365);

    expect(pruneHookEvents(db, 90)).toBe(2);
    const ids = db.prepare('SELECT id FROM hook_events ORDER BY id').all() as { id: string }[];
    expect(ids.map((r) => r.id)).toEqual(['borderline', 'new']);
  });

  it('no-ops on non-positive retention', () => {
    insert('old', 500);
    expect(pruneHookEvents(db, 0)).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS c FROM hook_events').get()).toEqual({ c: 1 });
  });
});

describe('createRotatingFileStream', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'log-rotate-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates today's dated file on first write and appends", async () => {
    const stream = createRotatingFileStream(join(dir, 'logs'));
    stream.write('{"msg":"one"}\n');
    stream.write('{"msg":"two"}\n');
    // WriteStream flushes async; poll briefly.
    const file = join(dir, 'logs', dayFile(0));
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(file)).toBe(true);
  });

  it('creates the directory if missing', () => {
    const nested = join(dir, 'a', 'b', 'logs');
    createRotatingFileStream(nested);
    expect(existsSync(nested)).toBe(true);
  });
});
