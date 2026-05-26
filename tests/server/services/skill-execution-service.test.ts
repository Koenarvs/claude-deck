import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';
import { createSkillExecutionService } from '../../../server/services/skill-execution-service';
import type { SkillExecutionService } from '../../../server/services/skill-execution-service';

vi.mock('../../../server/ws', () => ({
  broadcast: vi.fn(),
}));

vi.mock('../../../server/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../../server/services/usage-service', () => ({
  getSessionUsage: vi.fn(() => ({
    inputTokens: 1000,
    outputTokens: 500,
    estimatedCostUsd: 0.05,
    totalTokens: 1500,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    currentContextTokens: 0,
    contextWindow: 200000,
    contextPct: 0,
    messageCount: 5,
  })),
}));

let db: Database.Database;
let service: SkillExecutionService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  service = createSkillExecutionService(db);
});

afterEach(() => {
  db.close();
});

describe('SkillExecutionService', () => {
  describe('createExecution', () => {
    it('creates an execution record with pending outcome', () => {
      const exec = service.createExecution('session-1', 'test-skill', '/path/to/SKILL.md', 'goal-1');

      expect(exec.id).toBeTruthy();
      expect(exec.session_id).toBe('session-1');
      expect(exec.skill_name).toBe('test-skill');
      expect(exec.skill_path).toBe('/path/to/SKILL.md');
      expect(exec.goal_id).toBe('goal-1');
      expect(exec.outcome).toBe('pending');
      expect(exec.started_at).toBeGreaterThan(0);
      expect(exec.user_rating).toBeNull();
    });

    it('creates execution without goal_id', () => {
      const exec = service.createExecution('session-2', 'test-skill', null);
      expect(exec.goal_id).toBeNull();
      expect(exec.skill_path).toBeNull();
    });
  });

  describe('getExecution', () => {
    it('returns null for non-existent id', () => {
      expect(service.getExecution('nonexistent')).toBeNull();
    });

    it('returns the execution by id', () => {
      const created = service.createExecution('s1', 'my-skill', '/path');
      const fetched = service.getExecution(created.id);
      expect(fetched?.id).toBe(created.id);
      expect(fetched?.skill_name).toBe('my-skill');
    });
  });

  describe('finalizeExecution', () => {
    it('finalizes a pending execution with metrics', () => {
      // Create a session row so finalizeExecution can look up model
      db.prepare(`INSERT INTO sessions (id, origin, stream_event_count, hook_event_count, stderr_bytes, started_at)
                  VALUES ('s1', 'external', 0, 0, 0, ?)`).run(Date.now() - 10000);

      service.createExecution('s1', 'my-skill', '/path');

      const finalized = service.finalizeExecution('s1');
      expect(finalized).not.toBeNull();
      expect(finalized!.outcome).not.toBe('pending');
      expect(finalized!.ended_at).toBeGreaterThan(0);
      expect(finalized!.duration_s).toBeGreaterThanOrEqual(0);
      expect(finalized!.input_tokens).toBe(1000);
      expect(finalized!.output_tokens).toBe(500);
    });

    it('returns null when no pending execution exists for session', () => {
      const result = service.finalizeExecution('nonexistent-session');
      expect(result).toBeNull();
    });
  });

  describe('rateExecution', () => {
    it('stores rating and notes', () => {
      const exec = service.createExecution('s1', 'my-skill', '/path');

      const rated = service.rateExecution(exec.id, 4, 'Good but slow');
      expect(rated).not.toBeNull();
      expect(rated!.user_rating).toBe(4);
      expect(rated!.user_notes).toBe('Good but slow');
    });

    it('returns null for non-existent execution', () => {
      expect(service.rateExecution('nonexistent', 3)).toBeNull();
    });
  });

  describe('getExecutionHistory', () => {
    it('returns executions in reverse chronological order', () => {
      service.createExecution('s1', 'my-skill', '/path');
      service.createExecution('s2', 'my-skill', '/path');
      service.createExecution('s3', 'other-skill', '/path2');

      const history = service.getExecutionHistory('my-skill');
      expect(history).toHaveLength(2);
      expect(history[0].started_at).toBeGreaterThanOrEqual(history[1].started_at);
    });

    it('respects limit parameter', () => {
      service.createExecution('s1', 'my-skill', '/path');
      service.createExecution('s2', 'my-skill', '/path');
      service.createExecution('s3', 'my-skill', '/path');

      const history = service.getExecutionHistory('my-skill', 2);
      expect(history).toHaveLength(2);
    });
  });

  describe('getSkillMetrics', () => {
    it('returns zeros for skill with no executions', () => {
      const metrics = service.getSkillMetrics('nonexistent');
      expect(metrics.execution_count).toBe(0);
      expect(metrics.success_rate).toBe(0);
      expect(metrics.avg_duration_s).toBe(0);
      expect(metrics.avg_cost_usd).toBe(0);
      expect(metrics.total_cost_usd).toBe(0);
      expect(metrics.last_execution).toBeNull();
    });

    it('computes metrics from finalized executions', () => {
      db.prepare(`INSERT INTO sessions (id, origin, stream_event_count, hook_event_count, stderr_bytes, started_at)
                  VALUES ('s1', 'external', 0, 0, 0, ?)`).run(Date.now() - 10000);

      service.createExecution('s1', 'my-skill', '/path');
      service.finalizeExecution('s1');

      const metrics = service.getSkillMetrics('my-skill');
      expect(metrics.execution_count).toBe(1);
      expect(metrics.last_execution).not.toBeNull();
    });
  });
});
