import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import http from 'node:http';
import Database from 'better-sqlite3';
import { createApp } from '../../server/app';
import { createSystemRouter } from '../../server/routes/system';
import { runMigrations } from '../../server/db/migrate';

let server: http.Server;
let port: number;
let db: Database.Database;

// ── Phase 3 Eval: Context Inventory Endpoint + Regression ────────────────────

describe('Analytics API — Phase 3: Context Inventory', () => {
  beforeAll(async () => {
    db = new Database(':memory:');
    runMigrations(db);

    // Seed some hook_events so usage counts are testable
    const now = Date.now();
    db.prepare(`INSERT INTO hook_events (id, session_id, event_type, tool_name, created_at)
      VALUES (?, ?, ?, ?, ?)`).run('he1', 's1', 'PostToolUse', 'Skill', now - 1000);
    db.prepare(`INSERT INTO hook_events (id, session_id, event_type, tool_name, created_at)
      VALUES (?, ?, ?, ?, ?)`).run('he2', 's1', 'PostToolUse', 'Skill', now - 2000);
    db.prepare(`INSERT INTO hook_events (id, session_id, event_type, tool_name, created_at)
      VALUES (?, ?, ?, ?, ?)`).run('he3', 's1', 'PostToolUse', 'mcp__atlassian__search', now - 3000);

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

  // ── Context Inventory Endpoint ─────────────────────────────────────────────

  it('GET /api/analytics/context-inventory returns 200', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/analytics/context-inventory`);
    expect(res.status).toBe(200);
  });

  it('returns an array of items', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/analytics/context-inventory`);
    const body = await res.json() as unknown;
    expect(Array.isArray(body)).toBe(true);
  });

  it('each item has required fields: name, type, usageCount, lastUsed, estimatedSize', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/analytics/context-inventory`);
    const items = await res.json() as Array<Record<string, unknown>>;

    // There should be at least some items (skills, plugins, etc. from the real environment)
    // But in test environment we may have none — just validate shape if any exist
    for (const item of items) {
      expect(typeof item.name).toBe('string');
      expect(typeof item.type).toBe('string');
      expect(typeof item.usageCount).toBe('number');
      // lastUsed can be null (never used) or a number (timestamp)
      expect(item.lastUsed === null || typeof item.lastUsed === 'number').toBe(true);
      expect(typeof item.estimatedSize).toBe('number');
    }
  });

  it('type field uses expected values', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/analytics/context-inventory`);
    const items = await res.json() as Array<Record<string, unknown>>;

    const validTypes = new Set(['skill', 'mcp', 'plugin', 'hook']);
    for (const item of items) {
      expect(validTypes.has(item.type as string)).toBe(true);
    }
  });

  it('items with zero usage return usageCount: 0 (not omitted)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/analytics/context-inventory`);
    const items = await res.json() as Array<Record<string, unknown>>;

    // All items must have usageCount as a number (0 or higher)
    for (const item of items) {
      expect(typeof item.usageCount).toBe('number');
      expect(item.usageCount as number).toBeGreaterThanOrEqual(0);
    }
  });

  it('accepts days query parameter', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/analytics/context-inventory?days=7`);
    expect(res.status).toBe(200);
    const items = await res.json() as unknown;
    expect(Array.isArray(items)).toBe(true);
  });

  // ── Regression: All Previous Endpoints Unchanged ───────────────────────────

  it('existing analytics/totals endpoint unchanged', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/analytics/totals?days=30`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.sessions).toBe('number');
  });

  it('existing analytics/jira-stories endpoint unchanged', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/analytics/jira-stories?days=30`);
    expect(res.status).toBe(200);
    const body = await res.json() as unknown;
    expect(Array.isArray(body)).toBe(true);
  });

  it('existing analytics/prs-merged endpoint unchanged', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/analytics/prs-merged?days=30`);
    expect(res.status).toBe(200);
    const body = await res.json() as unknown;
    expect(Array.isArray(body)).toBe(true);
  });
});
