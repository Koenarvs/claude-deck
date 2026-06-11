import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import path from 'node:path';
import type {
  Project,
  CreateProjectInput,
  UpdateProjectInput,
  PermissionMode,
} from '../../src/shared/types';
import { broadcast } from '../ws';
import logger from '../logger';

interface ProjectRow {
  id: string;
  name: string;
  root_path: string;
  allowed_models: string;
  default_permission_mode: string;
  done_command: string | null;
  worktree_root: string | null;
  created_at: number;
  updated_at: number;
}

function rowToProject(r: ProjectRow): Project {
  return {
    id: r.id,
    name: r.name,
    root_path: r.root_path,
    allowed_models: r.allowed_models ? (JSON.parse(r.allowed_models) as string[]) : [],
    default_permission_mode: r.default_permission_mode as PermissionMode,
    done_command: r.done_command,
    worktree_root: r.worktree_root,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/**
 * Normalizes a filesystem path for containment checks: resolves `.`/`..`,
 * unifies separators to `/`, lowercases the Windows drive letter, strips a
 * trailing slash.
 */
function normalizePath(p: string): string {
  const resolved = path.resolve(p).replace(/\\/g, '/');
  const lower = resolved.replace(/^([a-zA-Z]):/, (_m, d: string) => `${d.toLowerCase()}:`);
  return lower.replace(/\/+$/, '');
}

/**
 * True iff `cwd` is the same as, or nested under, `root`. Uses path-segment
 * containment (so `/a/claude-deck-evil` is NOT under `/a/claude-deck`).
 */
function isUnder(root: string, cwd: string): boolean {
  const r = normalizePath(root);
  const c = normalizePath(cwd);
  if (c === r) return true;
  return c.startsWith(r + '/');
}

/** Pure allow-list check against an already-loaded project list. Fail-closed on empty. */
export function isPathAllowedAgainst(projects: Project[], cwd: string): boolean {
  return projects.some((p) => isUnder(p.root_path, cwd));
}

export class ProjectNotFoundError extends Error {
  constructor(public readonly projectId: string) {
    super(`Project not found: ${projectId}`);
    this.name = 'ProjectNotFoundError';
  }
}
export class DuplicateProjectRootError extends Error {
  constructor(public readonly rootPath: string) {
    super(`A project is already registered at ${rootPath}`);
    this.name = 'DuplicateProjectRootError';
  }
}

/**
 * Project registry service. CRUD over the `projects` table plus the
 * `isPathAllowed` allow-list helper that path-containment guards consume.
 */
export function createProjectService(db: Database.Database) {
  const insertStmt = db.prepare<
    [string, string, string, string, string, string | null, string | null, number, number]
  >(
    `INSERT INTO projects (id, name, root_path, allowed_models, default_permission_mode, done_command, worktree_root, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const getByIdStmt = db.prepare<[string], ProjectRow>('SELECT * FROM projects WHERE id = ?');
  const listStmt = db.prepare<[], ProjectRow>(
    'SELECT * FROM projects ORDER BY name COLLATE NOCASE ASC',
  );
  const findByRootStmt = db.prepare<[string], ProjectRow>(
    'SELECT * FROM projects WHERE root_path = ?',
  );

  function get(id: string): Project | null {
    const row = getByIdStmt.get(id);
    return row ? rowToProject(row) : null;
  }

  function list(): Project[] {
    return listStmt.all().map(rowToProject);
  }

  function create(input: CreateProjectInput): Project {
    const root = normalizePath(input.root_path);
    if (findByRootStmt.get(root)) throw new DuplicateProjectRootError(root);
    const id = uuidv4();
    const now = Date.now();
    insertStmt.run(
      id,
      input.name,
      root,
      JSON.stringify(input.allowed_models ?? []),
      input.default_permission_mode ?? 'supervised',
      input.done_command ?? null,
      input.worktree_root ?? null,
      now,
      now,
    );
    const p = get(id);
    if (!p) throw new Error(`Project vanished after insert (id=${id})`);
    broadcast({ type: 'project:updated', project: p });
    logger.info({ projectId: id, root: p.root_path }, 'Project registered');
    return p;
  }

  function update(id: string, patch: UpdateProjectInput): Project {
    if (!get(id)) throw new ProjectNotFoundError(id);
    const sets: string[] = ['updated_at = ?'];
    const params: (string | number | null)[] = [Date.now()];
    if (patch.name !== undefined) {
      sets.push('name = ?');
      params.push(patch.name);
    }
    if (patch.allowed_models !== undefined) {
      sets.push('allowed_models = ?');
      params.push(JSON.stringify(patch.allowed_models));
    }
    if (patch.default_permission_mode !== undefined) {
      sets.push('default_permission_mode = ?');
      params.push(patch.default_permission_mode);
    }
    if (patch.done_command !== undefined) {
      sets.push('done_command = ?');
      params.push(patch.done_command);
    }
    if (patch.worktree_root !== undefined) {
      sets.push('worktree_root = ?');
      params.push(patch.worktree_root);
    }
    params.push(id);
    db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    const updated = get(id);
    if (!updated) throw new Error(`Project vanished after update (id=${id})`);
    broadcast({ type: 'project:updated', project: updated });
    return updated;
  }

  function remove(id: string): void {
    if (!get(id)) throw new ProjectNotFoundError(id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    broadcast({ type: 'project:removed', id });
    logger.info({ projectId: id }, 'Project removed');
  }

  /** Allow-list check. True iff cwd is under some registered root. Fail-closed on empty registry. */
  function isPathAllowed(cwd: string): boolean {
    return isPathAllowedAgainst(list(), cwd);
  }

  /** Returns the project whose root contains cwd, or null. (For default inheritance.) */
  function findByCwd(cwd: string): Project | null {
    return list().find((p) => isUnder(p.root_path, cwd)) ?? null;
  }

  return { get, list, create, update, remove, isPathAllowed, findByCwd };
}

export type ProjectService = ReturnType<typeof createProjectService>;
