import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';
import { createSystemRouter } from '../../../server/routes/system';
import { createConfigService } from '../../../server/services/config-service';

let server: http.Server | null = null;
afterEach(() => { if (server) { server.close(); server = null; } });

function start(): Promise<{ port: number; base: string }> {
  const db = new Database(':memory:');
  runMigrations(db);
  const configService = createConfigService(db);
  const router = createSystemRouter(undefined, { configService });
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const srv = http.createServer(app);
  return new Promise((resolve) =>
    srv.listen(0, '127.0.0.1', () => {
      server = srv;
      const a = srv.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      resolve({ port, base: `http://127.0.0.1:${port}` });
    }),
  );
}

describe('GET/PUT /api/config (persisted)', () => {
  it('GET on an empty table returns documented defaults + a claude provider + catalog', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/config`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.homeRoute).toBe('/board');
    expect(body.tracePruneDays).toBe(90);
    expect(body.defaultModel).toBe('default');
    expect(body.defaultPermissionMode).toBe('supervised');
    expect(body.providers).toEqual([{ id: 'claude', enabled: true, billingMode: 'seat' }]);
    const catalog = body.catalog as Array<{ id: string; capabilities: { canApprove: boolean } }>;
    expect(catalog.find((c) => c.id === 'claude')?.capabilities.canApprove).toBe(true);
  });

  it('PUT then GET round-trips the updated values (proves persistence)', async () => {
    const { base } = await start();
    await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultModel: 'opus', tracePruneDays: 30 }),
    });
    const body = (await (await fetch(`${base}/api/config`)).json()) as Record<string, unknown>;
    expect(body.defaultModel).toBe('opus');
    expect(body.tracePruneDays).toBe(30); // field-name guard (not traceRetentionDays)
  });

  it('invalid PUT (tracePruneDays 0) returns 400 and writes nothing', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tracePruneDays: 0 }),
    });
    expect(res.status).toBe(400);
    const after = (await (await fetch(`${base}/api/config`)).json()) as Record<string, unknown>;
    expect(after.tracePruneDays).toBe(90); // unchanged
  });

  it('PUT clearing providers still returns an enabled claude record', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers: [] }),
    });
    const body = (await res.json()) as { providers: Array<{ id: string; enabled: boolean }> };
    expect(body.providers.find((p) => p.id === 'claude')?.enabled).toBe(true);
  });
});
