import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';
import { createTraceRouter } from '../../../server/routes/trace';

let tmpDir: string;
let db: Database.Database;
let server: http.Server;
let port: number;

/** Concatenates streamed response chunks into a Buffer. */
async function fetchBuffer(url: string): Promise<{ status: number; body: Buffer }> {
  const res = await fetch(url);
  const arrayBuf = await res.arrayBuffer();
  return { status: res.status, body: Buffer.from(arrayBuf) };
}

/** Fetches JSON response. */
async function fetchJson(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url);
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-routes-test-'));
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  // Create test goal
  db.prepare(`
    INSERT INTO goals (id, title, cwd, status, priority, tags, permission_mode, kanban_order, created_at, updated_at)
    VALUES ('goal-1', 'Test Goal', '/tmp', 'active', 0, '[]', 'supervised', 1.0, ?, ?)
  `).run(Date.now(), Date.now());

  // Create test sessions with trace directories
  const sessions = ['session-1', 'session-2'];
  for (const sid of sessions) {
    const traceDir = path.join(tmpDir, 'traces', sid);
    fs.mkdirSync(traceDir, { recursive: true });
    fs.writeFileSync(path.join(traceDir, 'stream.jsonl'), '{"type":"init","session_id":"' + sid + '"}\n{"type":"assistant"}\n');
    fs.writeFileSync(path.join(traceDir, 'hooks.jsonl'), '{"event_type":"SessionStart"}\n');
    fs.writeFileSync(path.join(traceDir, 'stderr.log'), 'stderr output for ' + sid + '\n');
    fs.writeFileSync(path.join(traceDir, 'meta.json'), JSON.stringify({ session_id: sid, stream_event_count: 2 }));

    db.prepare(`
      INSERT INTO sessions (id, goal_id, origin, trace_dir, started_at, ended_at)
      VALUES (?, 'goal-1', 'dashboard', ?, ?, ?)
    `).run(sid, traceDir, Date.now(), Date.now());
  }

  // Create a session with no trace dir
  db.prepare(`
    INSERT INTO sessions (id, goal_id, origin, trace_dir, started_at)
    VALUES ('session-no-trace', 'goal-1', 'external', NULL, ?)
  `).run(Date.now());

  const app = express();
  app.use('/api', createTraceRouter(db, tmpDir));
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  server = http.createServer(app);
  port = await new Promise<number>((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        resolve(addr.port);
      }
    });
  });
});

afterAll(() => {
  server.close();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function url(path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}

describe('Trace routes', () => {
  describe('GET /api/sessions/:id/trace/stream', () => {
    it('returns stream.jsonl content', async () => {
      const { status, body } = await fetchBuffer(url('/api/sessions/session-1/trace/stream'));
      expect(status).toBe(200);
      const content = body.toString('utf-8');
      const lines = content.split('\n').filter((l) => l.length > 0);
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!)).toHaveProperty('type', 'init');
    });

    it('returns 404 for unknown session', async () => {
      const { status } = await fetchJson(url('/api/sessions/nonexistent/trace/stream'));
      expect(status).toBe(404);
    });

    it('returns 404 for session without trace_dir', async () => {
      const { status } = await fetchJson(url('/api/sessions/session-no-trace/trace/stream'));
      expect(status).toBe(404);
    });
  });

  describe('GET /api/sessions/:id/trace/hooks', () => {
    it('returns hooks.jsonl content', async () => {
      const { status, body } = await fetchBuffer(url('/api/sessions/session-1/trace/hooks'));
      expect(status).toBe(200);
      const content = body.toString('utf-8');
      expect(content).toContain('SessionStart');
    });
  });

  describe('GET /api/sessions/:id/trace/stderr', () => {
    it('returns stderr.log content', async () => {
      const { status, body } = await fetchBuffer(url('/api/sessions/session-1/trace/stderr'));
      expect(status).toBe(200);
      expect(body.toString('utf-8')).toContain('stderr output');
    });
  });

  describe('GET /api/sessions/:id/trace/meta', () => {
    it('returns meta.json content', async () => {
      const { status, body } = await fetchBuffer(url('/api/sessions/session-1/trace/meta'));
      expect(status).toBe(200);
      const meta = JSON.parse(body.toString('utf-8'));
      expect(meta).toHaveProperty('session_id', 'session-1');
      expect(meta).toHaveProperty('stream_event_count', 2);
    });
  });

  describe('GET /api/sessions/:id/trace/bundle', () => {
    it('returns a gzip stream (QA-3 partial)', async () => {
      const res = await fetch(url('/api/sessions/session-1/trace/bundle'));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/gzip');

      const arrayBuf = await res.arrayBuffer();
      const buf = Buffer.from(arrayBuf);
      // gzip magic number: 0x1f 0x8b
      expect(buf[0]).toBe(0x1f);
      expect(buf[1]).toBe(0x8b);
      // Should be non-trivial in size
      expect(buf.byteLength).toBeGreaterThan(50);
    });

    it('returns 404 for session without trace_dir', async () => {
      const { status } = await fetchJson(url('/api/sessions/session-no-trace/trace/bundle'));
      expect(status).toBe(404);
    });
  });

  describe('GET /api/goals/:id/trace', () => {
    it('returns a tar stream with all sessions for the goal (QA-4 partial)', async () => {
      const res = await fetch(url('/api/goals/goal-1/trace'));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/x-tar');

      const arrayBuf = await res.arrayBuffer();
      const buf = Buffer.from(arrayBuf);
      // Should contain session IDs in the tar headers
      const content = buf.toString('utf-8');
      expect(content).toContain('session-1/');
      expect(content).toContain('session-2/');
    });

    it('returns 404 for unknown goal', async () => {
      const { status } = await fetchJson(url('/api/goals/nonexistent/trace'));
      expect(status).toBe(404);
    });
  });
});
