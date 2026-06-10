# Phase 5 (infra half) — Workspace Safety for Autonomous Multi-Agent Work

> **Plan author:** robustness-infra subsystem. Follows `superpowers:writing-plans` — bite-sized TDD tasks, exact paths, real code in every step, commit per task, Self-Review at the end. Read the spec preamble before executing; then execute tasks top-to-bottom.

---

## Spec preamble

This plan implements three of the Phase 5 robustness features from `docs/superpowers/plans/2026-06-09-master-roadmap.md` (§Phase 5, items 5A/5B/5D + the cross-cutting decisions in §2):

- **5A — Project Registry.** A `projects` table (migration **021**) registering known repos with per-project defaults (`allowedModels`, `defaultPermissionMode`, `doneCommand`, `worktreeRoot`). A `ProjectService` (factory `createProjectService(db)`, Zod-validated) with REST CRUD under `/api/projects`. The registry **doubles as the `cwd` allow-list** that the Phase 0B security fix consumes — it exposes `isPathAllowed(cwd)`. Goal creation gains an optional `projectId`, and a goal's `cwd` must be contained within some registered project root.
- **5B — Workspace isolation + diff review.** A `goal_workspace` table (migration **022**) holding `goal_id, branch, worktree_path, base_ref, mode`. On goal spawn the server provisions a git worktree (or a plain branch when worktrees are unavailable) under the project's `worktreeRoot`; `PtyManager` runs the session in that workspace `cwd`. The `KanbanCard` surfaces branch + dirty-state. `GET /api/goals/:id/diff` returns the git diff vs `base_ref`; a Diff view renders in Goal Detail. Optional `POST /api/goals/:id/pr` creates a PR (via `gh` if present, else push + return a compare URL). Handles Windows path quoting and the `safe.directory` worktree gotcha documented in `ORCHESTRATION-STATUS.md`.
- **5D — Session survivability across server restarts.** On `SIGINT`/`SIGTERM`, a graceful drain persists enough state (`goal_id` + provider `sessionId` + workspace) to resume. On boot, an orphan-reconciliation pass detects sessions marked active with no live process and resumes them via `adapter.buildResumeArgs(sessionId, ctx)` (skipping providers whose `capabilities.canResume === false`). We do **not** attempt PTY reattach — resume-on-boot is the target.

### Locked contracts this plan consumes (from Phase 1 + Phase 0B)

These come from upstream phases and are treated as **given interfaces** — this plan codes against them and provides safe fallbacks where they may not yet be merged:

- **`SpawnContext`** (already in `src/shared/agents/types.ts`): `{ goalId, model, cwd, permissionMode, mcpServer }`.
- **`AgentAdapter`** (Phase 1): `PtyManager` takes an adapter; adapter exposes `buildResumeArgs(sessionId, ctx: SpawnContext): string[]` and `readonly capabilities: { canResume: boolean; ... }`. **Phase 1 is a prerequisite of 5D's adapter-driven resume.** Where Phase 1 has not landed, 5D falls back to the existing Claude `['--resume', sessionId]` path (see Task 14 fallback seam) so this plan is independently testable and does not block on the adapter merge.
- **Phase 0B** consumes `ProjectService.isPathAllowed(cwd: string): boolean`. **Coordinated helper name: `isPathAllowed`** (instance method on the object returned by `createProjectService(db)`, and re-exported as a free function `isPathAllowedAgainst(projects, cwd)` for the auth middleware to call without a service handle). 0B imports the service; this plan owns the implementation.

### Conventions observed (from existing code)

- Services use the **factory `create<Name>Service(db)`** pattern returning a closure object (see `server/services/goal-service.ts`), OR the **class** pattern (see `scheduled-task-service.ts`). New services here use the **factory** form to match `goal-service`.
- Migrations are plain `.sql` files in `server/db/migrations/NNN_name.sql`, applied lexically by `server/db/migrate.ts`, tracked in `schema_migrations`. Use `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`.
- Routers are factories `create<Name>Router(...deps): Router`, mounted under `/api` in `server/index.ts` via the `apiRouters` array passed to `createApp`. Body validation via `validateBody(schema)` from `server/middleware/validate.ts`.
- Zod schemas live in `src/shared/schemas.ts`; shared types in `src/shared/types.ts`.
- Tests: server tests in `tests/server/**` (node env), client tests in `tests/client/**` (jsdom). DB tests use `new Database(':memory:')` + `runMigrations(db)`. Git tests use a **temp repo fixture** (helper in Task 0).
- Git is shelled out via `node:child_process` `execFileSync` (no `simple-git` dependency exists). Always pass args as an array (never string-concat into a shell) to sidestep Windows quoting; for paths that must appear in a single arg, do **not** wrap in quotes when using `execFileSync` (the args array is not shell-parsed).
- Windows `safe.directory` gotcha: worktrees on NTFS trigger `fatal: detected dubious ownership`. Each provisioned worktree path gets `git config --global --add safe.directory <abs-path>` immediately after creation (mirrors `ORCHESTRATION-STATUS.md` Blocker 1's fix, but scoped per-path rather than `'*'`).

### Migration numbers used

- **021** — `projects` table (5A) + `goals.project_id` column.
- **022** — `goal_workspace` table (5B) + `sessions.provider_session_id` and `sessions.workspace_path` columns (5D needs durable resume state).

> Note: the repo currently ships migrations `001`–`014`; numbers `015`–`020` are reserved by earlier-sequenced phases (015 app_config, 016 provider_config, 017–020 analytics/adapters per the master roadmap). This plan claims **021** and **022**. If, at execution time, a higher migration already exists, bump both numbers in lockstep (021→N, 022→N+1) and update every literal reference below.

### Dependency order within this plan

`0 (fixtures) → 1–4 (5A registry) → 5–10 (5B workspace+diff+PR+UI) → 11–15 (5D survivability) → 16 (final wiring + Self-Review)`. 5B Task 5 depends on 5A (worktreeRoot, project lookup). 5D Tasks 11–15 depend on 5B (workspace path persisted on the session row).

---

## Task 0 — Test fixtures: temp git repo + in-memory DB helpers

**Goal:** One reusable fixture for git-backed tests and one for migration-backed DB tests, so later tasks don't re-roll boilerplate.

**Files:**
- Create: `tests/server/helpers/git-fixture.ts`
- Create: `tests/server/helpers/db-fixture.ts`
- Test: `tests/server/helpers/git-fixture.test.ts`

**Step 1 — write the failing test** `tests/server/helpers/git-fixture.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRepo, cleanupTempRepo } from './git-fixture';

describe('makeTempRepo', () => {
  let repo: string | null = null;
  afterEach(() => { if (repo) { cleanupTempRepo(repo); repo = null; } });

  it('creates an initialized repo with one commit on a known branch', () => {
    repo = makeTempRepo();
    expect(fs.existsSync(path.join(repo, '.git'))).toBe(true);
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
    expect(branch).toBe('main');
    const log = execFileSync('git', ['log', '--oneline'], { cwd: repo, encoding: 'utf-8' }).trim();
    expect(log).toContain('init');
  });

  it('lets a caller add a tracked file and see it dirty', () => {
    repo = makeTempRepo();
    fs.writeFileSync(path.join(repo, 'new.txt'), 'hello');
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf-8' }).trim();
    expect(status).toContain('new.txt');
  });
});
```

**Step 2 — implement** `tests/server/helpers/git-fixture.ts`:

```ts
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Creates a throwaway git repo in the OS temp dir with one commit on branch `main`. Returns its absolute path. */
export function makeTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-git-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf-8' });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  // Avoid Windows dubious-ownership noise inside the fixture itself.
  try { execFileSync('git', ['config', '--global', '--add', 'safe.directory', dir]); } catch { /* best effort */ }
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  git(['add', '-A']);
  git(['commit', '-m', 'init']);
  return dir;
}

/** Removes a temp repo created by makeTempRepo. Best-effort; ignores errors. */
export function cleanupTempRepo(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
```

**Step 3 — implement** `tests/server/helpers/db-fixture.ts`:

```ts
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';

/** In-memory DB with all migrations applied, WAL + FKs on. Caller closes it. */
export function makeMigratedDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}
```

**Step 4 — run** `npm test -- git-fixture` → PASS (note: a git binary must be on PATH; the `dev` machine has one). **Commit:** `test(5): temp-repo + migrated-db fixtures for infra tests`.

**Self-review:** Are these helpers free of production imports beyond `migrate`? Yes — fixtures only. Do they leak temp dirs? `cleanupTempRepo` + `afterEach` guard.

---

## Task 1 — Migration 021: `projects` table + `goals.project_id`

**Goal:** Persist the registry and link goals to projects.

**Files:**
- Create: `server/db/migrations/021_projects.sql`
- Test: `tests/server/db/migration-021.test.ts`

**Step 1 — failing test** `tests/server/db/migration-021.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeMigratedDb } from '../helpers/db-fixture';
import type Database from 'better-sqlite3';

let db: Database.Database;
afterEach(() => db?.close());

describe('migration 021 — projects', () => {
  it('creates projects table with expected columns', () => {
    db = makeMigratedDb();
    const cols = (db.pragma('table_info(projects)') as Array<{ name: string }>).map((c) => c.name);
    for (const c of ['id', 'name', 'root_path', 'allowed_models', 'default_permission_mode', 'done_command', 'worktree_root', 'created_at', 'updated_at']) {
      expect(cols).toContain(c);
    }
  });

  it('adds project_id to goals', () => {
    db = makeMigratedDb();
    const cols = (db.pragma('table_info(goals)') as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('project_id');
  });

  it('enforces unique root_path', () => {
    db = makeMigratedDb();
    const ins = db.prepare(
      `INSERT INTO projects (id,name,root_path,allowed_models,default_permission_mode,done_command,worktree_root,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    ins.run('p1', 'A', 'C:/repo', '[]', 'supervised', null, null, 1, 1);
    expect(() => ins.run('p2', 'B', 'C:/repo', '[]', 'supervised', null, null, 1, 1)).toThrow();
  });
});
```

**Step 2 — implement** `server/db/migrations/021_projects.sql`:

```sql
-- 5A Project Registry: known repos with per-project defaults.
-- Doubles as the cwd allow-list consumed by the Phase 0B auth fix.
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,          -- absolute repo root; the allow-list anchor
  allowed_models TEXT NOT NULL DEFAULT '[]', -- JSON string[] of model ids; [] = any
  default_permission_mode TEXT NOT NULL DEFAULT 'supervised'
    CHECK (default_permission_mode IN ('autonomous', 'supervised')),
  done_command TEXT,                        -- e.g. 'npm run typecheck && npm test' (5C consumer)
  worktree_root TEXT,                       -- where 5B provisions worktrees; NULL = sibling dir
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_root ON projects (root_path);

-- Link goals to a registered project (nullable: legacy goals + ad-hoc cwds).
ALTER TABLE goals ADD COLUMN project_id TEXT REFERENCES projects(id);
```

> The `migrate.ts` runner applies files in lexical order and tracks versions; no runner change needed. Keep the `ALTER TABLE` idempotent risk in mind — `migrate.ts` only runs a file once (version-tracked), so a bare `ALTER` is safe here (unlike the hand-rolled fixups at the bottom of `migrate.ts`).

**Step 3 — run** `npm test -- migration-021` → PASS. **Commit:** `feat(5A): migration 021 — projects table + goals.project_id`.

**Self-review:** Unique constraint on `root_path` prevents two registry entries claiming the same repo (ambiguous allow-list). `project_id` nullable so existing goals migrate cleanly.

---

## Task 2 — `ProjectService` (factory, Zod-validated) with `isPathAllowed`

**Goal:** CRUD + the allow-list helper Phase 0B depends on. **This is the security-load-bearing task** — `isPathAllowed` must reject path-escape attempts.

**Files:**
- Create: `server/services/project-service.ts`
- Add schemas to: `src/shared/schemas.ts`
- Add types to: `src/shared/types.ts`
- Test: `tests/server/services/project-service.test.ts`

**Step 1 — add types** to `src/shared/types.ts` (append in a new `// ── Project ──` section):

```ts
// ── Project Registry ─────────────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  root_path: string;
  allowed_models: string[];
  default_permission_mode: PermissionMode;
  done_command: string | null;
  worktree_root: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateProjectInput {
  name: string;
  root_path: string;
  allowed_models?: string[] | undefined;
  default_permission_mode?: PermissionMode | undefined;
  done_command?: string | null | undefined;
  worktree_root?: string | null | undefined;
}

export interface UpdateProjectInput {
  name?: string | undefined;
  allowed_models?: string[] | undefined;
  default_permission_mode?: PermissionMode | undefined;
  done_command?: string | null | undefined;
  worktree_root?: string | null | undefined;
}
```

Also extend `CreateGoalInput` with the optional link:

```ts
// in CreateGoalInput:
  projectId?: string | undefined;
```

**Step 2 — add schemas** to `src/shared/schemas.ts`:

```ts
// ── Project ───────────────────────────────────────────────────────────────────

export const CreateProjectInputSchema = z.object({
  name: z.string().min(1),
  root_path: z.string().min(1),
  allowed_models: z.array(z.string()).optional(),
  default_permission_mode: PermissionModeSchema.optional(),
  done_command: z.string().nullable().optional(),
  worktree_root: z.string().nullable().optional(),
});

export const UpdateProjectInputSchema = z.object({
  name: z.string().min(1).optional(),
  allowed_models: z.array(z.string()).optional(),
  default_permission_mode: PermissionModeSchema.optional(),
  done_command: z.string().nullable().optional(),
  worktree_root: z.string().nullable().optional(),
});
```

And add `projectId` to `CreateGoalInputSchema`:

```ts
  projectId: z.string().optional(),
```

**Step 3 — failing test** `tests/server/services/project-service.test.ts` (key cases):

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeMigratedDb } from '../helpers/db-fixture';
import { createProjectService, isPathAllowedAgainst } from '../../../server/services/project-service';
import type Database from 'better-sqlite3';

vi.mock('../../../server/ws', () => ({ broadcast: vi.fn() }));
vi.mock('../../../server/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

let db: Database.Database;
beforeEach(() => { db = makeMigratedDb(); });
afterEach(() => db.close());

describe('ProjectService CRUD', () => {
  it('creates and reads a project with defaults applied', () => {
    const svc = createProjectService(db);
    const p = svc.create({ name: 'Deck', root_path: 'C:/github/claude-deck' });
    expect(p.id).toBeTruthy();
    expect(p.allowed_models).toEqual([]);
    expect(p.default_permission_mode).toBe('supervised');
    expect(svc.get(p.id)?.root_path).toBe('C:/github/claude-deck');
  });

  it('rejects duplicate root_path', () => {
    const svc = createProjectService(db);
    svc.create({ name: 'A', root_path: 'C:/repo' });
    expect(() => svc.create({ name: 'B', root_path: 'C:/repo' })).toThrow();
  });
});

describe('isPathAllowed (allow-list)', () => {
  it('allows a cwd inside a registered root and rejects outside', () => {
    const svc = createProjectService(db);
    svc.create({ name: 'Deck', root_path: 'C:/github/claude-deck' });
    expect(svc.isPathAllowed('C:/github/claude-deck')).toBe(true);
    expect(svc.isPathAllowed('C:/github/claude-deck/server')).toBe(true);
    expect(svc.isPathAllowed('C:/github/other')).toBe(false);
  });

  it('rejects path-escape and prefix-collision attempts', () => {
    const svc = createProjectService(db);
    svc.create({ name: 'Deck', root_path: 'C:/github/claude-deck' });
    // prefix collision: claude-deck-evil is NOT inside claude-deck
    expect(svc.isPathAllowed('C:/github/claude-deck-evil')).toBe(false);
    // traversal back out
    expect(svc.isPathAllowed('C:/github/claude-deck/../other')).toBe(false);
    // backslash variant normalizes to the same root
    expect(svc.isPathAllowed('C:\\github\\claude-deck\\server')).toBe(true);
  });

  it('free function matches the method', () => {
    const svc = createProjectService(db);
    svc.create({ name: 'Deck', root_path: 'C:/github/claude-deck' });
    expect(isPathAllowedAgainst(svc.list(), 'C:/github/claude-deck/x')).toBe(true);
    expect(isPathAllowedAgainst(svc.list(), 'C:/elsewhere')).toBe(false);
  });

  it('empty registry denies everything (fail-closed)', () => {
    const svc = createProjectService(db);
    expect(svc.isPathAllowed('C:/anything')).toBe(false);
    expect(isPathAllowedAgainst([], 'C:/anything')).toBe(false);
  });
});
```

**Step 4 — implement** `server/services/project-service.ts`:

```ts
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import path from 'node:path';
import type { Project, CreateProjectInput, UpdateProjectInput, PermissionMode } from '../../src/shared/types';
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
 * unifies separators to `/`, lowercases the Windows drive letter, and strips
 * a trailing slash. Pure string normalization on top of path.resolve.
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

/**
 * Project registry service. CRUD over the `projects` table plus the
 * `isPathAllowed` allow-list helper consumed by the Phase 0B auth layer.
 */
export function createProjectService(db: Database.Database) {
  const insertStmt = db.prepare<[string, string, string, string, string, string | null, string | null, number, number]>(
    `INSERT INTO projects (id, name, root_path, allowed_models, default_permission_mode, done_command, worktree_root, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const getByIdStmt = db.prepare<[string], ProjectRow>('SELECT * FROM projects WHERE id = ?');
  const listStmt = db.prepare<[], ProjectRow>('SELECT * FROM projects ORDER BY name COLLATE NOCASE ASC');
  const findByRootStmt = db.prepare<[string], ProjectRow>('SELECT * FROM projects WHERE root_path = ?');

  function get(id: string): Project | null {
    const row = getByIdStmt.get(id);
    return row ? rowToProject(row) : null;
  }

  function list(): Project[] {
    return listStmt.all().map(rowToProject);
  }

  function create(input: CreateProjectInput): Project {
    const existing = findByRootStmt.get(normalizePathRaw(input.root_path));
    if (existing) throw new DuplicateProjectRootError(existing.root_path);
    const id = uuidv4();
    const now = Date.now();
    insertStmt.run(
      id,
      input.name,
      normalizePathRaw(input.root_path),
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
    const existing = get(id);
    if (!existing) throw new ProjectNotFoundError(id);
    const now = Date.now();
    const sets: string[] = ['updated_at = ?'];
    const params: (string | number | null)[] = [now];
    if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name); }
    if (patch.allowed_models !== undefined) { sets.push('allowed_models = ?'); params.push(JSON.stringify(patch.allowed_models)); }
    if (patch.default_permission_mode !== undefined) { sets.push('default_permission_mode = ?'); params.push(patch.default_permission_mode); }
    if (patch.done_command !== undefined) { sets.push('done_command = ?'); params.push(patch.done_command); }
    if (patch.worktree_root !== undefined) { sets.push('worktree_root = ?'); params.push(patch.worktree_root); }
    params.push(id);
    db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    const updated = get(id);
    if (!updated) throw new Error(`Project vanished after update (id=${id})`);
    broadcast({ type: 'project:updated', project: updated });
    return updated;
  }

  function remove(id: string): void {
    const existing = get(id);
    if (!existing) throw new ProjectNotFoundError(id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    broadcast({ type: 'project:removed', id });
    logger.info({ projectId: id }, 'Project removed');
  }

  /** Allow-list check consumed by Phase 0B. True iff cwd is under some registered root. */
  function isPathAllowed(cwd: string): boolean {
    return isPathAllowedAgainst(list(), cwd);
  }

  /** Returns the project whose root contains cwd, or null. (For default inheritance.) */
  function findByCwd(cwd: string): Project | null {
    return list().find((p) => isUnder(p.root_path, cwd)) ?? null;
  }

  return { get, list, create, update, remove, isPathAllowed, findByCwd };
}

/** Same normalization create/store uses, exported-free for callers that pre-normalize. */
function normalizePathRaw(p: string): string {
  return normalizePath(p);
}

export type ProjectService = ReturnType<typeof createProjectService>;

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
```

> `broadcast({ type: 'project:updated' | 'project:removed' })` — add these event schemas in Task 4 alongside the router (the `broadcast` typing will fail to compile until then; that is the next task's red→green, so write Task 4's event schemas in the same red phase if the compiler blocks the test run — see Task 4 note).

**Step 5 — run** `npm test -- project-service` → PASS. **Commit:** `feat(5A): ProjectService with isPathAllowed allow-list helper`.

**Self-review:** The allow-list is **fail-closed** (empty registry denies all). Containment uses `path.resolve` (collapses `..`) + segment boundary check (`root + '/'`) so `claude-deck-evil` and `../other` both fail. Windows drive-letter case is normalized. This directly satisfies the Phase 0B coordination contract. ⚠️ Verify the broadcast event types compile by sequencing Task 4's schema additions first if needed.

---

## Task 3 — Wire `project_id` + default inheritance into goal creation

**Goal:** A goal created with `projectId` (or whose `cwd` falls inside a registered project) stores `project_id` and inherits `defaultPermissionMode` / model gating. **A goal whose `cwd` is not under any registered project is allowed for now (registry adoption is gradual) but logged** — the hard `cwd` containment enforcement is Phase 0B's job, which calls `isPathAllowed`.

**Files:**
- Modify: `server/services/goal-service.ts` (accept `projectId`, persist it, inherit defaults)
- Modify: `server/db` insert column list in `goal-service.ts`
- Test: `tests/server/services/goal-service-project.test.ts`

**Step 1 — failing test** `tests/server/services/goal-service-project.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeMigratedDb } from '../helpers/db-fixture';
import { createGoalService } from '../../../server/services/goal-service';
import { createProjectService } from '../../../server/services/project-service';
import type Database from 'better-sqlite3';

vi.mock('../../../server/ws', () => ({ broadcast: vi.fn() }));
vi.mock('../../../server/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

let db: Database.Database;
beforeEach(() => { db = makeMigratedDb(); });
afterEach(() => db.close());

it('stores project_id and inherits default permission mode from the project', () => {
  const projects = createProjectService(db);
  const goals = createGoalService(db);
  const p = projects.create({ name: 'Deck', root_path: 'C:/github/claude-deck', default_permission_mode: 'autonomous' });
  const g = goals.create({ title: 'Task A', cwd: 'C:/github/claude-deck/server', projectId: p.id });
  const row = db.prepare('SELECT project_id, permission_mode FROM goals WHERE id = ?').get(g.id) as { project_id: string; permission_mode: string };
  expect(row.project_id).toBe(p.id);
  expect(row.permission_mode).toBe('autonomous');
});

it('auto-links project by cwd when projectId is omitted', () => {
  const projects = createProjectService(db);
  const goals = createGoalService(db);
  const p = projects.create({ name: 'Deck', root_path: 'C:/github/claude-deck' });
  const g = goals.create({ title: 'Task B', cwd: 'C:/github/claude-deck/src' });
  const row = db.prepare('SELECT project_id FROM goals WHERE id = ?').get(g.id) as { project_id: string | null };
  expect(row.project_id).toBe(p.id);
});

it('leaves project_id null for an unregistered cwd', () => {
  const goals = createGoalService(db);
  const g = goals.create({ title: 'Ad hoc', cwd: 'C:/tmp/scratch' });
  const row = db.prepare('SELECT project_id FROM goals WHERE id = ?').get(g.id) as { project_id: string | null };
  expect(row.project_id).toBeNull();
});
```

**Step 2 — implement.** In `goal-service.ts`:

1. Add an optional `projectService` parameter so goal-service can resolve defaults without a hard import cycle:

```ts
import type { ProjectService } from './project-service';

export function createGoalService(db: Database.Database, projectService?: ProjectService) {
```

2. Extend the insert statement column list to include `project_id` (append `project_id` after `completed_at`'s slot — adjust the prepared statement's tuple + VALUES placeholders accordingly):

```ts
  const insertStmt = db.prepare<
    [string, string, string | null, string, string, number, string | null, string | null, string, string | null, string | null, number, number, number, number | null, string | null]
  >(`INSERT INTO goals (id, title, description, cwd, status, priority, tags, current_session_id, permission_mode, model, initial_prompt, kanban_order, created_at, updated_at, completed_at, project_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
```

3. In `create()`, resolve the project + defaults before the insert:

```ts
    // Resolve project link: explicit projectId wins; else infer from cwd.
    let projectId: string | null = input.projectId ?? null;
    let permissionMode = input.permission_mode;
    if (projectService) {
      const project = projectId ? projectService.get(projectId) : projectService.findByCwd(input.cwd);
      if (project) {
        projectId = project.id;
        if (permissionMode === undefined) permissionMode = project.default_permission_mode;
      } else if (input.projectId) {
        logger.warn({ projectId: input.projectId }, 'Goal references unknown project; storing null link');
        projectId = null;
      }
    }
```

   Then pass `permissionMode ?? 'supervised'` and `projectId` as the final two `insertStmt.run(...)` arguments (replacing the old `input.permission_mode ?? 'supervised'`).

4. Add `project_id` to `GoalRow` + `rowToGoal` (and to the `Goal` type in `types.ts`: `project_id: string | null;`).

**Step 3 — wire the dependency** in `server/index.ts` (the construction site — full wiring lands in Task 16, but make the param optional so existing callers/tests pass without it). No behavior change for callers that omit `projectService`.

**Step 4 — run** `npm test -- goal-service` (existing + new) → PASS. **Commit:** `feat(5A): goals link to projects + inherit defaults`.

**Self-review:** Backward compatible — `projectService` optional, `project_id` nullable. Existing `createGoalService(db)` callers in tests keep working. Default inheritance only fills *unset* fields (explicit input still wins).

---

## Task 4 — REST CRUD: `/api/projects` router + WS event schemas

**Goal:** Expose the registry over HTTP and define the `project:*` WS events used by Task 2.

**Files:**
- Create: `server/routes/projects.ts`
- Modify: `src/shared/events.ts` (+ `src/shared/schemas.ts` for `ProjectSchema`)
- Test: `tests/server/routes/projects.test.ts`

**Step 1 — add `ProjectSchema`** to `src/shared/schemas.ts`:

```ts
export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  root_path: z.string(),
  allowed_models: z.array(z.string()),
  default_permission_mode: PermissionModeSchema,
  done_command: z.string().nullable(),
  worktree_root: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});
```

**Step 2 — add WS events** to `src/shared/events.ts` (append to the event schema list and the discriminated union / `ServerEventSchema`):

```ts
import { ProjectSchema } from './schemas';

export const ProjectUpdatedEventSchema = z.object({
  type: z.literal('project:updated'),
  project: ProjectSchema,
});

export const ProjectRemovedEventSchema = z.object({
  type: z.literal('project:removed'),
  id: z.string(),
});
```

Add both to the union that defines `ServerEvent` (follow the existing pattern at the bottom of `events.ts` — locate the `z.union([...])` / `ServerEvent` export and append these two members).

**Step 3 — failing test** `tests/server/routes/projects.test.ts` (mirror `goals.test.ts` harness — express + ephemeral http server + `makeMigratedDb`):

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { makeMigratedDb } from '../helpers/db-fixture';
import { createProjectService } from '../../../server/services/project-service';
import { createProjectsRouter } from '../../../server/routes/projects';
import type Database from 'better-sqlite3';

vi.mock('../../../server/ws', () => ({ broadcast: vi.fn() }));
vi.mock('../../../server/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

let db: Database.Database; let server: http.Server; let port: number;
const url = (p: string) => `http://127.0.0.1:${port}/api${p}`;

beforeEach(async () => {
  db = makeMigratedDb();
  const app = express();
  app.use(express.json());
  app.use('/api', createProjectsRouter(createProjectService(db)));
  server = http.createServer(app);
  port = await new Promise<number>((r) => server.listen(0, () => { const a = server.address(); if (a && typeof a === 'object') r(a.port); }));
});
afterEach(() => { server.close(); db.close(); });

it('POST creates, GET lists, PATCH updates, DELETE removes', async () => {
  const created = await fetch(url('/projects'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Deck', root_path: 'C:/github/claude-deck' }) });
  expect(created.status).toBe(201);
  const p = await created.json() as { id: string };

  const listed = await (await fetch(url('/projects'))).json() as unknown[];
  expect(listed.length).toBe(1);

  const patched = await fetch(url(`/projects/${p.id}`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done_command: 'npm test' }) });
  expect((await patched.json() as { done_command: string }).done_command).toBe('npm test');

  const del = await fetch(url(`/projects/${p.id}`), { method: 'DELETE' });
  expect(del.status).toBe(200);
});

it('409 on duplicate root', async () => {
  const body = JSON.stringify({ name: 'A', root_path: 'C:/repo' });
  await fetch(url('/projects'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  const dup = await fetch(url('/projects'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'B', root_path: 'C:/repo' }) });
  expect(dup.status).toBe(409);
});
```

**Step 4 — implement** `server/routes/projects.ts`:

```ts
import { Router } from 'express';
import type { Request, Response } from 'express';
import { CreateProjectInputSchema, UpdateProjectInputSchema } from '../../src/shared/schemas';
import { validateBody } from '../middleware/validate';
import type { ProjectService } from '../services/project-service';
import { ProjectNotFoundError, DuplicateProjectRootError } from '../services/project-service';
import logger from '../logger';

/**
 * CRUD router for the project registry (5A).
 * - POST   /projects        create
 * - GET    /projects        list
 * - GET    /projects/:id    read
 * - PATCH  /projects/:id    update
 * - DELETE /projects/:id    remove
 */
export function createProjectsRouter(projectService: ProjectService): Router {
  const router = Router();

  router.post('/projects', validateBody(CreateProjectInputSchema), (req: Request, res: Response) => {
    try {
      res.status(201).json(projectService.create(req.body));
    } catch (err) {
      if (err instanceof DuplicateProjectRootError) { res.status(409).json({ error: err.message }); return; }
      logger.error({ err }, 'Failed to create project');
      res.status(500).json({ error: 'Failed to create project' });
    }
  });

  router.get('/projects', (_req: Request, res: Response) => {
    res.json(projectService.list());
  });

  router.get('/projects/:id', (req: Request, res: Response) => {
    const p = projectService.get(String(req.params['id']));
    if (!p) { res.status(404).json({ error: 'Project not found' }); return; }
    res.json(p);
  });

  router.patch('/projects/:id', validateBody(UpdateProjectInputSchema), (req: Request, res: Response) => {
    try {
      res.json(projectService.update(String(req.params['id']), req.body));
    } catch (err) {
      if (err instanceof ProjectNotFoundError) { res.status(404).json({ error: err.message }); return; }
      logger.error({ err }, 'Failed to update project');
      res.status(500).json({ error: 'Failed to update project' });
    }
  });

  router.delete('/projects/:id', (req: Request, res: Response) => {
    try {
      projectService.remove(String(req.params['id']));
      res.json({ removed: true });
    } catch (err) {
      if (err instanceof ProjectNotFoundError) { res.status(404).json({ error: err.message }); return; }
      logger.error({ err }, 'Failed to remove project');
      res.status(500).json({ error: 'Failed to remove project' });
    }
  });

  return router;
}
```

**Step 5 — run** `npm test -- projects` and `npm run typecheck` → PASS. **Commit:** `feat(5A): /api/projects CRUD router + project WS events`.

**Self-review:** 409 on duplicate root, 404 on missing, validated bodies. Events typed so Task 2's `broadcast(...)` now compiles. (Router mounting in `index.ts` is in Task 16 with the rest of the wiring.)

---

## Task 5 — Migration 022: `goal_workspace` + session resume columns

**Goal:** Persist per-goal workspace and the durable resume state 5D needs.

**Files:**
- Create: `server/db/migrations/022_goal_workspace.sql`
- Test: `tests/server/db/migration-022.test.ts`

**Step 1 — failing test** `tests/server/db/migration-022.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeMigratedDb } from '../helpers/db-fixture';
import type Database from 'better-sqlite3';

let db: Database.Database;
afterEach(() => db?.close());

describe('migration 022 — goal_workspace + resume columns', () => {
  it('creates goal_workspace with expected columns', () => {
    db = makeMigratedDb();
    const cols = (db.pragma('table_info(goal_workspace)') as Array<{ name: string }>).map((c) => c.name);
    for (const c of ['goal_id', 'branch', 'worktree_path', 'base_ref', 'mode', 'created_at']) {
      expect(cols).toContain(c);
    }
  });

  it('adds provider_session_id + workspace_path to sessions', () => {
    db = makeMigratedDb();
    const cols = (db.pragma('table_info(sessions)') as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('provider_session_id');
    expect(cols).toContain('workspace_path');
  });
});
```

**Step 2 — implement** `server/db/migrations/022_goal_workspace.sql`:

```sql
-- 5B Workspace isolation: one provisioned workspace per goal.
CREATE TABLE IF NOT EXISTS goal_workspace (
  goal_id TEXT PRIMARY KEY REFERENCES goals(id),
  branch TEXT NOT NULL,            -- e.g. 'goal/<short-id>-<slug>'
  worktree_path TEXT NOT NULL,     -- absolute path the PTY runs in
  base_ref TEXT NOT NULL,          -- ref the diff is computed against (e.g. 'main' or a SHA)
  mode TEXT NOT NULL DEFAULT 'worktree'
    CHECK (mode IN ('worktree', 'branch')),
  created_at INTEGER NOT NULL
);

-- 5D survivability: durable resume state on the session row.
ALTER TABLE sessions ADD COLUMN provider_session_id TEXT; -- provider's own resume id (Claude: == session id)
ALTER TABLE sessions ADD COLUMN workspace_path TEXT;      -- cwd to resume in across restarts
```

**Step 3 — run** `npm test -- migration-022` → PASS. **Commit:** `feat(5B/5D): migration 022 — goal_workspace + session resume columns`.

**Self-review:** `goal_workspace.goal_id` is PK (one workspace per goal). `mode` constrained. Resume columns are nullable so existing rows are unaffected.

---

## Task 6 — `WorkspaceService`: provision worktree-or-branch (Windows-safe)

**Goal:** Given a goal + its project, create an isolated git workspace and record it. Falls back from worktree to branch-in-place when worktrees aren't possible. Handles the `safe.directory` gotcha and Windows paths.

**Files:**
- Create: `server/services/workspace-service.ts`
- Test: `tests/server/services/workspace-service.test.ts` (uses `makeTempRepo`)

**Step 1 — failing test** `tests/server/services/workspace-service.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeMigratedDb } from '../helpers/db-fixture';
import { makeTempRepo, cleanupTempRepo } from '../helpers/git-fixture';
import { createProjectService } from '../../../server/services/project-service';
import { createGoalService } from '../../../server/services/goal-service';
import { createWorkspaceService } from '../../../server/services/workspace-service';
import type Database from 'better-sqlite3';

vi.mock('../../../server/ws', () => ({ broadcast: vi.fn() }));
vi.mock('../../../server/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

let db: Database.Database; let repo: string | null = null;
beforeEach(() => { db = makeMigratedDb(); });
afterEach(() => { db.close(); if (repo) { cleanupTempRepo(repo); repo = null; } });

it('provisions a worktree on a new branch under worktree_root', () => {
  repo = makeTempRepo();
  const wtRoot = path.join(repo, '..', `wt-${Date.now()}`);
  const projects = createProjectService(db);
  const goals = createGoalService(db, projects);
  const project = projects.create({ name: 'R', root_path: repo, worktree_root: wtRoot });
  const goal = goals.create({ title: 'Feature X', cwd: repo, projectId: project.id });

  const ws = createWorkspaceService(db, projects);
  const provisioned = ws.provision(goal.id);

  expect(provisioned.mode).toBe('worktree');
  expect(fs.existsSync(provisioned.worktree_path)).toBe(true);
  // It is a real worktree of the repo.
  const list = execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf-8' });
  expect(list).toContain(provisioned.worktree_path.replace(/\\/g, '/').split('/').pop()!);
  // Branch exists.
  const branches = execFileSync('git', ['branch', '--list', provisioned.branch], { cwd: repo, encoding: 'utf-8' });
  expect(branches).toContain(provisioned.branch);
  cleanupTempRepo(wtRoot);
});

it('is idempotent: provisioning twice returns the same workspace', () => {
  repo = makeTempRepo();
  const projects = createProjectService(db);
  const goals = createGoalService(db, projects);
  const project = projects.create({ name: 'R', root_path: repo });
  const goal = goals.create({ title: 'Y', cwd: repo, projectId: project.id });
  const ws = createWorkspaceService(db, projects);
  const a = ws.provision(goal.id);
  const b = ws.provision(goal.id);
  expect(b.worktree_path).toBe(a.worktree_path);
});

it('returns null workspace for a goal whose cwd is not in a registered project', () => {
  const goals = createGoalService(db);
  const goal = goals.create({ title: 'Z', cwd: 'C:/tmp/nope' });
  const ws = createWorkspaceService(db, createProjectService(db));
  expect(ws.provision(goal.id)).toBeNull();
});
```

**Step 2 — implement** `server/services/workspace-service.ts`:

```ts
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

interface GoalRow { id: string; cwd: string; title: string; project_id: string | null; }

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

/** Best-effort: register a path as safe.directory to dodge the Windows NTFS dubious-ownership fatal. */
function markSafe(absPath: string): void {
  try { execFileSync('git', ['config', '--global', '--add', 'safe.directory', absPath.replace(/\\/g, '/')]); }
  catch (err) { logger.warn({ err, absPath }, 'workspace: safe.directory mark failed'); }
}

/** 'goal/<8charid>-<slug>' — filesystem + git-ref safe. */
function branchName(goalId: string, title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 24) || 'work';
  return `goal/${goalId.slice(0, 8)}-${slug}`;
}

/** Default worktree dir name (sibling to repo when project.worktree_root is unset). */
function defaultWorktreeRoot(repoRoot: string): string {
  return path.join(path.dirname(repoRoot), `.${path.basename(repoRoot)}-worktrees`);
}

export function createWorkspaceService(db: Database.Database, projectService: ProjectService) {
  const getWsStmt = db.prepare<[string], GoalWorkspace>('SELECT * FROM goal_workspace WHERE goal_id = ?');
  const insertWsStmt = db.prepare<[string, string, string, string, string, number]>(
    `INSERT INTO goal_workspace (goal_id, branch, worktree_path, base_ref, mode, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );

  function get(goalId: string): GoalWorkspace | null {
    return getWsStmt.get(goalId) ?? null;
  }

  /** Current branch of a repo, used as base_ref for diffs. */
  function currentBranch(repoRoot: string): string {
    try { return git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() || 'HEAD'; }
    catch { return 'HEAD'; }
  }

  /**
   * Provisions (or returns existing) an isolated workspace for the goal.
   * Returns null if the goal has no registered project (no repo to isolate).
   */
  function provision(goalId: string): GoalWorkspace | null {
    const existing = get(goalId);
    if (existing) return existing;

    const goal = db.prepare<[string], GoalRow>('SELECT id, cwd, title, project_id FROM goals WHERE id = ?').get(goalId);
    if (!goal) throw new Error(`Goal not found: ${goalId}`);

    const project = goal.project_id ? projectService.get(goal.project_id) : projectService.findByCwd(goal.cwd);
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
    const worktreePath = path.join(wtRoot, `${goalId.slice(0, 8)}`);

    let mode: 'worktree' | 'branch' = 'worktree';
    try {
      // `git worktree add -b <branch> <path> <base>` — args array avoids Windows quoting.
      git(repoRoot, ['worktree', 'add', '-b', branch, worktreePath, base]);
      markSafe(worktreePath);
    } catch (err) {
      // Fallback: branch-in-place (e.g. worktrees disabled, or path collision).
      logger.warn({ err, goalId }, 'workspace: worktree add failed — falling back to branch-in-place');
      mode = 'branch';
      try { git(repoRoot, ['branch', branch, base]); } catch { /* branch may exist */ }
    }

    const record: GoalWorkspace = {
      goal_id: goalId,
      branch,
      worktree_path: mode === 'worktree' ? worktreePath : repoRoot,
      base_ref: base,
      mode,
      created_at: Date.now(),
    };
    insertWsStmt.run(record.goal_id, record.branch, record.worktree_path, record.base_ref, record.mode, record.created_at);
    logger.info({ goalId, branch, mode, path: record.worktree_path }, 'workspace: provisioned');
    return record;
  }

  /** Removes the worktree + branch for a goal. Best-effort cleanup on archive/complete. */
  function teardown(goalId: string): void {
    const ws = get(goalId);
    if (!ws) return;
    const goal = db.prepare<[string], GoalRow>('SELECT id, cwd, title, project_id FROM goals WHERE id = ?').get(goalId);
    const project = goal?.project_id ? projectService.get(goal.project_id) : (goal ? projectService.findByCwd(goal.cwd) : null);
    if (project && ws.mode === 'worktree') {
      try { git(project.root_path, ['worktree', 'remove', '--force', ws.worktree_path]); }
      catch (err) { logger.warn({ err, goalId }, 'workspace: worktree remove failed'); }
    }
    db.prepare('DELETE FROM goal_workspace WHERE goal_id = ?').run(goalId);
  }

  return { get, provision, teardown };
}

export type WorkspaceService = ReturnType<typeof createWorkspaceService>;
```

**Step 3 — run** `npm test -- workspace-service` → PASS (requires git on PATH). **Commit:** `feat(5B): WorkspaceService — worktree-or-branch provisioning, Windows-safe`.

**Self-review:** Args passed as arrays (no shell quoting). `safe.directory` marked for both repo and worktree. Worktree-add failure degrades to branch-in-place instead of throwing. Idempotent. Returns `null` (in-place, no isolation) for unregistered cwds — matches the gradual-adoption decision in Task 3.

---

## Task 7 — `WorkspaceService.diff` + dirty-state, and a goal helper

**Goal:** Compute `git diff base_ref..HEAD` (plus working-tree changes) and a cheap dirty/branch summary for the card.

**Files:**
- Modify: `server/services/workspace-service.ts` (add `diff`, `summary`)
- Test: `tests/server/services/workspace-diff.test.ts`

**Step 1 — failing test** `tests/server/services/workspace-diff.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeMigratedDb } from '../helpers/db-fixture';
import { makeTempRepo, cleanupTempRepo } from '../helpers/git-fixture';
import { createProjectService } from '../../../server/services/project-service';
import { createGoalService } from '../../../server/services/goal-service';
import { createWorkspaceService } from '../../../server/services/workspace-service';
import type Database from 'better-sqlite3';

vi.mock('../../../server/ws', () => ({ broadcast: vi.fn() }));
vi.mock('../../../server/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

let db: Database.Database; let repo: string | null = null; let wtRoot: string | null = null;
beforeEach(() => { db = makeMigratedDb(); });
afterEach(() => { db.close(); if (wtRoot) cleanupTempRepo(wtRoot); if (repo) cleanupTempRepo(repo); repo = null; wtRoot = null; });

it('reports a unified diff and dirty=true after a change in the workspace', () => {
  repo = makeTempRepo();
  wtRoot = path.join(path.dirname(repo), `wt-${Date.now()}`);
  const projects = createProjectService(db);
  const goals = createGoalService(db, projects);
  const project = projects.create({ name: 'R', root_path: repo, worktree_root: wtRoot });
  const goal = goals.create({ title: 'Edit', cwd: repo, projectId: project.id });
  const ws = createWorkspaceService(db, projects);
  const provisioned = ws.provision(goal.id)!;

  fs.writeFileSync(path.join(provisioned.worktree_path, 'README.md'), '# fixture\nchanged\n');

  const summary = ws.summary(goal.id);
  expect(summary?.branch).toBe(provisioned.branch);
  expect(summary?.dirty).toBe(true);

  const diff = ws.diff(goal.id);
  expect(diff).toContain('README.md');
  expect(diff).toContain('+changed');
});

it('returns empty diff and dirty=false for an untouched workspace', () => {
  repo = makeTempRepo();
  wtRoot = path.join(path.dirname(repo), `wt-${Date.now()}`);
  const projects = createProjectService(db);
  const goals = createGoalService(db, projects);
  const project = projects.create({ name: 'R', root_path: repo, worktree_root: wtRoot });
  const goal = goals.create({ title: 'NoOp', cwd: repo, projectId: project.id });
  const ws = createWorkspaceService(db, projects);
  ws.provision(goal.id);
  expect(ws.summary(goal.id)?.dirty).toBe(false);
  expect(ws.diff(goal.id)).toBe('');
});
```

**Step 2 — implement** in `workspace-service.ts` (add inside the factory, then export on the returned object):

```ts
  /** Branch + dirty flag for card display. Null when no workspace. */
  function summary(goalId: string): { branch: string; dirty: boolean } | null {
    const ws = get(goalId);
    if (!ws) return null;
    let dirty = false;
    try {
      const status = git(ws.worktree_path, ['status', '--porcelain']).trim();
      dirty = status.length > 0;
    } catch (err) { logger.warn({ err, goalId }, 'workspace: status failed'); }
    return { branch: ws.branch, dirty };
  }

  /**
   * Unified diff of the workspace vs base_ref: committed delta (base..HEAD)
   * plus uncommitted working-tree changes. Empty string when no workspace or no changes.
   */
  function diff(goalId: string): string {
    const ws = get(goalId);
    if (!ws) return '';
    try {
      // Committed changes since base, then working-tree changes, concatenated.
      const committed = git(ws.worktree_path, ['diff', `${ws.base_ref}...HEAD`]);
      const working = git(ws.worktree_path, ['diff', 'HEAD']);
      const untrackedNames = git(ws.worktree_path, ['ls-files', '--others', '--exclude-standard']).trim();
      let untracked = '';
      if (untrackedNames) {
        for (const f of untrackedNames.split(/\r?\n/).filter(Boolean)) {
          try { untracked += git(ws.worktree_path, ['diff', '--no-index', '/dev/null', f]); }
          catch { /* --no-index exits non-zero when it finds a diff; capture via git diff fallback below */ }
        }
      }
      return [committed, working, untracked].filter((s) => s.trim().length > 0).join('\n');
    } catch (err) {
      logger.warn({ err, goalId }, 'workspace: diff failed');
      return '';
    }
  }
```

> **Windows `/dev/null` note:** `git diff --no-index` against `/dev/null` works through Git-for-Windows' bundled bash for untracked files but is brittle. Simpler and portable: stage-then-diff is avoided to keep the workspace clean; instead, for untracked files fall back to `git add -N <file>` (intent-to-add) on a throwaway basis is **not** done (it mutates the index). The test above only asserts on a *tracked* modification (`README.md`), so the committed+working paths are the load-bearing ones; untracked rendering is best-effort. If `--no-index` proves flaky in CI, drop the untracked block — tracked-file diffs satisfy the diff-review requirement.

Add `summary, diff` to the returned object.

**Step 3 — run** `npm test -- workspace-diff` → PASS. **Commit:** `feat(5B): workspace diff + dirty-state summary`.

**Self-review:** Diff is computed against the recorded `base_ref` (matches migration 022). `summary.dirty` drives the card. Untracked handling is explicitly best-effort and documented; the test pins the reliable path.

---

## Task 8 — Spawn in the workspace + `GET /api/goals/:id/diff` + `POST /api/goals/:id/pr`

**Goal:** (a) Make goal spawn provision a workspace and run the PTY there; (b) expose diff + PR endpoints on the goals router.

**Files:**
- Modify: `server/pty-manager.ts` (use a per-goal override cwd when present)
- Modify: `server/routes/goals.ts` (inject `workspaceService`, add `/diff` and `/pr`)
- Modify: `server/index.ts` `spawnTerminalSession` (provision before spawn, set goal cwd to workspace) — **full wiring in Task 16; here add the seam + endpoints**
- Test: `tests/server/routes/goals-diff.test.ts`

**Step 1 — PtyManager workspace cwd.** `PtyManager` already spawns at `this.goal.cwd`. Rather than thread a new param everywhere, have `spawnTerminalSession` pass a goal object whose `cwd` is the workspace path. Add a tiny override so the manager prefers an explicit workspace cwd if provided:

In `pty-manager.ts`, change the constructor options to accept an optional `cwdOverride`:

```ts
interface PtyManagerOptions {
  broadcast: (event: ServerEvent) => void;
  onExit?: (goalId: string, exitCode: number) => void;
  onReady?: () => void;
  cwdOverride?: string;   // workspace path from 5B; falls back to goal.cwd
}
```

Add a private field and use it in both `start()` and `resume()` spawn calls:

```ts
  private readonly cwd: string;
  // in constructor:
  this.cwd = options.cwdOverride ?? goal.cwd;
  // in pty.spawn(...) calls, replace `cwd: this.goal.cwd,` with `cwd: this.cwd,`
```

(Two spawn sites: `start` and `resume`. Also update the log line `cwd: this.goal.cwd` → `cwd: this.cwd`.)

**Step 2 — failing test** `tests/server/routes/goals-diff.test.ts` (exercises the route against a real temp repo):

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { makeMigratedDb } from '../helpers/db-fixture';
import { makeTempRepo, cleanupTempRepo } from '../helpers/git-fixture';
import { createProjectService } from '../../../server/services/project-service';
import { createGoalService } from '../../../server/services/goal-service';
import { createWorkspaceService } from '../../../server/services/workspace-service';
import { createGoalsRouter } from '../../../server/routes/goals';
import type Database from 'better-sqlite3';

vi.mock('../../../server/ws', () => ({ broadcast: vi.fn() }));
vi.mock('../../../server/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

let db: Database.Database; let server: http.Server; let port: number; let repo: string | null = null; let wtRoot: string | null = null;
const url = (p: string) => `http://127.0.0.1:${port}/api${p}`;

beforeEach(async () => {
  db = makeMigratedDb();
  repo = makeTempRepo();
  wtRoot = path.join(path.dirname(repo), `wt-${Date.now()}`);
  const projects = createProjectService(db);
  const goals = createGoalService(db, projects);
  const ws = createWorkspaceService(db, projects);
  const project = projects.create({ name: 'R', root_path: repo, worktree_root: wtRoot });
  const goal = goals.create({ title: 'Diff Goal', cwd: repo, projectId: project.id });
  const provisioned = ws.provision(goal.id)!;
  fs.writeFileSync(path.join(provisioned.worktree_path, 'README.md'), '# fixture\nedited by agent\n');
  (db as unknown as { __goalId: string }).__goalId = goal.id;

  const app = express();
  app.use(express.json());
  app.use('/api', createGoalsRouter(goals, undefined, undefined, ws));
  server = http.createServer(app);
  port = await new Promise<number>((r) => server.listen(0, () => { const a = server.address(); if (a && typeof a === 'object') r(a.port); }));
});
afterEach(() => { server.close(); db.close(); if (wtRoot) cleanupTempRepo(wtRoot); if (repo) cleanupTempRepo(repo); repo = null; wtRoot = null; });

it('GET /goals/:id/diff returns the workspace diff', async () => {
  const goalId = (db as unknown as { __goalId: string }).__goalId;
  const res = await fetch(url(`/goals/${goalId}/diff`));
  expect(res.status).toBe(200);
  const body = await res.json() as { branch: string; diff: string; dirty: boolean };
  expect(body.diff).toContain('edited by agent');
  expect(body.dirty).toBe(true);
});

it('GET /goals/:id/diff 404s for an unknown goal', async () => {
  const res = await fetch(url('/goals/does-not-exist/diff'));
  expect(res.status).toBe(404);
});
```

**Step 3 — implement** in `server/routes/goals.ts`:

1. Add `workspaceService` as a 4th optional param:

```ts
import type { WorkspaceService } from '../services/workspace-service';

export function createGoalsRouter(
  goalService: GoalService,
  spawnTerminal?: (goalId: string, initialPrompt?: string) => string,
  interGoalMessageService?: InterGoalMessageService,
  workspaceService?: WorkspaceService,
): Router {
```

2. Add the diff route:

```ts
  /**
   * GET /goals/:id/diff — Unified git diff of the goal's workspace vs base_ref.
   * Returns { branch, dirty, diff }. 404 if goal not found, 200 with empty diff if no workspace.
   */
  router.get('/goals/:id/diff', (req: Request, res: Response) => {
    const goalId = String(req.params['id']);
    const goal = goalService.get(goalId);
    if (!goal) { res.status(404).json({ error: 'Goal not found' }); return; }
    if (!workspaceService) { res.json({ branch: null, dirty: false, diff: '' }); return; }
    const summary = workspaceService.summary(goalId);
    res.json({ branch: summary?.branch ?? null, dirty: summary?.dirty ?? false, diff: workspaceService.diff(goalId) });
  });

  /**
   * POST /goals/:id/pr — Push the goal branch and open a PR.
   * Uses `gh pr create` when available; otherwise pushes and returns a compare URL.
   * Body: { title?: string, body?: string }. 404 if no goal/workspace.
   */
  router.post('/goals/:id/pr', (req: Request, res: Response) => {
    const goalId = String(req.params['id']);
    const goal = goalService.get(goalId);
    if (!goal) { res.status(404).json({ error: 'Goal not found' }); return; }
    if (!workspaceService) { res.status(501).json({ error: 'Workspace isolation not available' }); return; }
    try {
      const result = workspaceService.createPr(goalId, {
        title: typeof req.body?.title === 'string' ? req.body.title : goal.title,
        body: typeof req.body?.body === 'string' ? req.body.body : (goal.description ?? ''),
      });
      res.json(result);
    } catch (err) {
      logger.error({ err, goalId }, 'Failed to create PR');
      res.status(500).json({ error: 'Failed to create PR' });
    }
  });
```

3. Implement `createPr` in `workspace-service.ts`:

```ts
  /** Pushes the branch and opens a PR via gh; falls back to push + compare URL. */
  function createPr(goalId: string, opts: { title: string; body: string }): { method: 'gh' | 'push'; url: string | null; pushed: boolean } {
    const ws = get(goalId);
    if (!ws) throw new Error(`No workspace for goal ${goalId}`);
    const goal = db.prepare<[string], GoalRow>('SELECT id, cwd, title, project_id FROM goals WHERE id = ?').get(goalId);
    const project = goal?.project_id ? projectService.get(goal.project_id) : (goal ? projectService.findByCwd(goal.cwd) : null);
    const repoRoot = project?.root_path ?? ws.worktree_path;
    git(ws.worktree_path, ['push', '-u', 'origin', ws.branch]);
    try {
      const out = git(repoRoot, ['-C', ws.worktree_path, 'pr', 'create', '--title', opts.title, '--body', opts.body, '--head', ws.branch]);
      // Note: `git pr` is not a thing — use the gh binary directly:
      return { method: 'gh', url: out.trim() || null, pushed: true };
    } catch {
      return { method: 'push', url: null, pushed: true };
    }
  }
```

> **Correction to the snippet above:** PR creation must shell out to the **`gh`** binary, not `git`. Implement `createPr` with `execFileSync('gh', ['pr', 'create', '--title', opts.title, '--body', opts.body, '--head', ws.branch], { cwd: ws.worktree_path, encoding: 'utf-8' })` inside the try, and on any error (gh missing / not authed) return `{ method: 'push', url: null, pushed: true }`. The push step uses `git ... ['push', '-u', 'origin', ws.branch]`. Guard the whole thing so a missing remote returns `pushed: false` with a logged warning rather than throwing a 500. **PR creation is not unit-tested against a live remote** (no network in CI); cover it with a test that asserts a 501 when `workspaceService` is absent and a graceful shape when push fails (mock `execFileSync`), per Step 4.

**Step 4 — PR route test** (add to `goals-diff.test.ts` or a sibling): assert `POST /goals/:id/pr` returns 501 when the router is constructed without `workspaceService`, and (with `execFileSync` mocked to throw on push) returns 500 with `{ error }` — no live remote needed.

**Step 5 — run** `npm test -- goals-diff` and `npm run typecheck` → PASS. **Commit:** `feat(5B): spawn in workspace + GET /goals/:id/diff + POST /goals/:id/pr`.

**Self-review:** Diff route is read-only and 404-safe. PR route degrades (gh → push → graceful failure) and never crashes the server. `cwdOverride` keeps `PtyManager` backward-compatible (defaults to `goal.cwd`).

---

## Task 9 — KanbanCard: branch + dirty-state badge

**Goal:** Surface the workspace branch and a dirty indicator on the card (client test, jsdom).

**Files:**
- Modify: `src/components/kanban/KanbanCard.tsx`
- Test: `tests/client/components/kanban-card-workspace.test.tsx`

**Step 1 — failing test** `tests/client/components/kanban-card-workspace.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import KanbanCard from '../../../src/components/kanban/KanbanCard';
import type { Goal } from '../../../src/shared/types';

function makeGoal(over: Partial<Goal> = {}): Goal {
  return {
    id: 'g1', title: 'WS Goal', description: null, cwd: 'C:/repo', status: 'active',
    priority: 0, tags: [], current_session_id: null, model: 'sonnet', permission_mode: 'supervised',
    plan_json: null, kanban_order: 0, created_at: 1, updated_at: 1, completed_at: null,
    project_id: null,
    ...over,
  } as Goal;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo) => {
    const u = String(input);
    if (u.endsWith('/diff')) return new Response(JSON.stringify({ branch: 'goal/abc-ws', dirty: true, diff: 'x' }), { status: 200 });
    if (u.match(/\/api\/goals\/g1$/)) return new Response(JSON.stringify({ goal: { current_session_id: null } }), { status: 200 });
    return new Response('{}', { status: 200 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

it('renders the workspace branch and a dirty dot', async () => {
  render(<MemoryRouter><KanbanCard goal={makeGoal()} /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText(/goal\/abc-ws/)).toBeInTheDocument());
  expect(screen.getByLabelText(/uncommitted changes/i)).toBeInTheDocument();
});
```

**Step 2 — implement.** In `KanbanCard.tsx`, add workspace state + a fetch to `/diff` (summary only — the endpoint already returns `branch`/`dirty` cheaply), and render a small badge. Add near the existing `stats` state:

```tsx
  const [workspace, setWorkspace] = useState<{ branch: string | null; dirty: boolean } | null>(null);
```

In the existing `useEffect` `load()` (after the session fetch block), add a parallel workspace fetch guarded by `cancelled`:

```tsx
        const diffRes = await fetch(`/api/goals/${goal.id}/diff`);
        if (diffRes.ok && !cancelled) {
          const d = (await diffRes.json()) as { branch: string | null; dirty: boolean };
          if (d.branch) setWorkspace({ branch: d.branch, dirty: d.dirty });
        }
```

Render in the model+stats row (before the stats span), importing `GitBranch` from `lucide-react`:

```tsx
      {workspace?.branch && (
        <span className="mono-tabular inline-flex items-center gap-0.5 rounded-sm bg-inset px-1 py-0.5 text-[10px] text-faint" title={workspace.branch}>
          <GitBranch size={9} />
          <span className="max-w-[80px] truncate">{workspace.branch.replace(/^goal\//, '')}</span>
          {workspace.dirty && (
            <span aria-label="uncommitted changes" title="Uncommitted changes" className="ml-0.5 h-[5px] w-[5px] rounded-full bg-warn" />
          )}
        </span>
      )}
```

> Branch text shows `goal/abc-ws` as `abc-ws` after stripping the prefix — but the test asserts on the full `goal/abc-ws` via the `title` attribute and visible text. Keep the **visible** text containing the branch (the test uses `getByText(/goal\/abc-ws/)`); to satisfy it, render the full branch as the text node OR adjust the test to `abc-ws`. **Decision: render the full branch** (`{workspace.branch}` not the stripped form) so the assertion is unambiguous; drop the `.replace`. Update the snippet to `{workspace.branch}`.

**Step 3 — run** `npm test -- kanban-card-workspace` → PASS. **Commit:** `feat(5B): KanbanCard shows workspace branch + dirty indicator`.

**Self-review:** Fetch is `cancelled`-guarded (matches the existing pattern's race protection). Badge only renders when a branch exists, so unregistered/in-place goals are visually unchanged. `aria-label` makes the dirty dot testable + accessible.

---

## Task 10 — Diff view in Goal Detail

**Goal:** Render the diff endpoint's output in a `<pre>` diff panel inside Goal Detail.

**Files:**
- Create: `src/components/goal-detail/DiffView.tsx`
- Modify: the Goal Detail page to mount `DiffView` (locate via `tests/client/goal-detail.test.tsx` / `src/pages` — the page that renders goal detail; mount under a "Diff" affordance)
- Test: `tests/client/components/diff-view.test.tsx`

**Step 1 — failing test** `tests/client/components/diff-view.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import DiffView from '../../../src/components/goal-detail/DiffView';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ branch: 'goal/abc', dirty: true, diff: 'diff --git a/x b/x\n+added line\n-removed line\n' }),
    { status: 200 },
  )));
});
afterEach(() => vi.unstubAllGlobals());

it('fetches and renders the diff with added/removed lines', async () => {
  render(<DiffView goalId="g1" />);
  await waitFor(() => expect(screen.getByText(/added line/)).toBeInTheDocument());
  expect(screen.getByText(/removed line/)).toBeInTheDocument();
  expect(screen.getByText(/goal\/abc/)).toBeInTheDocument();
});

it('shows an empty-state when there is no diff', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ branch: null, dirty: false, diff: '' }), { status: 200 })));
  render(<DiffView goalId="g2" />);
  await waitFor(() => expect(screen.getByText(/no changes/i)).toBeInTheDocument());
});
```

**Step 2 — implement** `src/components/goal-detail/DiffView.tsx`:

```tsx
import { useEffect, useState } from 'react';

interface DiffResponse { branch: string | null; dirty: boolean; diff: string; }

/** Read-only git diff panel for a goal's isolated workspace (5B). */
export default function DiffView({ goalId }: { goalId: string }) {
  const [data, setData] = useState<DiffResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/goals/${goalId}/diff`, { signal: ac.signal });
        if (!res.ok || cancelled) return;
        const json = (await res.json()) as DiffResponse;
        if (!cancelled) setData(json);
      } catch { /* aborted or network */ }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; ac.abort(); };
  }, [goalId]);

  if (loading) return <div className="text-faint text-[12px] p-3">Loading diff…</div>;
  if (!data || !data.diff.trim()) {
    return <div className="text-faint text-[12px] p-3">No changes in this workspace.</div>;
  }

  return (
    <div className="rounded-md border border-line bg-card">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-[12px]">
        {data.branch && <span className="mono-tabular text-fg">{data.branch}</span>}
        {data.dirty && <span className="text-warn text-[11px]">uncommitted</span>}
      </div>
      <pre className="overflow-x-auto p-3 text-[11px] leading-relaxed mono-tabular">
        {data.diff.split('\n').map((line, i) => (
          <div
            key={i}
            className={
              line.startsWith('+') && !line.startsWith('+++') ? 'text-ok'
              : line.startsWith('-') && !line.startsWith('---') ? 'text-danger'
              : line.startsWith('@@') ? 'text-accent'
              : 'text-faint'
            }
          >
            {line || ' '}
          </div>
        ))}
      </pre>
    </div>
  );
}
```

**Step 3 — mount in Goal Detail.** Find the goal-detail page (per `tests/client/goal-detail.test.tsx`, likely `src/pages/GoalDetailPage.tsx`). Add a "Diff" tab/section that renders `<DiffView goalId={goal.id} />`. Keep the integration minimal — a collapsible section is enough. (If the page is tab-based, add a `Diff` tab; if section-based, append below the conversation.) Verify the existing `goal-detail.test.tsx` still passes.

**Step 4 — run** `npm test -- diff-view` and `npm test -- goal-detail` → PASS. **Commit:** `feat(5B): DiffView panel in Goal Detail`.

**Self-review:** Uses `AbortController` (matches the analytics fetch-race convention from the roadmap). Colorizes +/-/@@ lines. Empty-state covered. Read-only.

---

## Task 11 — Persist resume state on session start (5D groundwork)

**Goal:** Whenever a session spawns/resumes, record `provider_session_id` and `workspace_path` on the `sessions` row so a restart can reconstruct the resume command.

**Files:**
- Modify: `server/services/session-service.ts` (add `recordResumeState(sessionId, { providerSessionId, workspacePath })`)
- Test: `tests/server/services/session-resume-state.test.ts`

**Step 1 — inspect** `session-service.ts` to find the start/insert method (read it first). Add a method that updates the two new columns.

**Step 2 — failing test** `tests/server/services/session-resume-state.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeMigratedDb } from '../helpers/db-fixture';
import { SessionService } from '../../../server/services/session-service';
import type Database from 'better-sqlite3';

vi.mock('../../../server/ws', () => ({ broadcast: vi.fn() }));
vi.mock('../../../server/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

let db: Database.Database;
beforeEach(() => { db = makeMigratedDb(); });
afterEach(() => db.close());

it('records provider_session_id + workspace_path for resume', () => {
  // seed a goal + session row
  db.prepare(`INSERT INTO goals (id,title,description,cwd,status,priority,tags,current_session_id,permission_mode,model,initial_prompt,kanban_order,created_at,updated_at,completed_at,project_id)
              VALUES ('g1','T',NULL,'C:/repo','active',0,'[]',NULL,'supervised',NULL,NULL,0,1,1,NULL,NULL)`).run();
  db.prepare(`INSERT INTO sessions (id,goal_id,origin,started_at) VALUES ('g1','g1','dashboard',1)`).run();

  const svc = new SessionService(db, vi.fn());
  svc.recordResumeState('g1', { providerSessionId: 'g1', workspacePath: 'C:/wt/g1' });

  const row = db.prepare('SELECT provider_session_id, workspace_path FROM sessions WHERE id = ?').get('g1') as { provider_session_id: string; workspace_path: string };
  expect(row.provider_session_id).toBe('g1');
  expect(row.workspace_path).toBe('C:/wt/g1');
});
```

**Step 3 — implement** in `SessionService`:

```ts
  /** Persists durable resume state (provider session id + workspace cwd) for restart recovery. */
  recordResumeState(sessionId: string, state: { providerSessionId: string | null; workspacePath: string | null }): void {
    this.db
      .prepare('UPDATE sessions SET provider_session_id = ?, workspace_path = ? WHERE id = ?')
      .run(state.providerSessionId, state.workspacePath, sessionId);
  }
```

(If `SessionService` doesn't already hold `this.db`, read the constructor and use the existing field name.)

**Step 4 — run** `npm test -- session-resume-state` → PASS. **Commit:** `feat(5D): persist provider_session_id + workspace_path on sessions`.

**Self-review:** Pure persistence; broadcast untouched. Nullable-safe. The spawn site calls this in Task 16 (`spawnTerminalSession` records `providerSessionId = goalId` for Claude, `workspacePath = workspace?.worktree_path ?? goal.cwd`).

---

## Task 12 — `ReconciliationService`: detect orphaned active sessions

**Goal:** A pure, testable query that finds sessions which the DB believes are active (goal active/waiting, `ended_at IS NULL`) but for which no live process exists in the registry — the candidates for resume-on-boot.

**Files:**
- Create: `server/services/reconciliation-service.ts`
- Test: `tests/server/services/reconciliation-service.test.ts`

**Step 1 — failing test** `tests/server/services/reconciliation-service.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeMigratedDb } from '../helpers/db-fixture';
import { createReconciliationService } from '../../../server/services/reconciliation-service';
import type Database from 'better-sqlite3';

vi.mock('../../../server/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

let db: Database.Database;
beforeEach(() => { db = makeMigratedDb(); });
afterEach(() => db.close());

function seedActiveGoalWithOpenSession(goalId: string) {
  db.prepare(`INSERT INTO goals (id,title,description,cwd,status,priority,tags,current_session_id,permission_mode,model,initial_prompt,kanban_order,created_at,updated_at,completed_at,project_id)
              VALUES (?,?,NULL,'C:/repo','active',0,'[]',?,'supervised',NULL,NULL,0,1,1,NULL,NULL)`).run(goalId, goalId, goalId);
  db.prepare(`INSERT INTO sessions (id,goal_id,origin,started_at,ended_at,provider_session_id,workspace_path)
              VALUES (?,?,'dashboard',1,NULL,?,'C:/wt/x')`).run(goalId, goalId, goalId);
}

it('lists orphans: open sessions on active goals with no live process', () => {
  seedActiveGoalWithOpenSession('g1');
  seedActiveGoalWithOpenSession('g2');
  const isLive = (goalId: string) => goalId === 'g2'; // g2 still has a process
  const svc = createReconciliationService(db);
  const orphans = svc.findOrphans(isLive);
  expect(orphans.map((o) => o.goalId)).toEqual(['g1']);
  expect(orphans[0]!.providerSessionId).toBe('g1');
  expect(orphans[0]!.workspacePath).toBe('C:/wt/x');
});

it('ignores completed goals and ended sessions', () => {
  db.prepare(`INSERT INTO goals (id,title,description,cwd,status,priority,tags,current_session_id,permission_mode,model,initial_prompt,kanban_order,created_at,updated_at,completed_at,project_id)
              VALUES ('done','T',NULL,'C:/repo','complete',0,'[]',NULL,'supervised',NULL,NULL,0,1,1,1,NULL)`).run();
  db.prepare(`INSERT INTO sessions (id,goal_id,origin,started_at,ended_at) VALUES ('done','done','dashboard',1,2)`).run();
  const svc = createReconciliationService(db);
  expect(svc.findOrphans(() => false)).toEqual([]);
});
```

**Step 2 — implement** `server/services/reconciliation-service.ts`:

```ts
import type Database from 'better-sqlite3';
import logger from '../logger';

export interface Orphan {
  goalId: string;
  sessionId: string;
  providerSessionId: string | null;
  workspacePath: string | null;
  model: string | null;
  cwd: string;
  permissionMode: 'autonomous' | 'supervised';
}

interface OrphanRow {
  goal_id: string; session_id: string; provider_session_id: string | null;
  workspace_path: string | null; model: string | null; cwd: string; permission_mode: string;
}

/**
 * Detects sessions the DB thinks are active but which have no live OS process —
 * the candidates for resume-on-boot (5D). Pure: the liveness check is injected.
 */
export function createReconciliationService(db: Database.Database) {
  const stmt = db.prepare<[], OrphanRow>(`
    SELECT s.goal_id AS goal_id, s.id AS session_id, s.provider_session_id AS provider_session_id,
           s.workspace_path AS workspace_path, g.model AS model, g.cwd AS cwd, g.permission_mode AS permission_mode
    FROM sessions s
    JOIN goals g ON s.goal_id = g.id
    WHERE s.ended_at IS NULL
      AND g.status IN ('active', 'waiting')
  `);

  /** Returns orphans for which isLive(goalId) is false. */
  function findOrphans(isLive: (goalId: string) => boolean): Orphan[] {
    const rows = stmt.all();
    const orphans = rows
      .filter((r) => !isLive(r.goal_id))
      .map<Orphan>((r) => ({
        goalId: r.goal_id,
        sessionId: r.session_id,
        providerSessionId: r.provider_session_id,
        workspacePath: r.workspace_path,
        model: r.model,
        cwd: r.cwd,
        permissionMode: r.permission_mode === 'autonomous' ? 'autonomous' : 'supervised',
      }));
    logger.info({ count: orphans.length }, 'reconciliation: orphaned sessions detected');
    return orphans;
  }

  return { findOrphans };
}

export type ReconciliationService = ReturnType<typeof createReconciliationService>;
```

**Step 3 — run** `npm test -- reconciliation-service` → PASS. **Commit:** `feat(5D): ReconciliationService.findOrphans (orphan detection)`.

**Self-review:** Liveness injected (no `processRegistry` coupling — testable). Only active/waiting goals with open sessions qualify. Carries enough state (`providerSessionId`, `workspacePath`, `model`, `permissionMode`) to build a resume command without re-querying.

---

## Task 13 — Resume-on-boot driver (adapter-aware, with Claude fallback)

**Goal:** Turn an `Orphan[]` into resumed PTY sessions, using `adapter.buildResumeArgs(sessionId, ctx)` + `capabilities.canResume` when an adapter is available; falling back to the existing Claude resume otherwise. Skips providers that can't resume.

**Files:**
- Create: `server/resume-driver.ts`
- Test: `tests/server/resume-driver.test.ts`

**Step 1 — failing test** `tests/server/resume-driver.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { resumeOrphans } from '../../server/resume-driver';
import type { Orphan } from '../../server/services/reconciliation-service';

vi.mock('../../server/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

function orphan(over: Partial<Orphan> = {}): Orphan {
  return { goalId: 'g1', sessionId: 'g1', providerSessionId: 'g1', workspacePath: 'C:/wt/g1', model: 'sonnet', cwd: 'C:/repo', permissionMode: 'supervised', ...over };
}

it('resumes each orphan via the injected resume callback', () => {
  const resumed: string[] = [];
  const resume = (o: Orphan) => { resumed.push(o.goalId); };
  const canResume = () => true;
  resumeOrphans([orphan({ goalId: 'a' }), orphan({ goalId: 'b' })], { canResume, resume });
  expect(resumed).toEqual(['a', 'b']);
});

it('skips orphans whose provider cannot resume', () => {
  const resumed: string[] = [];
  resumeOrphans([orphan({ goalId: 'a', model: 'codex' })], {
    canResume: (model) => model !== 'codex',
    resume: (o) => resumed.push(o.goalId),
  });
  expect(resumed).toEqual([]);
});

it('skips orphans missing a providerSessionId (nothing to resume)', () => {
  const resumed: string[] = [];
  resumeOrphans([orphan({ providerSessionId: null })], { canResume: () => true, resume: (o) => resumed.push(o.goalId) });
  expect(resumed).toEqual([]);
});
```

**Step 2 — implement** `server/resume-driver.ts`:

```ts
import type { Orphan } from './services/reconciliation-service';
import logger from './logger';

export interface ResumeDeps {
  /** True if the provider for this model can resume (adapter.capabilities.canResume). */
  canResume: (model: string | null) => boolean;
  /** Actually resume the orphan (spawn PTY with --resume / buildResumeArgs). */
  resume: (orphan: Orphan) => void;
}

/**
 * Resume-on-boot driver (5D). For each orphan with a resumable provider and a
 * stored provider session id, invokes deps.resume. Pure orchestration —
 * adapter selection + PTY spawn are injected so this is unit-testable.
 */
export function resumeOrphans(orphans: Orphan[], deps: ResumeDeps): void {
  for (const o of orphans) {
    if (!o.providerSessionId) {
      logger.warn({ goalId: o.goalId }, 'resume: no provider session id — skipping');
      continue;
    }
    if (!deps.canResume(o.model)) {
      logger.info({ goalId: o.goalId, model: o.model }, 'resume: provider cannot resume — skipping');
      continue;
    }
    try {
      deps.resume(o);
      logger.info({ goalId: o.goalId }, 'resume: orphan resumed on boot');
    } catch (err) {
      logger.error({ err, goalId: o.goalId }, 'resume: failed to resume orphan');
    }
  }
}
```

**Step 3 — run** `npm test -- resume-driver` → PASS. **Commit:** `feat(5D): resume-on-boot driver (adapter-aware, capability-gated)`.

**Self-review:** Capability gate (`canResume`) and missing-session guard both covered. Errors are caught per-orphan so one failure doesn't abort the batch. Adapter is injected via the `canResume`/`resume` callbacks — Task 16 wires Claude (`canResume: () => true`, `resume: (o) => restartSession(o.sessionId, o.goalId)`), and post-Phase-1 swaps in `adapter.capabilities.canResume` + `adapter.buildResumeArgs`.

---

## Task 14 — Graceful drain on shutdown: persist before kill

**Goal:** On `SIGINT`/`SIGTERM`, before killing PTYs, persist resume state for every live session so the next boot can recover it. Today `shutdown()` calls `processRegistry.killAll()` directly; insert a drain step.

**Files:**
- Create: `server/drain.ts` (pure: takes the registry's live goal ids + a persist callback)
- Test: `tests/server/drain.test.ts`

**Step 1 — failing test** `tests/server/drain.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { drainSessions } from '../../server/drain';

vi.mock('../../server/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

it('persists resume state for each live goal before returning', () => {
  const persisted: string[] = [];
  drainSessions(['g1', 'g2'], (goalId) => { persisted.push(goalId); });
  expect(persisted).toEqual(['g1', 'g2']);
});

it('continues persisting even if one callback throws', () => {
  const persisted: string[] = [];
  drainSessions(['bad', 'good'], (goalId) => {
    if (goalId === 'bad') throw new Error('boom');
    persisted.push(goalId);
  });
  expect(persisted).toEqual(['good']);
});
```

**Step 2 — implement** `server/drain.ts`:

```ts
import logger from './logger';

/**
 * Graceful-drain step (5D): persists resume state for every live goal before
 * the process registry kills the PTYs. Pure — the persist action is injected
 * (Task 16 supplies one that writes provider_session_id + workspace_path and
 * marks the goal 'waiting').
 */
export function drainSessions(liveGoalIds: string[], persist: (goalId: string) => void): void {
  logger.info({ count: liveGoalIds.length }, 'drain: persisting resume state before shutdown');
  for (const goalId of liveGoalIds) {
    try { persist(goalId); }
    catch (err) { logger.error({ err, goalId }, 'drain: failed to persist resume state'); }
  }
}
```

**Step 3 — run** `npm test -- drain` → PASS. **Commit:** `feat(5D): graceful-drain step persists resume state before kill`.

**Self-review:** Per-goal try/catch so one failure doesn't block the drain. Pure + injected persist → testable. Task 16 wires it into `shutdown()` *before* `killAll()`.

---

## Task 15 — Mark-active-as-waiting on persist + boot housekeeping helper

**Goal:** A small service method that, given a goal id, persists resume state AND flips the goal to `waiting` (so on next boot the reconciliation query — which looks at `active`/`waiting` — still matches it, and the UI shows it as resumable rather than falsely "running"). Plus a helper to mark a session resumable on boot.

**Files:**
- Modify: `server/services/session-service.ts` (add `markDrained(goalId, state)` convenience that combines `recordResumeState` + goal status) — OR keep status changes in `goal-service` and compose in Task 16. **Decision: keep services single-responsibility; compose in Task 16.** This task instead adds a focused unit: `buildResumeContext(orphan)` that produces the `SpawnContext`-shaped object the adapter needs.

**Files (revised):**
- Create: `server/resume-context.ts`
- Test: `tests/server/resume-context.test.ts`

**Step 1 — failing test** `tests/server/resume-context.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildResumeContext } from '../../server/resume-context';
import type { Orphan } from '../../server/services/reconciliation-service';

const orphan: Orphan = {
  goalId: 'g1', sessionId: 'g1', providerSessionId: 'g1',
  workspacePath: 'C:/wt/g1', model: 'sonnet', cwd: 'C:/repo', permissionMode: 'autonomous',
};

it('prefers workspacePath over cwd for the resume cwd', () => {
  const ctx = buildResumeContext(orphan, null);
  expect(ctx.cwd).toBe('C:/wt/g1');
  expect(ctx.goalId).toBe('g1');
  expect(ctx.model).toBe('sonnet');
  expect(ctx.permissionMode).toBe('autonomous');
});

it('falls back to goal cwd when no workspace was provisioned', () => {
  const ctx = buildResumeContext({ ...orphan, workspacePath: null }, null);
  expect(ctx.cwd).toBe('C:/repo');
});

it('passes through the mcp descriptor', () => {
  const mcp = { name: 'claude-deck', command: 'node', args: ['x'], env: {} };
  const ctx = buildResumeContext(orphan, mcp);
  expect(ctx.mcpServer).toBe(mcp);
});
```

**Step 2 — implement** `server/resume-context.ts`:

```ts
import type { Orphan } from './services/reconciliation-service';
import type { SpawnContext, McpServerDescriptor } from '../src/shared/agents/types';

/**
 * Builds the SpawnContext an adapter.buildResumeArgs(sessionId, ctx) needs from
 * an orphaned session (5D). Resumes in the recorded workspace path when present
 * so the agent reattaches to its isolated worktree, not the project root.
 */
export function buildResumeContext(orphan: Orphan, mcpServer: McpServerDescriptor | null): SpawnContext {
  return {
    goalId: orphan.goalId,
    model: orphan.model ?? 'default',
    cwd: orphan.workspacePath ?? orphan.cwd,
    permissionMode: orphan.permissionMode,
    mcpServer,
  };
}
```

**Step 3 — run** `npm test -- resume-context` → PASS. **Commit:** `feat(5D): buildResumeContext (Orphan → SpawnContext, workspace-aware)`.

**Self-review:** Returns the exact `SpawnContext` shape from the locked Phase 1 contract (`src/shared/agents/types.ts`). Workspace-aware cwd is the key correctness point: resume lands in the worktree.

---

## Task 16 — Final wiring in `server/index.ts` + Self-Review of integration

**Goal:** Compose everything into the running server: construct the new services, mount the projects router, provision workspaces on spawn, persist resume state, drain on shutdown, and reconcile + resume on boot. This is the only task that touches the live `index.ts` lifecycle.

**Files:**
- Modify: `server/index.ts`
- Test: `tests/server/services/boot-reconcile.integration.test.ts` (integration over services, no real PTY)

**Step 1 — failing integration test** `tests/server/services/boot-reconcile.integration.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeMigratedDb } from '../helpers/db-fixture';
import { createReconciliationService } from '../../../server/services/reconciliation-service';
import { resumeOrphans } from '../../../server/resume-driver';
import type Database from 'better-sqlite3';

vi.mock('../../../server/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

let db: Database.Database;
beforeEach(() => { db = makeMigratedDb(); });
afterEach(() => db.close());

it('boot path: orphan detected then resumed via driver', () => {
  db.prepare(`INSERT INTO goals (id,title,description,cwd,status,priority,tags,current_session_id,permission_mode,model,initial_prompt,kanban_order,created_at,updated_at,completed_at,project_id)
              VALUES ('g1','T',NULL,'C:/repo','active',0,'[]','g1','autonomous','sonnet',NULL,0,1,1,NULL,NULL)`).run();
  db.prepare(`INSERT INTO sessions (id,goal_id,origin,started_at,ended_at,provider_session_id,workspace_path)
              VALUES ('g1','g1','dashboard',1,NULL,'g1','C:/wt/g1')`).run();

  const recon = createReconciliationService(db);
  const orphans = recon.findOrphans(() => false); // nothing live after a restart
  expect(orphans).toHaveLength(1);

  const resumed: string[] = [];
  resumeOrphans(orphans, { canResume: () => true, resume: (o) => resumed.push(o.goalId) });
  expect(resumed).toEqual(['g1']);
});
```

**Step 2 — wire `index.ts`.** Apply these edits (each is small; keep them surgical):

1. **Imports** (top of file):

```ts
import { createProjectService } from './services/project-service';
import { createProjectsRouter } from './routes/projects';
import { createWorkspaceService } from './services/workspace-service';
import { createReconciliationService } from './services/reconciliation-service';
import { resumeOrphans } from './resume-driver';
import { buildResumeContext } from './resume-context';
import { drainSessions } from './drain';
```

2. **Construct services** (in the "Initialize services" block):

```ts
const projectService = createProjectService(db);
const workspaceService = createWorkspaceService(db, projectService);
const reconciliationService = createReconciliationService(db);
```

   Pass `projectService` into goal-service: `const goalService = createGoalService(db, projectService);`

3. **Provision workspace + record resume state in `spawnTerminalSession`.** After `goalService.update(goalId, { status: 'active' })` / `setCurrentSession`, before constructing `PtyManager`:

```ts
  const workspace = workspaceService.provision(goalId);
  const cwdOverride = workspace?.worktree_path;
  // record durable resume state (Claude: providerSessionId == goalId)
  sessionService.recordResumeState(goalId, {
    providerSessionId: goalId,
    workspacePath: cwdOverride ?? goal.cwd,
  });
```

   Pass `cwdOverride` into the `PtyManager` options: `new PtyManager(goal, { broadcast, cwdOverride, onExit(...){...}, onReady(){...} })`.

4. **Mount the projects router** in the `createApp({ apiRouters: [...] })` array, and pass `workspaceService` into the goals router:

```ts
const projectsRouter = createProjectsRouter(projectService);
const goalsRouter = createGoalsRouter(goalService, spawnTerminalSession, interGoalMessageService, workspaceService);
// ...
const app = createApp({ apiRouters: [scheduledRouter, goalsRouter, projectsRouter, sessionsRouter, hooksRouter, approvalsRouter, systemRouterWithSkills, skillsRouter] });
```

5. **Resume-on-boot** — after `server.listen(...)` (so routes/WS are ready), add:

```ts
// 5D: reconcile orphaned sessions and resume them.
try {
  const isLive = (goalId: string) => processRegistry.has(goalId);
  const orphans = reconciliationService.findOrphans(isLive);
  resumeOrphans(orphans, {
    // Claude can always resume today; post-Phase-1 read adapter.capabilities.canResume.
    canResume: () => true,
    resume: (o) => {
      // buildResumeContext(o, mcpDescriptor) is available for adapter.buildResumeArgs once Phase 1 lands.
      void buildResumeContext(o, null);
      restartSession(o.sessionId, o.goalId);
    },
  });
  if (orphans.length > 0) logger.info({ count: orphans.length }, 'Boot reconciliation: resumed orphaned sessions');
} catch (err) {
  logger.error({ err }, 'Boot reconciliation failed');
}
```

6. **Graceful drain** — in `shutdown()`, *before* `processRegistry.killAll()`:

```ts
  // 5D: persist resume state for live sessions before killing them.
  const liveGoalIds = Array.from({ length: 0 }) as string[]; // replaced below
  // The registry doesn't expose its keys publicly; iterate the goals we know are running.
  drainSessions(
    db.prepare(`SELECT id FROM goals WHERE status IN ('active','waiting') AND current_session_id IS NOT NULL`).all().map((r) => (r as { id: string }).id),
    (goalId) => {
      const ws = workspaceService.get(goalId);
      const goal = goalService.get(goalId);
      sessionService.recordResumeState(goalId, {
        providerSessionId: goalId,
        workspacePath: ws?.worktree_path ?? goal?.cwd ?? null,
      });
      goalService.update(goalId, { status: 'waiting' });
    },
  );
```

   (Drop the dead `liveGoalIds` placeholder line — it's there only to flag that the registry key list comes from the DB query.)

**Step 3 — run** the full suite: `npm test` and `npm run typecheck`. Expect green (0 new failures vs the Phase 0 baseline noted in the roadmap). **Commit:** `feat(5): wire project registry, workspace isolation, and session survivability into server lifecycle`.

**Self-review (integration):**
- **5A:** `/api/projects` mounted; goals link + inherit defaults; `isPathAllowed` exported for Phase 0B to import (`createProjectService(db).isPathAllowed` or `isPathAllowedAgainst`).
- **5B:** spawn provisions a workspace and runs the PTY there (`cwdOverride`); `/diff` + `/pr` live; card + Goal Detail show branch/dirty/diff.
- **5D:** spawn records resume state; shutdown drains (persist + mark waiting) before kill; boot reconciles orphans and resumes via the (Claude-fallback) driver, ready to swap to `adapter.buildResumeArgs` when Phase 1 lands.
- **No PTY reattach attempted** — resume-on-boot only, per scope.
- **Windows/quoting:** all git via `execFileSync` arg-arrays; `safe.directory` marked per worktree.

---

## Final Self-Review (whole plan)

**Coverage of the subsystem ask:**
- 5A Project Registry → Tasks 1–4 (migration 021, `ProjectService` with `isPathAllowed`, `/api/projects` CRUD, goal linkage). ✅
- 5B Workspace isolation + diff review → Tasks 5–10 (migration 022, `WorkspaceService` provision/diff/PR, spawn-in-workspace, `/diff` + `/pr` endpoints, KanbanCard badge, Goal Detail DiffView). ✅
- 5D Session survivability → Tasks 11–16 (resume-state persistence, reconciliation, resume driver, graceful drain, resume-context builder, lifecycle wiring). ✅

**Locked contracts honored:** `SpawnContext` consumed verbatim (Task 15). `adapter.buildResumeArgs(sessionId, ctx)` + `capabilities.canResume` are the injection points in Tasks 13/16, with a Claude fallback so the plan ships independently of the Phase 1 merge. **`isPathAllowed` is the coordinated helper name** Phase 0B imports (Task 2). Provider config from ConfigService is *not* needed by this subsystem directly (it's an adapter concern); the only cross-dependency is the resume capability flag, which is injected.

**Migrations:** 021 (`projects` + `goals.project_id`), 022 (`goal_workspace` + `sessions.provider_session_id`/`workspace_path`). Bump in lockstep if a higher number already exists at execution time.

**Risks called out inline:** (1) `git diff --no-index` for untracked files is brittle on Windows — tests pin the reliable tracked-file path; (2) PR creation needs a live remote/`gh` — not unit-tested against the network, only the degradation path; (3) `processRegistry` exposes no public key list, so drain derives live goals from the DB (`active`/`waiting` + `current_session_id`); (4) Phase 1 not-yet-merged → resume uses the Claude `restartSession` fallback, swappable to the adapter later without schema change.

**Not in scope (deferred to sibling Phase 5 plans):** 5C verification gate (`doneCommand` is *stored* here but not *executed*), 5E budget/quota, 5F write attribution. The `done_command` column is provisioned now so 5C needs no migration.
