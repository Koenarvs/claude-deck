import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { Approval, ApprovalDecision } from '../src/shared/types';
import { broadcast } from './ws';
import logger from './logger';

/** The decision returned from an approval request. */
export interface Decision {
  decision: 'allow' | 'deny';
  reason?: string | undefined;
}

/** Deferred promise wrapper for async approval resolution. */
interface Deferred {
  resolve: (value: Decision) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Input for requesting an approval. */
export interface ApprovalRequest {
  session_id: string | null;
  goal_id: string | null;
  tool_name: string;
  tool_args: string;
}

/**
 * Manages the lifecycle of tool-use approvals.
 *
 * For supervised goals, `request()` inserts an approval row with status=pending,
 * broadcasts `approval:pending`, and returns a promise that resolves when the UI
 * calls `resolve()` or the timeout expires.
 *
 * For autonomous goals, `request()` immediately resolves with allow.
 */
export class ApprovalCoordinator {
  private pending: Map<string, Deferred> = new Map();
  private db: Database.Database;
  private timeoutMs: number;
  private onApprovalPending: ((approval: Approval) => void) | undefined;

  constructor(
    db: Database.Database,
    timeoutMs: number = 30 * 60 * 1000,
    onApprovalPending?: (approval: Approval) => void,
  ) {
    this.db = db;
    this.timeoutMs = timeoutMs;
    this.onApprovalPending = onApprovalPending;
  }

  /**
   * Requests approval for a tool use.
   * Inserts an approval row, broadcasts the pending event, and returns a promise
   * that resolves when the UI decides or the timeout expires.
   *
   * @param req - The approval request details
   * @param isAutonomous - If true, immediately auto-approves without waiting
   * @returns A promise that resolves with the decision
   */
  async request(req: ApprovalRequest, isAutonomous: boolean): Promise<Decision> {
    const id = uuidv4();
    const now = Date.now();

    logger.info({
      approvalId: id,
      toolName: req.tool_name,
      sessionId: req.session_id,
      goalId: req.goal_id,
      isAutonomous,
    }, 'Approval requested');

    const approval: Approval = {
      id,
      session_id: req.session_id,
      goal_id: req.goal_id,
      tool_name: req.tool_name,
      tool_args: req.tool_args,
      status: 'pending',
      decided_reason: null,
      requested_at: now,
      resolved_at: null,
    };

    // Insert approval row
    this.db
      .prepare(
        `INSERT INTO approvals (id, session_id, goal_id, tool_name, tool_args, status, decided_reason, requested_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        approval.id,
        approval.session_id,
        approval.goal_id,
        approval.tool_name,
        approval.tool_args,
        approval.status,
        approval.decided_reason,
        approval.requested_at,
        approval.resolved_at,
      );

    // Broadcast pending event
    broadcast({
      type: 'approval:pending',
      approval,
      goal_id: req.goal_id,
    });

    // 5C/Phase 6: notify the orchestrator observer for supervised (blocking) approvals
    // so it can wake and produce a recommendation. Never for auto-approved requests.
    if (!isAutonomous && this.onApprovalPending) {
      try {
        this.onApprovalPending(approval);
      } catch (err) {
        logger.warn({ err }, 'onApprovalPending observer threw');
      }
    }

    // Autonomous mode: auto-approve immediately
    if (isAutonomous) {
      this.db
        .prepare(`UPDATE approvals SET status = 'approved', resolved_at = ? WHERE id = ?`)
        .run(Date.now(), id);

      broadcast({
        type: 'approval:resolved',
        id,
        decision: 'approved',
      });

      logger.debug({ id, tool_name: req.tool_name }, 'Auto-approved (autonomous mode)');
      return { decision: 'allow' };
    }

    // Supervised mode: create deferred and wait
    return new Promise<Decision>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);

          // Update row to timeout
          this.db
            .prepare(
              `UPDATE approvals SET status = 'timeout', decided_reason = 'timeout', resolved_at = ? WHERE id = ?`,
            )
            .run(Date.now(), id);

          broadcast({
            type: 'approval:resolved',
            id,
            decision: 'timeout',
          });

          logger.info({ id, tool_name: req.tool_name }, 'Approval timed out');
          resolve({ decision: 'deny', reason: 'timeout' });
        }
      }, this.timeoutMs);

      this.pending.set(id, { resolve, timer });
    });
  }

  /**
   * Resolves a pending approval with the given decision.
   * Called by the UI via the approvals API.
   *
   * @param approvalId - The ID of the approval to resolve
   * @param decision - The decision (approved or denied)
   * @param reason - Optional reason for the decision
   * @returns true if resolved, false if not found (stale/already resolved)
   */
  resolve(approvalId: string, decision: ApprovalDecision, reason?: string | undefined): boolean {
    const deferred = this.pending.get(approvalId);
    if (!deferred) {
      logger.debug({ approvalId }, 'Attempted to resolve non-pending approval (stale or duplicate)');
      return false;
    }

    // Cancel timeout
    clearTimeout(deferred.timer);
    this.pending.delete(approvalId);

    // Update DB row
    const status: string = decision;
    this.db
      .prepare(
        `UPDATE approvals SET status = ?, decided_reason = ?, resolved_at = ? WHERE id = ?`,
      )
      .run(status, reason ?? null, Date.now(), approvalId);

    // Broadcast resolution
    broadcast({
      type: 'approval:resolved',
      id: approvalId,
      decision,
    });

    // Map approval decision to hook decision
    const hookDecision: Decision =
      decision === 'approved'
        ? { decision: 'allow' }
        : { decision: 'deny', reason: reason ?? 'denied by user' };

    deferred.resolve(hookDecision);
    logger.info({ approvalId, decision, reason }, 'Approval resolved');
    return true;
  }

  /**
   * Returns the number of currently pending approvals.
   */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Cleans up all pending approvals (e.g., on server shutdown).
   * Resolves all with deny/shutdown and clears timers.
   */
  shutdown(): void {
    for (const [id, deferred] of this.pending) {
      clearTimeout(deferred.timer);
      deferred.resolve({ decision: 'deny', reason: 'server shutdown' });
      this.db
        .prepare(
          `UPDATE approvals SET status = 'denied', decided_reason = 'server shutdown', resolved_at = ? WHERE id = ?`,
        )
        .run(Date.now(), id);
    }
    this.pending.clear();
    logger.info('ApprovalCoordinator shut down, all pending approvals denied');
  }
}
