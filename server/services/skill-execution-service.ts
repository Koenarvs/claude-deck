import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { broadcast } from '../ws';
import logger from '../logger';
import { getSessionUsage } from './usage-service';

// ── Types ───────────────────────────────────────────────────────────────────

export interface SkillExecution {
  id: string;
  session_id: string | null;
  skill_name: string;
  skill_path: string | null;
  started_at: number;
  ended_at: number | null;
  duration_s: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  estimated_cost_usd: number | null;
  tool_call_count: number;
  tool_error_count: number;
  goal_id: string | null;
  outcome: 'pending' | 'success' | 'failure' | 'partial';
  user_rating: number | null;
  user_notes: string | null;
  created_at: number;
  content_hash: string | null;
}

export interface SkillMetrics {
  execution_count: number;
  success_rate: number;
  avg_duration_s: number;
  avg_cost_usd: number;
  total_cost_usd: number;
  last_execution: SkillExecution | null;
}

interface ExecutionRow {
  id: string;
  session_id: string | null;
  skill_name: string;
  skill_path: string | null;
  started_at: number;
  ended_at: number | null;
  duration_s: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  estimated_cost_usd: number | null;
  tool_call_count: number;
  tool_error_count: number;
  goal_id: string | null;
  outcome: string;
  user_rating: number | null;
  user_notes: string | null;
  created_at: number;
  content_hash: string | null;
}

function rowToExecution(row: ExecutionRow): SkillExecution {
  return {
    ...row,
    outcome: row.outcome as SkillExecution['outcome'],
  };
}

// ── Service ─────────────────────────────────────────────────────────────────

export function createSkillExecutionService(db: Database.Database) {
  const insertStmt = db.prepare<[string, string | null, string, string | null, number, string | null, number, string | null]>(
    `INSERT INTO skill_executions (id, session_id, skill_name, skill_path, started_at, goal_id, created_at, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const getByIdStmt = db.prepare<[string], ExecutionRow>(
    `SELECT * FROM skill_executions WHERE id = ?`,
  );

  const getBySessionStmt = db.prepare<[string], ExecutionRow>(
    `SELECT * FROM skill_executions WHERE session_id = ? AND outcome = 'pending' ORDER BY created_at DESC LIMIT 1`,
  );

  const getHistoryStmt = db.prepare<[string, number], ExecutionRow>(
    `SELECT * FROM skill_executions WHERE skill_name = ? ORDER BY started_at DESC LIMIT ?`,
  );

  const getAllForSkillStmt = db.prepare<[string], ExecutionRow>(
    `SELECT * FROM skill_executions WHERE skill_name = ? AND outcome != 'pending' ORDER BY started_at DESC`,
  );

  const updateRatingStmt = db.prepare<[number, string | null, string]>(
    `UPDATE skill_executions SET user_rating = ?, user_notes = ? WHERE id = ?`,
  );

  function createExecution(
    sessionId: string | null,
    skillName: string,
    skillPath: string | null,
    goalId?: string | null,
    contentHash?: string | null,
  ): SkillExecution {
    const id = uuidv4();
    const now = Date.now();
    insertStmt.run(id, sessionId, skillName, skillPath, now, goalId ?? null, now, contentHash ?? null);

    const row = getByIdStmt.get(id);
    if (!row) throw new Error(`Failed to create skill execution: ${id}`);

    broadcast({ type: 'skill:execution-created', execution: rowToExecution(row) });
    logger.info({ id, sessionId, skillName }, 'Skill execution created');

    return rowToExecution(row);
  }

  function finalizeExecution(sessionId: string): SkillExecution | null {
    const row = getBySessionStmt.get(sessionId);
    if (!row) {
      logger.debug({ sessionId }, 'No pending skill execution for session');
      return null;
    }

    const now = Date.now();
    const durationS = (now - row.started_at) / 1000;

    // Get token usage from session JSONL files
    const session = db.prepare(`SELECT model FROM sessions WHERE id = ?`).get(sessionId) as
      | { model: string | null }
      | undefined;
    const usage = getSessionUsage(sessionId, session?.model);

    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    const estimatedCost = usage?.estimatedCostUsd ?? 0;

    // Count tool calls and errors from hook_events
    const toolCallRow = db.prepare(
      `SELECT COUNT(*) as cnt FROM hook_events WHERE session_id = ? AND event_type = 'PostToolUse'`,
    ).get(sessionId) as { cnt: number } | undefined;
    const toolCallCount = toolCallRow?.cnt ?? 0;

    // Count tool errors (PostToolUse events where payload indicates error)
    const toolErrorRow = db.prepare(
      `SELECT COUNT(*) as cnt FROM hook_events
       WHERE session_id = ? AND event_type = 'PostToolUse'
       AND (payload_json LIKE '%"error"%' OR payload_json LIKE '%"is_error":true%')`,
    ).get(sessionId) as { cnt: number } | undefined;
    const toolErrorCount = toolErrorRow?.cnt ?? 0;

    // Determine outcome based on error rate
    let outcome: SkillExecution['outcome'] = 'success';
    if (toolErrorCount > 0 && toolErrorCount >= toolCallCount) {
      outcome = 'failure';
    } else if (toolErrorCount > 0) {
      outcome = 'partial';
    }

    db.prepare(
      `UPDATE skill_executions
       SET ended_at = ?, duration_s = ?, input_tokens = ?, output_tokens = ?,
           estimated_cost_usd = ?, tool_call_count = ?, tool_error_count = ?, outcome = ?
       WHERE id = ?`,
    ).run(now, durationS, inputTokens, outputTokens, estimatedCost, toolCallCount, toolErrorCount, outcome, row.id);

    const updated = getByIdStmt.get(row.id);
    if (!updated) return null;

    const execution = rowToExecution(updated);
    broadcast({ type: 'skill:execution-finalized', execution });
    logger.info({ id: row.id, skillName: row.skill_name, outcome, durationS }, 'Skill execution finalized');

    return execution;
  }

  function rateExecution(executionId: string, rating: number, notes?: string | null): SkillExecution | null {
    const row = getByIdStmt.get(executionId);
    if (!row) return null;

    updateRatingStmt.run(rating, notes ?? null, executionId);

    const updated = getByIdStmt.get(executionId);
    if (!updated) return null;

    broadcast({ type: 'skill:execution-rated', execution: rowToExecution(updated) });
    return rowToExecution(updated);
  }

  function getExecution(id: string): SkillExecution | null {
    const row = getByIdStmt.get(id);
    return row ? rowToExecution(row) : null;
  }

  function getExecutionHistory(skillName: string, limit = 20): SkillExecution[] {
    const rows = getHistoryStmt.all(skillName, limit);
    return rows.map(rowToExecution);
  }

  function getSkillMetrics(skillName: string): SkillMetrics {
    const rows = getAllForSkillStmt.all(skillName);

    if (rows.length === 0) {
      return {
        execution_count: 0,
        success_rate: 0,
        avg_duration_s: 0,
        avg_cost_usd: 0,
        total_cost_usd: 0,
        last_execution: null,
      };
    }

    const successCount = rows.filter((r) => r.outcome === 'success').length;
    const durations = rows.filter((r) => r.duration_s !== null).map((r) => r.duration_s as number);
    const costs = rows.filter((r) => r.estimated_cost_usd !== null).map((r) => r.estimated_cost_usd as number);

    return {
      execution_count: rows.length,
      success_rate: rows.length > 0 ? successCount / rows.length : 0,
      avg_duration_s: durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
      avg_cost_usd: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) / costs.length : 0,
      total_cost_usd: costs.reduce((a, b) => a + b, 0),
      last_execution: rowToExecution(rows[0]),
    };
  }

  return {
    createExecution,
    finalizeExecution,
    rateExecution,
    getExecution,
    getExecutionHistory,
    getSkillMetrics,
  };
}

export type SkillExecutionService = ReturnType<typeof createSkillExecutionService>;
