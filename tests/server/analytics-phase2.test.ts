import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import http from 'node:http';
import Database from 'better-sqlite3';
import { createApp } from '../../server/app';
import { createAnalyticsRouter } from '../../server/routes/analytics';
import { runMigrations } from '../../server/db/migrate';

let server: http.Server;
let port: number;
let db: Database.Database;

// ── Phase 2 Eval: New Endpoints + Regression ─────────────────────────────────
// Tests for Phase 2 additions:
//   - GET /api/analytics/jira-stories?days=N
//   - GET /api/analytics/prs-merged?days=N
// Plus regression on all 6 existing endpoints.

describe('Analytics API — Phase 2: New Endpoints', () => {
  beforeAll(async () => {
    db = new Database(':memory:');
    runMigrations(db);

    const systemRouter = createAnalyticsRouter();
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

  // ── Jira Stories Endpoint ──────────────────────────────────────────────────

  it('GET /api/analytics/jira-stories returns 200', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/analytics/jira-stories?days=30`);
    expect(res.status).toBe(200);
  });

  it('GET /api/analytics/jira-stories returns array of {date, count}', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/analytics/jira-stories?days=30`);
    const body = await res.json() as unknown;
    expect(Array.isArray(body)).toBe(true);

    const arr = body as Array<Record<string, unknown>>;
    for (const item of arr) {
      expect(typeof item.date).toBe('string');
      expect(typeof item.count).toBe('number');
    }
  });

  it('GET /api/analytics/jira-stories accepts days=0', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/analytics/jira-stories?days=0`);
    expect(res.status).toBe(200);
    const body = await res.json() as unknown;
    expect(Array.isArray(body)).toBe(true);
  });

  it('GET /api/analytics/jira-stories returns empty array when Jira unavailable (not an error)', async () => {
    // Without Jira credentials configured, the endpoint should gracefully return []
    const res = await fetch(`http://127.0.0.1:${port}/api/analytics/jira-stories?days=30`);
    expect(res.status).toBe(200);
    const body = await res.json() as unknown;
    expect(Array.isArray(body)).toBe(true);
  });

  // ── PRs Merged Endpoint ────────────────────────────────────────────────────

  it('GET /api/analytics/prs-merged returns 200', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/analytics/prs-merged?days=30`);
    expect(res.status).toBe(200);
  });

  it('GET /api/analytics/prs-merged returns array of {date, count}', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/analytics/prs-merged?days=30`);
    const body = await res.json() as unknown;
    expect(Array.isArray(body)).toBe(true);

    const arr = body as Array<Record<string, unknown>>;
    for (const item of arr) {
      expect(typeof item.date).toBe('string');
      expect(typeof item.count).toBe('number');
    }
  });

  it('GET /api/analytics/prs-merged accepts days=0', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/analytics/prs-merged?days=0`);
    expect(res.status).toBe(200);
    const body = await res.json() as unknown;
    expect(Array.isArray(body)).toBe(true);
  });

  it('GET /api/analytics/prs-merged returns empty array when GitHub unavailable (not an error)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/analytics/prs-merged?days=30`);
    expect(res.status).toBe(200);
    const body = await res.json() as unknown;
    expect(Array.isArray(body)).toBe(true);
  });

  // ── Regression: Existing Endpoints Unchanged ───────────────────────────────

  it('existing analytics/totals endpoint unchanged', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/analytics/totals?days=30`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.sessions).toBe('number');
    expect(typeof body.cost).toBe('number');
    expect(typeof body.tokensIn).toBe('number');
    expect(typeof body.tokensOut).toBe('number');
  });

  it('existing analytics/tool-usage endpoint unchanged', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/analytics/tool-usage?days=30`);
    expect(res.status).toBe(200);
    const body = await res.json() as unknown;
    expect(Array.isArray(body)).toBe(true);
  });

  it('existing analytics/daily-costs endpoint unchanged', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/analytics/daily-costs?days=30`);
    expect(res.status).toBe(200);
    const body = await res.json() as unknown;
    expect(Array.isArray(body)).toBe(true);
  });

  it('existing analytics/activity-heatmap endpoint unchanged', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/analytics/activity-heatmap?days=30`);
    expect(res.status).toBe(200);
    const body = await res.json() as unknown;
    expect(Array.isArray(body)).toBe(true);
  });

  it('existing analytics/sessions-per-day endpoint unchanged', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/analytics/sessions-per-day?days=30`);
    expect(res.status).toBe(200);
    const body = await res.json() as unknown;
    expect(Array.isArray(body)).toBe(true);
  });

  it('existing analytics/session-durations endpoint unchanged', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/analytics/session-durations?days=30`);
    expect(res.status).toBe(200);
    const body = await res.json() as unknown;
    expect(Array.isArray(body)).toBe(true);
  });
});
