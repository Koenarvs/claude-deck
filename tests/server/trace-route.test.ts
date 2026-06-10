import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/db/migrate';
import { createTraceRouter } from '../../server/routes/trace';

let server: http.Server | null = null;
afterEach(() => { if (server) { server.close(); server = null; } });

function start(db: Database.Database): Promise<number> {
  const app = express();
  app.use('/api', createTraceRouter(db, '/tmp/data'));
  const srv = http.createServer(app);
  return new Promise((resolve) =>
    srv.listen(0, '127.0.0.1', () => {
      server = srv;
      const a = srv.address();
      resolve(typeof a === 'object' && a ? a.port : 0);
    }),
  );
}

describe('trace router (mounted)', () => {
  it('returns 404 for a session that has no trace_dir', async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    db.prepare(
      `INSERT INTO sessions (id, origin, started_at, stream_event_count, hook_event_count, stderr_bytes)
       VALUES ('s1','external',0,0,0,0)`,
    ).run();
    const port = await start(db);
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/s1/trace/stream`);
    expect(res.status).toBe(404);
    db.close();
  });
});
