import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import http from 'node:http';
import Database from 'better-sqlite3';
import { createApp } from '../../server/app';
import { createSystemRouter } from '../../server/routes/system';
import { runMigrations } from '../../server/db/migrate';

let server: http.Server;
let port: number;
let db: Database.Database;

// ── Phase 1 Eval: Analytics API Regression ───────────────────────────────────

describe('Analytics API — Phase 1 Regression', () => {
  beforeAll(async () => {
    db = new Database(':memory:');
    runMigrations(db);

    db.exec(`
      CREATE TABLE IF NOT EXISTS session_usage (
        session_id TEXT PRIMARY KEY,
        project_dir TEXT,
        model TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd REAL NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL DEFAULT 0,
        session_date TEXT NOT NULL,
        first_message_at INTEGER NOT NULL,
        last_message_at INTEGER,
        ingested_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session_usage_date ON session_usage (session_date);
      CREATE INDEX IF NOT EXISTS idx_session_usage_first_msg ON session_usage (first_message_at);
    `);

    const systemRouter = createSystemRouter();
    const app = createApp({ apiRouters: [systemRouter] });
    (app as unknown as { locals: { db: Database.Database } }).locals.db = db;

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
  });

  it('GET /api/analytics/totals returns expected shape', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/analytics/totals?days=30`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.sessions).toBe('number');
    expect(typeof body.cost).toBe('number');
    expect(typeof body.tokensIn).toBe('number');
    expect(typeof body.tokensOut).toBe('number');
  });

  it('GET /api/analytics/totals accepts days=0 for all time', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/analytics/totals?days=0`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.sessions).toBe('number');
  });

  it('GET /api/analytics/tool-usage returns array of {name, count}', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/analytics/tool-usage?days=30`);
    expect(res.status).toBe(200);
    const body = await res.json() as unknown;
    expect(Array.isArray(body)).toBe(true);
    for (const item of body as Array<Record<string, unknown>>) {
      expect(typeof item.name).toBe('string');
      expect(typeof item.count).toBe('number');
    }
  });

  it('GET /api/analytics/daily-costs returns array of {date, cost, sessions}', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/analytics/daily-costs?days=30`);
    expect(res.status).toBe(200);
    const body = await res.json() as unknown;
    expect(Array.isArray(body)).toBe(true);
    for (const item of body as Array<Record<string, unknown>>) {
      expect(typeof item.date).toBe('string');
      expect(typeof item.cost).toBe('number');
      expect(typeof item.sessions).toBe('number');
    }
  });

  it('GET /api/analytics/activity-heatmap returns array of {date, count}', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/analytics/activity-heatmap?days=90`);
    expect(res.status).toBe(200);
    const body = await res.json() as unknown;
    expect(Array.isArray(body)).toBe(true);
    for (const item of body as Array<Record<string, unknown>>) {
      expect(typeof item.date).toBe('string');
      expect(typeof item.count).toBe('number');
    }
  });

  it('GET /api/analytics/sessions-per-day returns array with expected fields', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/analytics/sessions-per-day?days=30`);
    expect(res.status).toBe(200);
    const body = await res.json() as unknown;
    expect(Array.isArray(body)).toBe(true);
    for (const item of body as Array<Record<string, unknown>>) {
      expect(typeof item.date).toBe('string');
      expect(typeof item.sessions).toBe('number');
      expect(typeof item.dashboard).toBe('number');
      expect(typeof item.external).toBe('number');
    }
  });

  it('GET /api/analytics/session-durations returns array of {bucket, count}', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/analytics/session-durations?days=30`);
    expect(res.status).toBe(200);
    const body = await res.json() as unknown;
    expect(Array.isArray(body)).toBe(true);
    for (const item of body as Array<Record<string, unknown>>) {
      expect(typeof item.bucket).toBe('string');
      expect(typeof item.count).toBe('number');
    }
  });

  it('all 6 endpoints accept the days query parameter with all valid values', { timeout: 15000 }, async () => {
    const endpoints = [
      '/api/analytics/totals',
      '/api/analytics/tool-usage',
      '/api/analytics/daily-costs',
      '/api/analytics/activity-heatmap',
      '/api/analytics/sessions-per-day',
      '/api/analytics/session-durations',
    ];
    for (const endpoint of endpoints) {
      for (const days of [7, 30, 90, 0]) {
        const res = await fetch(`http://127.0.0.1:${port}${endpoint}?days=${days}`);
        expect(res.status).toBe(200);
      }
    }
  });
});

// ── Ingestion Wiring Eval ────────────────────────────────────────────────────
// P0: Verifies that server/index.ts imports and calls ingestAllSessions on startup.

describe('Ingestion Wiring', () => {
  it('server/index.ts imports ingestion-service', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const indexContent = readFileSync(resolve('server/index.ts'), 'utf-8');
    expect(indexContent).toContain('ingestion-service');
  });

  it('server/index.ts calls ingestAllSessions', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const indexContent = readFileSync(resolve('server/index.ts'), 'utf-8');
    expect(indexContent).toContain('ingestAllSessions');
  });

  it('server/index.ts sets up periodic re-ingestion', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const indexContent = readFileSync(resolve('server/index.ts'), 'utf-8');
    // Must have setInterval (or setTimeout loop) referencing ingestAllSessions specifically
    const hasPeriodicIngest = indexContent.includes('setInterval') && indexContent.includes('ingestAllSessions');
    const hasTimeoutIngest = indexContent.includes('setTimeout') && indexContent.includes('ingestAllSessions');
    expect(hasPeriodicIngest || hasTimeoutIngest).toBe(true);
  });
});
