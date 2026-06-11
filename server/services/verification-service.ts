import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { spawn } from 'node:child_process';
import type {
  Goal,
  VerificationResult,
  VerificationStatus,
  ModelScorecardRow,
} from '../../src/shared/types';
import { broadcast } from '../ws';
import logger from '../logger';

const MAX_OUTPUT_CHARS = 16_000;

/** Injected resolvers so 5A (Project Registry) and 5B (worktree) supply real values. */
export interface VerificationDeps {
  /** The doneCommand for the goal, or null when none is configured (→ 'skipped'). */
  resolveDoneCommand: (goal: Goal) => string | null;
  /** The directory to run the command in (worktree when present, else goal.cwd). */
  resolveWorkspace: (goal: Goal) => string;
}

export interface RecordInput {
  goal_id: string;
  session_id: string | null;
  status: VerificationStatus;
  command: string | null;
  workspace: string | null;
  exit_code: number | null;
  output: string | null;
  duration_ms: number | null;
  model: string | null;
}

interface VerificationRow {
  id: string;
  goal_id: string;
  session_id: string | null;
  status: string;
  command: string | null;
  workspace: string | null;
  exit_code: number | null;
  output: string | null;
  duration_ms: number | null;
  model: string | null;
  created_at: number;
}

function rowToResult(row: VerificationRow): VerificationResult {
  return {
    id: row.id,
    goal_id: row.goal_id,
    session_id: row.session_id,
    status: row.status as VerificationStatus,
    command: row.command,
    workspace: row.workspace,
    exit_code: row.exit_code,
    output: row.output,
    duration_ms: row.duration_ms,
    model: row.model,
    created_at: row.created_at,
  };
}

export function createVerificationService(db: Database.Database, deps: VerificationDeps) {
  const insertStmt = db.prepare<
    [string, string, string | null, string, string | null, string | null, number | null, string | null, number | null, string | null, number]
  >(`INSERT INTO verification_results
     (id, goal_id, session_id, status, command, workspace, exit_code, output, duration_ms, model, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const latestStmt = db.prepare<[string], VerificationRow>(
    'SELECT * FROM verification_results WHERE goal_id = ? ORDER BY created_at DESC LIMIT 1',
  );

  function record(input: RecordInput): VerificationResult {
    const id = uuidv4();
    const now = Date.now();
    const output = input.output != null ? input.output.slice(0, MAX_OUTPUT_CHARS) : null;
    insertStmt.run(
      id,
      input.goal_id,
      input.session_id,
      input.status,
      input.command,
      input.workspace,
      input.exit_code,
      output,
      input.duration_ms,
      input.model,
      now,
    );
    const result: VerificationResult = {
      id,
      goal_id: input.goal_id,
      session_id: input.session_id,
      status: input.status,
      command: input.command,
      workspace: input.workspace,
      exit_code: input.exit_code,
      output,
      duration_ms: input.duration_ms,
      model: input.model,
      created_at: now,
    };
    broadcast({ type: 'verification:updated', goal_id: input.goal_id, result });
    return result;
  }

  function latestForGoal(goalId: string): VerificationResult | null {
    const row = latestStmt.get(goalId);
    return row ? rowToResult(row) : null;
  }

  function modelScorecard(): ModelScorecardRow[] {
    const rows = db
      .prepare(`
        SELECT COALESCE(model, 'unknown') as model,
          SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) as pass,
          SUM(CASE WHEN status = 'fail' THEN 1 ELSE 0 END) as fail,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error
        FROM verification_results
        WHERE status IN ('pass', 'fail', 'error')
        GROUP BY COALESCE(model, 'unknown')
        ORDER BY model
      `)
      .all() as Array<{ model: string; pass: number; fail: number; error: number }>;
    return rows.map((r) => {
      const total = r.pass + r.fail + r.error;
      return {
        model: r.model,
        total,
        pass: r.pass,
        fail: r.fail,
        error: r.error,
        passRate: total > 0 ? r.pass / total : 0,
      };
    });
  }

  /**
   * Resolves the goal's doneCommand + workspace, runs it, and records the outcome.
   * No doneCommand → 'skipped'. Spawn failure/timeout → 'error'. Exit 0 → 'pass', else 'fail'.
   */
  function runForGoal(goal: Goal, sessionId: string | null): Promise<VerificationResult> {
    const command = deps.resolveDoneCommand(goal);
    const workspace = deps.resolveWorkspace(goal);
    const model = goal.model ?? null;

    if (!command || command.trim() === '') {
      logger.info({ goalId: goal.id }, 'Verification skipped — no doneCommand');
      return Promise.resolve(
        record({
          goal_id: goal.id,
          session_id: sessionId,
          status: 'skipped',
          command: null,
          workspace,
          exit_code: null,
          output: null,
          duration_ms: null,
          model,
        }),
      );
    }

    const startedAt = Date.now();
    return new Promise<VerificationResult>((resolve) => {
      let stdout = '';
      let settled = false;
      const finish = (status: VerificationStatus, exitCode: number | null, extra = '') => {
        if (settled) return;
        settled = true;
        resolve(
          record({
            goal_id: goal.id,
            session_id: sessionId,
            status,
            command,
            workspace,
            exit_code: exitCode,
            output: stdout + extra || null,
            duration_ms: Date.now() - startedAt,
            model,
          }),
        );
      };

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(command, { cwd: workspace, shell: true });
      } catch (err) {
        logger.error({ err, goalId: goal.id }, 'Verification spawn threw');
        finish('error', null, String(err));
        return;
      }

      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr?.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      child.on('error', (err) => {
        logger.error({ err, goalId: goal.id }, 'Verification process error');
        finish('error', null, String(err));
      });
      child.on('close', (code) => {
        finish(code === 0 ? 'pass' : 'fail', code);
      });

      // Hard timeout: 10 minutes, then kill and record 'error'.
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        finish('error', null, '\n[verification timed out after 600s]');
      }, 600_000);
      timer.unref();
    });
  }

  return { record, latestForGoal, modelScorecard, runForGoal };
}

export type VerificationService = ReturnType<typeof createVerificationService>;
