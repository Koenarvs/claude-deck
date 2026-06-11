import type Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectService } from './project-service';
import logger from '../logger';

export interface GoalWorkspace {
  goal_id: string;
  branch: string;
  worktree_path: string;
  base_ref: string;
  mode: 'worktree' | 'branch';
  created_at: number;
}

interface GoalRow {
  id: string;
  cwd: string;
  title: string;
  project_id: string | null;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

/** Best-effort: register a path as safe.directory to dodge the Windows NTFS dubious-ownership fatal. */
function markSafe(absPath: string): void {
  try {
    execFileSync('git', ['config', '--global', '--add', 'safe.directory', absPath.replace(/\\/g, '/')]);
  } catch (err) {
    logger.warn({ err, absPath }, 'workspace: safe.directory mark failed');
  }
}

/** 'goal/<8charid>-<slug>' — filesystem + git-ref safe. */
function branchName(goalId: string, title: string): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 24) || 'work';
  return `goal/${goalId.slice(0, 8)}-${slug}`;
}

/** Default worktree dir (sibling to repo when project.worktree_root is unset). */
function defaultWorktreeRoot(repoRoot: string): string {
  return path.join(path.dirname(repoRoot), `.${path.basename(repoRoot)}-worktrees`);
}

export function createWorkspaceService(db: Database.Database, projectService: ProjectService) {
  const getWsStmt = db.prepare<[string], GoalWorkspace>(
    'SELECT * FROM goal_workspace WHERE goal_id = ?',
  );
  const insertWsStmt = db.prepare<[string, string, string, string, string, number]>(
    `INSERT INTO goal_workspace (goal_id, branch, worktree_path, base_ref, mode, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const getGoalStmt = db.prepare<[string], GoalRow>(
    'SELECT id, cwd, title, project_id FROM goals WHERE id = ?',
  );

  function get(goalId: string): GoalWorkspace | null {
    return getWsStmt.get(goalId) ?? null;
  }

  function projectFor(goal: GoalRow) {
    return goal.project_id ? projectService.get(goal.project_id) : projectService.findByCwd(goal.cwd);
  }

  /** Current branch of a repo, used as base_ref for diffs. */
  function currentBranch(repoRoot: string): string {
    try {
      return git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() || 'HEAD';
    } catch {
      return 'HEAD';
    }
  }

  /**
   * Provisions (or returns existing) an isolated workspace for the goal.
   * Returns null if the goal has no registered project (nothing to isolate —
   * the session runs in-place, matching the gradual-adoption decision).
   */
  function provision(goalId: string): GoalWorkspace | null {
    const existing = get(goalId);
    if (existing) return existing;

    const goal = getGoalStmt.get(goalId);
    if (!goal) throw new Error(`Goal not found: ${goalId}`);

    const project = projectFor(goal);
    if (!project) {
      logger.info({ goalId }, 'workspace: no registered project — running in-place, no isolation');
      return null;
    }

    const repoRoot = project.root_path;
    markSafe(repoRoot);
    const base = currentBranch(repoRoot);
    const branch = branchName(goalId, goal.title);
    const wtRoot = project.worktree_root ?? defaultWorktreeRoot(repoRoot);
    fs.mkdirSync(wtRoot, { recursive: true });
    const worktreePath = path.join(wtRoot, goalId.slice(0, 8));

    let mode: 'worktree' | 'branch' = 'worktree';
    try {
      // `git worktree add -b <branch> <path> <base>` — args array avoids Windows quoting.
      git(repoRoot, ['worktree', 'add', '-b', branch, worktreePath, base]);
      markSafe(worktreePath);
    } catch (err) {
      // Fallback: branch-in-place (worktrees disabled, or path collision).
      logger.warn({ err, goalId }, 'workspace: worktree add failed — falling back to branch-in-place');
      mode = 'branch';
      try {
        git(repoRoot, ['branch', branch, base]);
      } catch {
        /* branch may already exist */
      }
    }

    const record: GoalWorkspace = {
      goal_id: goalId,
      branch,
      worktree_path: mode === 'worktree' ? worktreePath : repoRoot,
      base_ref: base,
      mode,
      created_at: Date.now(),
    };
    insertWsStmt.run(
      record.goal_id,
      record.branch,
      record.worktree_path,
      record.base_ref,
      record.mode,
      record.created_at,
    );
    logger.info({ goalId, branch, mode, path: record.worktree_path }, 'workspace: provisioned');
    return record;
  }

  /** Removes the worktree + DB record for a goal. Best-effort cleanup on archive/complete. */
  function teardown(goalId: string): void {
    const ws = get(goalId);
    if (!ws) return;
    const goal = getGoalStmt.get(goalId);
    const project = goal ? projectFor(goal) : null;
    if (project && ws.mode === 'worktree') {
      try {
        git(project.root_path, ['worktree', 'remove', '--force', ws.worktree_path]);
      } catch (err) {
        logger.warn({ err, goalId }, 'workspace: worktree remove failed');
      }
    }
    db.prepare('DELETE FROM goal_workspace WHERE goal_id = ?').run(goalId);
  }

  return { get, provision, teardown };
}

export type WorkspaceService = ReturnType<typeof createWorkspaceService>;
