import type Database from 'better-sqlite3';

export interface SnapshotGoal {
  id: string;
  title: string;
  status: string;
}
export interface SnapshotSession {
  id: string;
  goal_id: string | null;
}
export interface SnapshotApproval {
  id: string;
  tool_name: string;
  goal_id: string | null;
  requested_at: number;
}

export interface BoardSnapshot {
  activeGoals: SnapshotGoal[];
  liveSessions: SnapshotSession[];
  pendingApprovals: SnapshotApproval[];
  toMarkdown(): string;
}

/**
 * Reads a live snapshot of the board from existing tables. Pure read — never mutates.
 * "Active" goals exclude complete/archived. "Live" sessions have ended_at IS NULL.
 */
export function buildSnapshot(db: Database.Database): BoardSnapshot {
  const activeGoals = db
    .prepare(
      `SELECT id, title, status FROM goals WHERE status NOT IN ('complete','archived') ORDER BY updated_at DESC LIMIT 30`,
    )
    .all() as SnapshotGoal[];
  const liveSessions = db
    .prepare(`SELECT id, goal_id FROM sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 30`)
    .all() as SnapshotSession[];
  const pendingApprovals = db
    .prepare(
      `SELECT id, tool_name, goal_id, requested_at FROM approvals WHERE status = 'pending' ORDER BY requested_at ASC LIMIT 30`,
    )
    .all() as SnapshotApproval[];

  return {
    activeGoals,
    liveSessions,
    pendingApprovals,
    toMarkdown(): string {
      const goals = activeGoals.length
        ? activeGoals.map((g) => `- [${g.status}] ${g.title} (${g.id})`).join('\n')
        : '- (none)';
      const sessions = liveSessions.length
        ? liveSessions.map((s) => `- session ${s.id}${s.goal_id ? ` → goal ${s.goal_id}` : ''}`).join('\n')
        : '- (none)';
      const approvals = pendingApprovals.length
        ? pendingApprovals.map((a) => `- ${a.tool_name}${a.goal_id ? ` (goal ${a.goal_id})` : ''} [${a.id}]`).join('\n')
        : '- (none)';
      return `### Active goals\n${goals}\n\n### Live sessions\n${sessions}\n\n### Pending approvals\n${approvals}`;
    },
  };
}
