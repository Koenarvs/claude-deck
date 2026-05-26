import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/db/migrate';
import { ApprovalCoordinator } from '../../server/approval-coordinator';
import { HookIngest } from '../../server/hook-ingest';
import { createSkillExecutionService } from '../../server/services/skill-execution-service';
import type { SkillExecutionService } from '../../server/services/skill-execution-service';

vi.mock('../../server/ws', () => ({
  broadcast: vi.fn(),
}));

vi.mock('../../server/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../server/skill-scanner', () => ({
  scanSkills: vi.fn(() => [
    { name: 'validate-dashboard', description: 'Validate dashboard', scope: 'user', type: 'skills', path: '/home/.claude/skills/validate-dashboard/SKILL.md' },
    { name: 'create-view', description: 'Create view', scope: 'user', type: 'skills', path: '/home/.claude/skills/create-view/SKILL.md' },
  ]),
}));

vi.mock('../../server/services/usage-service', () => ({
  getSessionUsage: vi.fn(() => ({
    inputTokens: 500,
    outputTokens: 200,
    estimatedCostUsd: 0.02,
    totalTokens: 700,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    currentContextTokens: 0,
    contextWindow: 200000,
    contextPct: 0,
    messageCount: 3,
  })),
}));

let db: Database.Database;
let coordinator: ApprovalCoordinator;
let ingest: HookIngest;
let execService: SkillExecutionService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  coordinator = new ApprovalCoordinator(db, 100);
  execService = createSkillExecutionService(db);
  ingest = new HookIngest(db, coordinator, execService);
  vi.clearAllMocks();
});

afterEach(() => {
  coordinator.shutdown();
  db.close();
});

describe('HookIngest — skill detection', () => {
  function createSession(id: string): void {
    db.prepare(
      `INSERT INTO sessions (id, origin, stream_event_count, hook_event_count, stderr_bytes, started_at)
       VALUES (?, 'external', 0, 0, 0, ?)`,
    ).run(id, Date.now());
  }

  it('detects /skillname in UserPromptSubmit and creates execution', () => {
    createSession('s1');
    ingest.onUserPromptSubmit({
      session_id: 's1',
      tool_input: { prompt: '/validate-dashboard' },
    });

    const rows = db.prepare(`SELECT * FROM skill_executions WHERE session_id = 's1'`).all();
    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;
    expect(row['skill_name']).toBe('validate-dashboard');
    expect(row['outcome']).toBe('pending');
  });

  it('does NOT create execution for non-skill prompts', () => {
    createSession('s2');
    ingest.onUserPromptSubmit({
      session_id: 's2',
      tool_input: { prompt: 'hello world' },
    });

    const rows = db.prepare(`SELECT * FROM skill_executions WHERE session_id = 's2'`).all();
    expect(rows).toHaveLength(0);
  });

  it('does NOT create execution for unknown /commands', () => {
    createSession('s3');
    ingest.onUserPromptSubmit({
      session_id: 's3',
      tool_input: { prompt: '/nonexistent-skill' },
    });

    const rows = db.prepare(`SELECT * FROM skill_executions WHERE session_id = 's3'`).all();
    expect(rows).toHaveLength(0);
  });

  it('detects prompt from top-level payload field', () => {
    createSession('s4');
    ingest.onUserPromptSubmit({
      session_id: 's4',
      prompt: '/create-view',
    } as Record<string, unknown> & { session_id: string });

    const rows = db.prepare(`SELECT * FROM skill_executions WHERE session_id = 's4'`).all();
    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;
    expect(row['skill_name']).toBe('create-view');
  });

  it('finalizes execution on Stop event', () => {
    createSession('s5');
    ingest.onUserPromptSubmit({
      session_id: 's5',
      tool_input: { prompt: '/validate-dashboard' },
    });

    // Verify pending
    let row = db.prepare(`SELECT * FROM skill_executions WHERE session_id = 's5'`).get() as Record<string, unknown>;
    expect(row['outcome']).toBe('pending');

    // Fire Stop
    ingest.onStop({ session_id: 's5' });

    // Verify finalized
    row = db.prepare(`SELECT * FROM skill_executions WHERE session_id = 's5'`).get() as Record<string, unknown>;
    expect(row['outcome']).not.toBe('pending');
    expect(row['ended_at']).not.toBeNull();
    expect(row['duration_s']).toBeGreaterThanOrEqual(0);
  });
});
