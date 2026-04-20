import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/db/migrate';
import { pruneTraces } from '../../server/trace-pruner';

let tmpDir: string;
let db: Database.Database;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-pruner-test-'));
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Helper: creates a session row and trace directory.
 */
function createSession(
  id: string,
  endedAt: number | null,
  opts?: { goalId?: string },
): string {
  const traceDir = path.join(tmpDir, 'traces', id);
  fs.mkdirSync(traceDir, { recursive: true });
  fs.writeFileSync(path.join(traceDir, 'stream.jsonl'), '{"test":true}\n');
  fs.writeFileSync(path.join(traceDir, 'hooks.jsonl'), '{"hook":true}\n');
  fs.writeFileSync(path.join(traceDir, 'stderr.log'), 'test\n');

  db.prepare(`
    INSERT INTO sessions (id, goal_id, origin, trace_dir, started_at, ended_at)
    VALUES (?, ?, 'dashboard', ?, ?, ?)
  `).run(id, opts?.goalId ?? null, traceDir, Date.now() - 200 * 86_400_000, endedAt);

  return traceDir;
}

describe('pruneTraces', () => {
  it('removes trace directories older than pruneDays', () => {
    const now = Date.now();
    // Session ended 100 days ago — should be pruned with 90-day threshold
    const oldDir = createSession('old-session', now - 100 * 86_400_000);
    // Session ended 30 days ago — should NOT be pruned
    const newDir = createSession('new-session', now - 30 * 86_400_000);

    const pruned = pruneTraces(db, tmpDir, 90);

    expect(pruned).toBe(1);
    expect(fs.existsSync(oldDir)).toBe(false);
    expect(fs.existsSync(newDir)).toBe(true);
  });

  it('sets trace_dir to NULL for pruned sessions', () => {
    const now = Date.now();
    createSession('old-session', now - 100 * 86_400_000);

    pruneTraces(db, tmpDir, 90);

    const row = db.prepare('SELECT trace_dir FROM sessions WHERE id = ?').get('old-session') as {
      trace_dir: string | null;
    };
    expect(row.trace_dir).toBeNull();
  });

  it('does not prune sessions without ended_at', () => {
    const dir = createSession('active-session', null);

    const pruned = pruneTraces(db, tmpDir, 90);

    expect(pruned).toBe(0);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('does not prune sessions without trace_dir', () => {
    const now = Date.now();
    db.prepare(`
      INSERT INTO sessions (id, origin, trace_dir, started_at, ended_at)
      VALUES (?, 'dashboard', NULL, ?, ?)
    `).run('no-trace', now - 200 * 86_400_000, now - 100 * 86_400_000);

    const pruned = pruneTraces(db, tmpDir);

    expect(pruned).toBe(0);
  });

  it('returns 0 when no sessions are eligible', () => {
    const now = Date.now();
    createSession('recent', now - 10 * 86_400_000);

    const pruned = pruneTraces(db, tmpDir, 90);

    expect(pruned).toBe(0);
  });

  it('respects custom pruneDays parameter', () => {
    const now = Date.now();
    const dir50 = createSession('s50', now - 50 * 86_400_000);
    const dir20 = createSession('s20', now - 20 * 86_400_000);

    // Prune at 30 days — should remove the 50-day-old one
    const pruned = pruneTraces(db, tmpDir, 30);

    expect(pruned).toBe(1);
    expect(fs.existsSync(dir50)).toBe(false);
    expect(fs.existsSync(dir20)).toBe(true);
  });

  it('handles already-deleted directories gracefully', () => {
    const now = Date.now();
    const dir = createSession('ghost', now - 100 * 86_400_000);
    // Remove the directory before pruning
    fs.rmSync(dir, { recursive: true, force: true });

    const pruned = pruneTraces(db, tmpDir, 90);

    // Should still update the DB even though the directory was already gone
    expect(pruned).toBe(1);
    const row = db.prepare('SELECT trace_dir FROM sessions WHERE id = ?').get('ghost') as {
      trace_dir: string | null;
    };
    expect(row.trace_dir).toBeNull();
  });

  it('skips trace_dir paths outside traces/ root', () => {
    const now = Date.now();
    const outsideDir = path.join(tmpDir, 'outside', 'data');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'stream.jsonl'), '{"test":true}\n');

    db.prepare(`
      INSERT INTO sessions (id, origin, trace_dir, started_at, ended_at)
      VALUES (?, 'dashboard', ?, ?, ?)
    `).run('outside-session', outsideDir, now - 200 * 86_400_000, now - 100 * 86_400_000);

    const pruned = pruneTraces(db, tmpDir, 90);

    expect(pruned).toBe(0);
    expect(fs.existsSync(outsideDir)).toBe(true);
  });
});
