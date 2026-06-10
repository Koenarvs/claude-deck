import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createApp } from '../../server/app';
import { createSystemRouter } from '../../server/routes/system';
import { runMigrations } from '../../server/db/migrate';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INGESTION_SERVICE_PATH = path.resolve(__dirname, '../../server/services/ingestion-service.ts');

// ── Helpers ──────────────────────────────────────────────────────────────────

function createJsonlContent(options: {
  model?: string;
  timestamp?: string;
  messages?: Array<{
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  }>;
}): string {
  const lines: string[] = [];
  const ts = options.timestamp ?? '2026-05-15T10:00:00Z';

  lines.push(JSON.stringify({
    type: 'system',
    subtype: 'init',
    model: options.model ?? 'claude-sonnet-4-6',
    timestamp: ts,
  }));

  const msgs = options.messages ?? [
    { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 50 },
  ];

  for (const msg of msgs) {
    lines.push(JSON.stringify({
      timestamp: ts,
      message: {
        usage: {
          input_tokens: msg.input_tokens ?? 0,
          cache_creation_input_tokens: msg.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: msg.cache_read_input_tokens ?? 0,
          output_tokens: msg.output_tokens ?? 0,
        },
      },
    }));
  }

  return lines.join('\n') + '\n';
}

async function loadIngestionService(): Promise<{ ingestAllSessions: (db: Database.Database, projectsDir: string) => Promise<void> }> {
  return import(/* @vite-ignore */ INGESTION_SERVICE_PATH);
}

// ── Phase 2 Evals: Ingestion Service ─────────────────────────────────────────

describe('Ingestion Service', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeAll(() => {
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

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-deck-test-'));
    const projectDir = path.join(tmpDir, 'test-project');
    fs.mkdirSync(projectDir, { recursive: true });

    fs.writeFileSync(
      path.join(projectDir, 'session-alpha.jsonl'),
      createJsonlContent({
        model: 'claude-sonnet-4-6',
        timestamp: '2026-05-15T10:00:00Z',
        messages: [
          { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 50 },
          { input_tokens: 200, cache_creation_input_tokens: 40, cache_read_input_tokens: 60, output_tokens: 100 },
        ],
      }),
    );

    fs.writeFileSync(
      path.join(projectDir, 'session-beta.jsonl'),
      createJsonlContent({
        model: 'claude-opus-4-6',
        timestamp: '2026-05-10T08:00:00Z',
        messages: [
          { input_tokens: 500, cache_creation_input_tokens: 100, cache_read_input_tokens: 150, output_tokens: 250 },
        ],
      }),
    );

    fs.writeFileSync(
      path.join(projectDir, 'session-fable.jsonl'),
      createJsonlContent({
        model: 'claude-fable-5[1m]',
        timestamp: '2026-05-12T09:00:00Z',
        messages: [
          { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 500 },
        ],
      }),
    );

    fs.writeFileSync(
      path.join(projectDir, 'session-unknown.jsonl'),
      createJsonlContent({
        model: 'totally-made-up-model',
        timestamp: '2026-05-13T09:00:00Z',
        messages: [
          { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 500 },
        ],
      }),
    );
  });

  afterAll(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ingestion service file exists', () => {
    expect(fs.existsSync(INGESTION_SERVICE_PATH)).toBe(true);
  });

  it('ingestion service exports ingestAllSessions function', async () => {
    const mod = await loadIngestionService();
    expect(typeof mod.ingestAllSessions).toBe('function');
  });

  it('ingestAllSessions populates session_usage table', async () => {
    const { ingestAllSessions } = await loadIngestionService();
    await ingestAllSessions(db, tmpDir);

    const rows = db.prepare('SELECT * FROM session_usage ORDER BY session_id').all() as Array<Record<string, unknown>>;
    expect(rows.length).toBe(4);
  });

  it('ingested rows have correct token counts', async () => {
    const row = db.prepare('SELECT * FROM session_usage WHERE session_id = ?').get('session-alpha') as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.input_tokens).toBe(300);
    expect(row.cache_creation_tokens).toBe(60);
    expect(row.cache_read_tokens).toBe(90);
    expect(row.output_tokens).toBe(150);
    expect(row.total_tokens).toBe(600);
    expect(row.message_count).toBe(2);
  });

  it('ingested rows have correct model detection', async () => {
    const alpha = db.prepare('SELECT model FROM session_usage WHERE session_id = ?').get('session-alpha') as Record<string, unknown>;
    expect((alpha.model as string).toLowerCase()).toContain('sonnet');

    const beta = db.prepare('SELECT model FROM session_usage WHERE session_id = ?').get('session-beta') as Record<string, unknown>;
    expect((beta.model as string).toLowerCase()).toContain('opus');
  });

  it('ingested rows have session_date derived from JSONL timestamp', async () => {
    const alpha = db.prepare('SELECT session_date FROM session_usage WHERE session_id = ?').get('session-alpha') as Record<string, unknown>;
    expect(alpha.session_date).toBe('2026-05-15');

    const beta = db.prepare('SELECT session_date FROM session_usage WHERE session_id = ?').get('session-beta') as Record<string, unknown>;
    expect(beta.session_date).toBe('2026-05-10');
  });

  it('re-ingestion is idempotent (no duplicates)', async () => {
    const { ingestAllSessions } = await loadIngestionService();
    await ingestAllSessions(db, tmpDir);

    const count = db.prepare('SELECT COUNT(*) as cnt FROM session_usage').get() as { cnt: number };
    expect(count.cnt).toBe(4);
  });

  it('re-ingestion updates rows when file has grown', async () => {
    const projectDir = path.join(tmpDir, 'test-project');
    const extraLine = JSON.stringify({
      timestamp: '2026-05-15T11:00:00Z',
      message: {
        usage: { input_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 15, output_tokens: 25 },
      },
    });
    fs.appendFileSync(path.join(projectDir, 'session-alpha.jsonl'), extraLine + '\n');

    const { ingestAllSessions } = await loadIngestionService();
    await ingestAllSessions(db, tmpDir);

    const row = db.prepare('SELECT * FROM session_usage WHERE session_id = ?').get('session-alpha') as Record<string, unknown>;
    expect(row.message_count).toBe(3);
    expect(row.input_tokens).toBe(350);
  });

  it('estimated_cost_usd is calculated correctly', async () => {
    const row = db.prepare('SELECT estimated_cost_usd FROM session_usage WHERE session_id = ?').get('session-beta') as Record<string, unknown>;
    expect(row.estimated_cost_usd).toBeGreaterThan(0);
    expect(typeof row.estimated_cost_usd).toBe('number');
  });

  it('Fable 5 session is priced at the frontier (Opus) rate, not zero', async () => {
    const row = db.prepare('SELECT model, estimated_cost_usd FROM session_usage WHERE session_id = ?').get('session-fable') as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect((row.model as string)).toContain('fable');
    // 1000 input @ $15/M + 500 output @ $75/M = 0.015 + 0.0375 = 0.0525
    expect(row.estimated_cost_usd).toBeCloseTo(0.0525, 4);
  });

  it('unknown model is ingested with cost 0 and a non-null model string (row kept, not Opus-priced)', async () => {
    const row = db.prepare('SELECT model, input_tokens, output_tokens, total_tokens, estimated_cost_usd FROM session_usage WHERE session_id = ?').get('session-unknown') as Record<string, unknown>;
    expect(row).toBeTruthy(); // not dropped
    expect(row.model).toBe('totally-made-up-model'); // non-null model preserved
    expect(row.input_tokens).toBe(1000); // token counts intact
    expect(row.output_tokens).toBe(500);
    expect(row.total_tokens).toBe(1500);
    expect(row.estimated_cost_usd).toBe(0); // uncosted, NOT Opus-priced
  });
});

// ── Phase 5 Evals: Cleanup & Health ──────────────────────────────────────────

describe('Analytics Cleanup & Health', () => {
  let server: http.Server;
  let port: number;
  let db: Database.Database;

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
    `);

    const now = Date.now();
    db.prepare(`INSERT INTO session_usage (session_id, project_dir, model, input_tokens, cache_creation_tokens, cache_read_tokens, output_tokens, total_tokens, estimated_cost_usd, message_count, session_date, first_message_at, last_message_at, ingested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'test-s1', '/proj', 'opus', 1000, 200, 300, 500, 2000, 0.50, 10,
      '2026-05-15', now - 5 * 86400000, now - 5 * 86400000 + 60000, now,
    );

    const systemRouter = createSystemRouter();
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

  it('totals endpoint uses session_usage directly (no JSONL fallback)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/analytics/totals?days=30`);
    expect(res.status).toBe(200);
    const body = await res.json() as { sessions: number; cost: number };
    expect(body.sessions).toBe(1);
    expect(body.cost).toBeCloseTo(0.50, 2);
  });

  it('daily-costs endpoint uses session_usage directly (no JSONL fallback)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/analytics/daily-costs?days=30`);
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ date: string; cost: number; sessions: number }>;
    expect(body.length).toBe(1);
    expect(body[0].date).toBe('2026-05-15');
  });

  it('health endpoint includes ingestion status', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);

    if (body.ingestion !== undefined) {
      const ingestion = body.ingestion as Record<string, unknown>;
      expect(typeof ingestion.sessionsIngested).toBe('number');
      expect(ingestion.lastIngestionAt === null || typeof ingestion.lastIngestionAt === 'number').toBe(true);
    } else {
      const statusRes = await fetch(`http://127.0.0.1:${port}/api/analytics/ingestion-status`);
      expect(statusRes.status).toBe(200);
      const status = await statusRes.json() as Record<string, unknown>;
      expect(typeof status.sessionsIngested).toBe('number');
    }
  });

  it('getSessionUsage still works for single-session queries (KanbanCard compatibility)', async () => {
    const { getSessionUsage } = await import('../../server/services/usage-service');
    expect(typeof getSessionUsage).toBe('function');
    const result = getSessionUsage('nonexistent-session');
    expect(result).toBeNull();
  });
});
