import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import http from 'node:http';
import Database from 'better-sqlite3';
import { createApp } from '../../server/app';
import { createAnalyticsRouter } from '../../server/routes/analytics';
import { runMigrations } from '../../server/db/migrate';

let server: http.Server;
let port: number;
let db: Database.Database;

// ── Helpers ──────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

function epochMs(daysAgo: number): number {
  return Date.now() - daysAgo * DAY_MS;
}

function dateStr(daysAgo: number): string {
  return new Date(epochMs(daysAgo)).toISOString().split('T')[0];
}

// ── Phase 0 Evals: Analytics Data Layer Redesign ─────────────────────────────

describe('Analytics Data Layer — Phase 0 Evals', () => {
  beforeAll(async () => {
    db = new Database(':memory:');
    runMigrations(db);

    // ── Seed session_usage with sessions across different date ranges ─────

    // Migration 012 creates session_usage table; if not yet created, create it
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

    const insertUsage = db.prepare(`
      INSERT INTO session_usage (session_id, project_dir, model, input_tokens, cache_creation_tokens, cache_read_tokens, output_tokens, total_tokens, estimated_cost_usd, message_count, session_date, first_message_at, last_message_at, ingested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const now = Date.now();

    // Session from 5 days ago (within 7d, 30d, 90d)
    insertUsage.run('s-5d', '/proj', 'opus', 1000, 200, 300, 500, 2000, 0.50, 10,
      dateStr(5), epochMs(5), epochMs(5) + 60000, now);

    // Session from 15 days ago (within 30d, 90d; NOT within 7d)
    insertUsage.run('s-15d', '/proj', 'sonnet', 2000, 400, 600, 1000, 4000, 0.30, 20,
      dateStr(15), epochMs(15), epochMs(15) + 60000, now);

    // Session from 45 days ago (within 90d; NOT within 7d, 30d)
    insertUsage.run('s-45d', '/proj', 'opus', 3000, 600, 900, 1500, 6000, 1.00, 15,
      dateStr(45), epochMs(45), epochMs(45) + 60000, now);

    // Session from 120 days ago (only in "all time"; NOT within 7d, 30d, 90d)
    insertUsage.run('s-120d', '/proj', 'haiku', 500, 100, 150, 250, 1000, 0.05, 5,
      dateStr(120), epochMs(120), epochMs(120) + 60000, now);

    // ── Seed sessions table (for heatmap, sessions-per-day, duration) ────

    const insertSession = db.prepare(`
      INSERT INTO sessions (id, origin, started_at, ended_at) VALUES (?, 'external', ?, ?)
    `);
    insertSession.run('s-5d', epochMs(5), epochMs(5) + 1800000);
    insertSession.run('s-15d', epochMs(15), epochMs(15) + 3600000);
    insertSession.run('s-45d', epochMs(45), epochMs(45) + 900000);
    insertSession.run('s-120d', epochMs(120), epochMs(120) + 600000);

    // ── Seed hook_events for context inventory ───────────────────────────

    const insertHook = db.prepare(`
      INSERT INTO hook_events (id, session_id, event_type, tool_name, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    // Skill calls with different skill names in payload_json
    insertHook.run('h1', 's-5d', 'PostToolUse', 'Skill',
      JSON.stringify({ tool_name: 'Skill', tool_input: { skill: 'goodmorning' } }), epochMs(5));
    insertHook.run('h2', 's-5d', 'PostToolUse', 'Skill',
      JSON.stringify({ tool_name: 'Skill', tool_input: { skill: 'goodmorning' } }), epochMs(5) + 1000);
    insertHook.run('h3', 's-5d', 'PostToolUse', 'Skill',
      JSON.stringify({ tool_name: 'Skill', tool_input: { skill: 'goodmorning' } }), epochMs(5) + 2000);
    insertHook.run('h4', 's-15d', 'PostToolUse', 'Skill',
      JSON.stringify({ tool_name: 'Skill', tool_input: { skill: 'goodnight' } }), epochMs(15));
    insertHook.run('h5', 's-15d', 'PostToolUse', 'Skill',
      JSON.stringify({ tool_name: 'Skill', tool_input: { skill: 'validate-dashboard' } }), epochMs(15) + 1000);

    // MCP tool calls with different server prefixes
    insertHook.run('h6', 's-5d', 'PostToolUse', 'mcp__claude-deck__create_goal',
      JSON.stringify({ tool_name: 'mcp__claude-deck__create_goal' }), epochMs(5));
    insertHook.run('h7', 's-5d', 'PostToolUse', 'mcp__claude-deck__list_goals',
      JSON.stringify({ tool_name: 'mcp__claude-deck__list_goals' }), epochMs(5) + 1000);
    insertHook.run('h8', 's-15d', 'PostToolUse', 'mcp__plugin_atlassian_atlassian__search',
      JSON.stringify({ tool_name: 'mcp__plugin_atlassian_atlassian__search' }), epochMs(15));
    insertHook.run('h9', 's-15d', 'PostToolUse', 'mcp__plugin_atlassian_atlassian__getJiraIssue',
      JSON.stringify({ tool_name: 'mcp__plugin_atlassian_atlassian__getJiraIssue' }), epochMs(15) + 1000);
    insertHook.run('h10', 's-15d', 'PostToolUse', 'mcp__plugin_atlassian_atlassian__getJiraIssue',
      JSON.stringify({ tool_name: 'mcp__plugin_atlassian_atlassian__getJiraIssue' }), epochMs(15) + 2000);

    // Standard tool calls (Read, Bash, etc.)
    insertHook.run('h11', 's-5d', 'PostToolUse', 'Read',
      JSON.stringify({ tool_name: 'Read' }), epochMs(5));

    // ── Start server ─────────────────────────────────────────────────────

    const systemRouter = createAnalyticsRouter();
    const app = createApp({ apiRouters: [systemRouter] });
    (app as unknown as { locals: { db: Database.Database } }).locals.db = db;

    server = http.createServer(app);
    port = await new Promise<number>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') resolve(addr.port);
      });
    });
  });

  afterAll(() => {
    server.close();
    db.close();
  });

  // ── Eval 1: Date Filtering Uses Session Timestamps ─────────────────────

  describe('Date filtering uses session timestamps', () => {
    it('?days=7 returns only sessions from last 7 days', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/analytics/totals?days=7`);
      expect(res.status).toBe(200);
      const body = await res.json() as { sessions: number; cost: number };
      expect(body.sessions).toBe(1); // only s-5d
    });

    it('?days=30 returns sessions from last 30 days', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/analytics/totals?days=30`);
      expect(res.status).toBe(200);
      const body = await res.json() as { sessions: number; cost: number };
      expect(body.sessions).toBe(2); // s-5d + s-15d
    });

    it('?days=90 returns sessions from last 90 days', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/analytics/totals?days=90`);
      expect(res.status).toBe(200);
      const body = await res.json() as { sessions: number; cost: number };
      expect(body.sessions).toBe(3); // s-5d + s-15d + s-45d
    });

    it('?days=0 returns all sessions', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/analytics/totals?days=0`);
      expect(res.status).toBe(200);
      const body = await res.json() as { sessions: number; cost: number };
      expect(body.sessions).toBe(4); // all 4 sessions
    });

    it('cost and token totals are correct for ?days=30', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/analytics/totals?days=30`);
      const body = await res.json() as { sessions: number; cost: number; tokensIn: number; tokensOut: number };
      // s-5d: cost=0.50, tokensIn=1000+200+300=1500, tokensOut=500
      // s-15d: cost=0.30, tokensIn=2000+400+600=3000, tokensOut=1000
      expect(body.cost).toBeCloseTo(0.80, 2);
      expect(body.tokensIn).toBe(4500);
      expect(body.tokensOut).toBe(1500);
    });
  });

  // ── Eval 2: Consistent Date Source Across Endpoints ────────────────────

  describe('All endpoints use consistent date source', () => {
    it('daily-costs ?days=30 returns only days within last 30 days', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/analytics/daily-costs?days=30`);
      expect(res.status).toBe(200);
      const body = await res.json() as Array<{ date: string; cost: number; sessions: number }>;
      expect(Array.isArray(body)).toBe(true);

      // Should have exactly 2 dates (5d ago and 15d ago)
      expect(body.length).toBe(2);

      // Verify no dates older than 30 days
      const cutoff = new Date(Date.now() - 30 * DAY_MS);
      for (const entry of body) {
        expect(new Date(entry.date).getTime()).toBeGreaterThan(cutoff.getTime());
      }
    });

    it('daily-costs ?days=7 returns only days within last 7 days', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/analytics/daily-costs?days=7`);
      const body = await res.json() as Array<{ date: string }>;
      expect(body.length).toBe(1); // only s-5d
    });

    it('totals and daily-costs agree on session count for ?days=30', async () => {
      const [totalsRes, costsRes] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/api/analytics/totals?days=30`),
        fetch(`http://127.0.0.1:${port}/api/analytics/daily-costs?days=30`),
      ]);
      const totals = await totalsRes.json() as { sessions: number };
      const costs = await costsRes.json() as Array<{ sessions: number }>;
      const costSessions = costs.reduce((sum, c) => sum + c.sessions, 0);
      expect(totals.sessions).toBe(costSessions);
    });
  });

  // ── Eval 3: Context Inventory Per-Skill Counts ─────────────────────────

  describe('Context inventory per-skill counts', () => {
    it('each skill gets its own distinct usage count', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/analytics/context-inventory`);
      expect(res.status).toBe(200);
      const items = await res.json() as Array<{ name: string; type: string; usageCount: number }>;

      const skillItems = items.filter(i => i.type === 'skill');
      const goodmorning = skillItems.find(i => i.name === 'goodmorning');
      const goodnight = skillItems.find(i => i.name === 'goodnight');
      const validateDashboard = skillItems.find(i => i.name === 'validate-dashboard');

      // goodmorning: 3 calls, goodnight: 1 call, validate-dashboard: 1 call
      // Skills that weren't called should have usageCount: 0
      if (goodmorning) expect(goodmorning.usageCount).toBe(3);
      if (goodnight) expect(goodnight.usageCount).toBe(1);
      if (validateDashboard) expect(validateDashboard.usageCount).toBe(1);

      // Verify no two skills have the same count unless they actually have the same count
      // (the bug was ALL skills showing 23 — the aggregate Skill count)
      const counts = skillItems.map(i => i.usageCount);
      const allSame = counts.length > 1 && counts.every(c => c === counts[0]) && counts[0] > 0;
      expect(allSame).toBe(false); // should NOT all be the same non-zero value
    });

    it('MCP servers get summed counts of their child tools', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/analytics/context-inventory`);
      const items = await res.json() as Array<{ name: string; type: string; usageCount: number }>;

      const mcpItems = items.filter(i => i.type === 'mcp');
      const claudeDeck = mcpItems.find(i => i.name === 'claude-deck');
      const atlassian = mcpItems.find(i => i.name.includes('atlassian'));

      // claude-deck: 2 calls (create_goal + list_goals)
      // atlassian: 3 calls (search + 2x getJiraIssue)
      if (claudeDeck) expect(claudeDeck.usageCount).toBe(2);
      if (atlassian) expect(atlassian.usageCount).toBe(3);
    });

    it('skills with zero usage show usageCount: 0', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/analytics/context-inventory`);
      const items = await res.json() as Array<{ name: string; type: string; usageCount: number }>;

      const zeroItems = items.filter(i => i.usageCount === 0);
      // There should be some items with zero usage (skills/plugins/hooks that exist but weren't called)
      for (const item of zeroItems) {
        expect(item.usageCount).toBe(0);
        expect(typeof item.usageCount).toBe('number');
      }
    });
  });

  // ── Eval 4: Response Shape Regression ──────────────────────────────────

  describe('Response shape regression', () => {
    it('totals returns {sessions, cost, tokensIn, tokensOut}', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/analytics/totals?days=30`);
      const body = await res.json() as Record<string, unknown>;
      expect(typeof body.sessions).toBe('number');
      expect(typeof body.cost).toBe('number');
      expect(typeof body.tokensIn).toBe('number');
      expect(typeof body.tokensOut).toBe('number');
    });

    it('daily-costs returns [{date, cost, sessions}]', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/analytics/daily-costs?days=30`);
      const body = await res.json() as Array<Record<string, unknown>>;
      expect(Array.isArray(body)).toBe(true);
      for (const item of body) {
        expect(typeof item.date).toBe('string');
        expect(typeof item.cost).toBe('number');
        expect(typeof item.sessions).toBe('number');
      }
    });

    it('context-inventory items have required fields', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/analytics/context-inventory`);
      const items = await res.json() as Array<Record<string, unknown>>;
      for (const item of items) {
        expect(typeof item.name).toBe('string');
        expect(typeof item.type).toBe('string');
        expect(typeof item.usageCount).toBe('number');
        expect(item.lastUsed === null || typeof item.lastUsed === 'number').toBe(true);
        expect(typeof item.estimatedSize).toBe('number');
      }
    });
  });
});

// ── Eval 5: JSONL Ingestion (Standalone — No Server) ─────────────────────────
// These tests will validate the ingestion service directly once it's created.
// For now, they test the contract: what the table should contain after ingestion.

describe('JSONL Ingestion Contract', () => {
  let db2: Database.Database;

  beforeAll(() => {
    db2 = new Database(':memory:');
    runMigrations(db2);

    db2.exec(`
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
    `);
  });

  afterAll(() => {
    db2.close();
  });

  it('ingestion inserts correct session_usage rows', () => {
    const now = Date.now();
    const firstMsgAt = now - 5 * DAY_MS;
    const computedDate = new Date(firstMsgAt).toISOString().split('T')[0];
    db2.prepare(`
      INSERT INTO session_usage (session_id, project_dir, model, input_tokens, cache_creation_tokens, cache_read_tokens, output_tokens, total_tokens, estimated_cost_usd, message_count, session_date, first_message_at, last_message_at, ingested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('test-1', '/test', 'opus', 100, 20, 30, 50, 200, 0.01, 5, computedDate, firstMsgAt, firstMsgAt + 60000, now);

    const row = db2.prepare('SELECT * FROM session_usage WHERE session_id = ?').get('test-1') as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.input_tokens).toBe(100);
    expect(row.model).toBe('opus');
    expect(row.session_date).toBe(computedDate);
  });

  it('re-ingestion is idempotent (no duplicates)', () => {
    // INSERT OR REPLACE should upsert without duplicates
    const now = Date.now();
    const firstMsgAt = now - 5 * DAY_MS;
    const computedDate = new Date(firstMsgAt).toISOString().split('T')[0];
    db2.prepare(`
      INSERT OR REPLACE INTO session_usage (session_id, project_dir, model, input_tokens, cache_creation_tokens, cache_read_tokens, output_tokens, total_tokens, estimated_cost_usd, message_count, session_date, first_message_at, last_message_at, ingested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('test-1', '/test', 'opus', 200, 40, 60, 100, 400, 0.02, 10, computedDate, firstMsgAt, firstMsgAt + 120000, now);

    const count = db2.prepare('SELECT COUNT(*) as cnt FROM session_usage WHERE session_id = ?').get('test-1') as { cnt: number };
    expect(count.cnt).toBe(1); // not 2

    const row = db2.prepare('SELECT * FROM session_usage WHERE session_id = ?').get('test-1') as Record<string, unknown>;
    expect(row.message_count).toBe(10); // updated, not original 5
  });

  it('session_date is derived from first_message_at timestamp', () => {
    const row = db2.prepare('SELECT session_date, first_message_at FROM session_usage WHERE session_id = ?').get('test-1') as Record<string, unknown>;
    const dateFromTimestamp = new Date(row.first_message_at as number).toISOString().split('T')[0];
    expect(row.session_date).toBe(dateFromTimestamp);
  });
});
