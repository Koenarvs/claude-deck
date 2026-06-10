# Governance Guardrails (Phase 5 governance half) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep autonomous, multi-provider Claude Deck work safe and measurable by adding a verification gate on "complete" (5C), budget/quota guardrails with quota-aware routing (5E), and shared-markdown write attribution (5F).

**Architecture:** Three independent services wired behind existing seams. (5C) A `VerificationService` runs a per-goal/per-project `doneCommand` when a goal's PTY exits, records pass/fail + output in `verification_results` (migration 023), and surfaces results on the KanbanCard + a model-scorecard endpoint. (5E) A `BudgetService` reads per-provider/per-goal/per-day caps from the provider config records (Phase 1 delta B `budget` field), pauses sessions on the metered profile, raises burn-rate alarms, honors a global kill switch, and enforces per-provider concurrency — backed by `budget_state` (migration 024); a `QuotaRouter` helper consults Phase 2 `window-utilization` to recommend a cooler provider (advisory by default, opt-in auto). (5F) A `DocWriter` write-wrapper does last-write-wins conflict detection (mtime+hash) and stamps an attribution trailer on shared goal docs.

**Tech Stack:** TypeScript 5.5 (strict), Express v5, better-sqlite3 (WAL), Zod, node-cron, Pino, React 19, Vitest. Node 24.

---

## Spec preamble

### What this builds (and why)

This is the **governance half of Phase 5** from `docs/superpowers/plans/2026-06-09-master-roadmap.md` (§"Phase 5", items 5C/5E/5F; cross-cutting decisions §2.5 efficiency, §2.7 scorecard). The other half (5A registry, 5B isolation/diff, 5D survivability) ships separately and is a **prerequisite** for parts of this plan — see "Prerequisites & contracts" below.

Three features, each independent and separately testable:

- **5C Verification gate on "complete."** When a goal's agent finishes (its PTY exits), the server runs a `doneCommand` (typecheck/test) in the goal's workspace, records pass/fail + captured output to `verification_results`, broadcasts the result, surfaces a pass/fail chip on the KanbanCard, and exposes a per-model success-rate feed for the Phase 2 model scorecard. This turns "the agent says it's done" into evidence.
- **5E Budget/quota guardrails + quota-aware routing.** Per-goal and per-day USD caps that **pause** (interrupt) a running session on the **metered (work)** profile; a burn-rate alarm (tokens/min over threshold → flag); a global kill switch (refuse all new spawns + pause all running); per-provider concurrency limits. Then a `QuotaRouter` that, given a requested model, consults the seat window-utilization and recommends/auto-routes to a cooler provider ("Claude window hot → Codex"). Routing is **advisory by default**; an opt-in `autoRoute` flag enables auto-switching.
- **5F Shared-markdown write attribution.** Once 2+ agents can edit the same goal doc (`handoff.md`, `plan.md`, etc.), a `DocWriter` wrapper does last-write-wins conflict detection (records mtime+hash at read; rejects/flags a write whose base hash no longer matches disk) and stamps a trailer (`— written by goal-42/codex @ ISO8601`) so every edit is attributable.

### Prerequisites & contracts (LOCKED — do not redefine)

These come from other phases. **Code defensively against their absence** (feature-detect tables/columns/config fields; degrade to a safe default) so this plan can land and be tested even if a prerequisite ships slightly later. Each task below shows the exact feature-detect.

- **Phase 1 delta B — provider config records.** `PersistedConfig` carries a `providers` array; each record may carry `budget?: { dailyUsd?: number; monthlyUsd?: number; perGoalUsd?: number }` and `billingMode: 'metered' | 'seat'`. The working branch currently only has `enabledProviders: string[]` (see `.claude/worktrees/multi-agent-impl/server/services/config-service.ts`). **5E reads `providers[].budget` and `providers[].billingMode` via a thin accessor that falls back to "no caps, seat mode" when the richer shape is absent.**
- **Phase 2 — `GET /api/analytics/window-utilization`.** Returns per-provider seat window utilization (an estimate). **Does not yet exist on the working branch.** 5E's `QuotaRouter` calls it via an injected `fetchWindowUtilization` function so it is testable with a stub and degrades to "no recommendation" when the endpoint 404s. Phase 2 also provides per-goal cost (goal↔session linkage already in `sessions.goal_id`).
- **Phase 5A — Project Registry.** Provides per-project defaults including `doneCommand` and `worktreeRoot`. **Not yet on the working branch.** 5C reads the `doneCommand` via an injected `resolveDoneCommand(goal)` resolver; when the registry is absent, it falls back to the goal's `cwd` + a config-level default command (empty = "no verification, record `skipped`").
- **Phase 5B — Goal worktree.** Provides the goal's worktree path to run `doneCommand` in. 5C runs the command in `resolveWorkspace(goal)` which returns the worktree path when present, else `goal.cwd`.
- **Phase 0A — model registry** (`src/shared/agents/model-registry.ts`, `resolveModel`): cost numbers + provider id per model. 5E's burn-rate + scorecard use it to attribute per-model. Already specified in Phase 0A; this plan imports `resolveModel` and degrades if a model is unknown.

### Migrations used

This plan introduces exactly two migrations, matching the scope:

- **`023_verification_results.sql`** — the `verification_results` table (5C).
- **`024_budget_state.sql`** — the `budget_state` table + the global kill-switch row (5E).

Numbers 015–022 are reserved by earlier phases (015 `app_config` already exists on the sibling branch; 016 provider config; 017–022 span Phase 2 analytics, Phase 4 stubs, and Phase 5A/5B). This plan does **not** create them. The migration runner (`server/db/migrate.ts`) applies `.sql` files in lexical order and records versions in `schema_migrations`; 023/024 sort after any 0xx prerequisite and are idempotent (`CREATE TABLE IF NOT EXISTS`).

### File structure (created / modified)

**5C — Verification gate**
- Create: `server/db/migrations/023_verification_results.sql`
- Create: `server/services/verification-service.ts` — runs doneCommand, records results, exposes queries.
- Create: `server/routes/verification.ts` — `GET /api/goals/:id/verification`, `GET /api/analytics/model-scorecard`.
- Modify: `server/index.ts` — instantiate service, wire into the PTY `onExit` callbacks, mount router.
- Create: `src/components/kanban/VerificationChip.tsx` — pass/fail/running chip.
- Modify: `src/components/kanban/KanbanCard.tsx` — render the chip.
- Modify: `src/shared/events.ts` — `verification:updated` event.
- Modify: `src/shared/types.ts` — `VerificationResult`, `VerificationStatus`, `ModelScorecardRow`.
- Tests: `tests/server/services/verification-service.test.ts`, `tests/server/routes/verification.test.ts`, `tests/client/components/VerificationChip.test.tsx`.

**5E — Budget/quota guardrails + routing**
- Create: `server/db/migrations/024_budget_state.sql`
- Create: `server/services/budget-config.ts` — accessor over provider config (caps, billingMode, concurrency, killSwitch) with safe fallbacks.
- Create: `server/services/budget-service.ts` — spend accounting, cap evaluation, burn-rate, kill switch, concurrency.
- Create: `server/services/quota-router.ts` — pure routing helper over window-utilization.
- Create: `server/routes/budget.ts` — `GET /api/budget/status`, `POST /api/budget/kill-switch`, `GET /api/routing/recommendation`.
- Modify: `server/index.ts` — instantiate, enforce on spawn + on a periodic monitor, mount router.
- Modify: `src/shared/types.ts` — `BudgetStatus`, `RoutingRecommendation`.
- Tests: `tests/server/services/budget-config.test.ts`, `tests/server/services/budget-service.test.ts`, `tests/server/services/quota-router.test.ts`, `tests/server/routes/budget.test.ts`.

**5F — Shared-markdown attribution**
- Create: `server/services/doc-writer.ts` — read-with-base-hash, write-with-conflict-check, attribution stamping.
- Modify: `server/routes/system.ts` — add `POST /api/goals/:id/document` (attributed write) next to the existing GET document routes.
- Modify: `src/shared/types.ts` — `DocWriteResult`.
- Tests: `tests/server/services/doc-writer.test.ts`.

---

## Task 1: Migration 023 — `verification_results` table

**Files:**
- Create: `server/db/migrations/023_verification_results.sql`
- Test: `tests/server/db/verification-migration.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/server/db/verification-migration.test.ts`
```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';

describe('migration 023 verification_results', () => {
  it('creates the verification_results table with the expected columns', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const cols = db.pragma('table_info(verification_results)') as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    for (const c of ['id', 'goal_id', 'session_id', 'status', 'command', 'workspace', 'exit_code', 'output', 'duration_ms', 'model', 'created_at']) {
      expect(names.has(c)).toBe(true);
    }
    db.close();
  });

  it('records version 23 in schema_migrations', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const row = db.prepare('SELECT version FROM schema_migrations WHERE version = 23').get();
    expect(row).toBeTruthy();
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/db/verification-migration.test.ts`
Expected: FAIL — `no such table: verification_results`.

- [ ] **Step 3: Write the migration**

`server/db/migrations/023_verification_results.sql`
```sql
-- 5C Verification gate: per-goal/per-session doneCommand outcomes.
CREATE TABLE IF NOT EXISTS verification_results (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'error', 'skipped', 'running')),
  command TEXT,
  workspace TEXT,
  exit_code INTEGER,
  output TEXT,             -- captured stdout+stderr, truncated to 16k chars by the service
  duration_ms INTEGER,
  model TEXT,              -- per-goal model at completion (for the scorecard)
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_verification_goal_created ON verification_results (goal_id, created_at);
CREATE INDEX IF NOT EXISTS idx_verification_status_model ON verification_results (status, model);

INSERT OR IGNORE INTO schema_migrations (version) VALUES (23);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/db/verification-migration.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add server/db/migrations/023_verification_results.sql tests/server/db/verification-migration.test.ts
git commit -m "feat(5C): add verification_results table (migration 023)"
```

---

## Task 2: Shared types & events for verification

**Files:**
- Modify: `src/shared/types.ts` (append the verification types)
- Modify: `src/shared/events.ts` (append the event)
- Test: `tests/server/services/verification-types.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/server/services/verification-types.test.ts`
```ts
import { describe, it, expect } from 'vitest';
import type { VerificationResult, VerificationStatus, ModelScorecardRow } from '../../../src/shared/types';

describe('verification shared types', () => {
  it('shapes a VerificationResult', () => {
    const r: VerificationResult = {
      id: 'v1', goal_id: 'g1', session_id: 's1', status: 'pass',
      command: 'npm test', workspace: '/repo', exit_code: 0, output: 'ok',
      duration_ms: 1200, model: 'opus', created_at: 1,
    };
    const status: VerificationStatus = r.status;
    expect(status).toBe('pass');
  });

  it('shapes a ModelScorecardRow', () => {
    const row: ModelScorecardRow = { model: 'opus', total: 10, pass: 7, fail: 2, error: 1, passRate: 0.7 };
    expect(row.passRate).toBeCloseTo(0.7);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/services/verification-types.test.ts`
Expected: FAIL — type imports do not exist (tsc error / test cannot compile).

- [ ] **Step 3: Add the types and event**

Append to `src/shared/types.ts`:
```ts
// ── 5C Verification gate ─────────────────────────────────────────────────────

export type VerificationStatus = 'pass' | 'fail' | 'error' | 'skipped' | 'running';

export interface VerificationResult {
  id: string;
  goal_id: string;
  session_id: string | null;
  status: VerificationStatus;
  command: string | null;
  workspace: string | null;
  exit_code: number | null;
  output: string | null;
  duration_ms: number | null;
  model: string | null;
  created_at: number;
}

export interface ModelScorecardRow {
  model: string;
  total: number;
  pass: number;
  fail: number;
  error: number;
  /** pass / (pass + fail + error); 0 when no completed runs. */
  passRate: number;
}
```

Append to `src/shared/events.ts` (add to the `ServerEvent` union — locate the union and add this member):
```ts
  | { type: 'verification:updated'; goal_id: string; result: import('./types').VerificationResult }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/services/verification-types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/shared/events.ts tests/server/services/verification-types.test.ts
git commit -m "feat(5C): verification shared types + verification:updated event"
```

---

## Task 3: VerificationService — record helpers & queries

Build the service in two tasks: first the pure DB record/query layer (this task), then the command-running layer (Task 4) which is the side-effecting part.

**Files:**
- Create: `server/services/verification-service.ts`
- Test: `tests/server/services/verification-service.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/server/services/verification-service.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';
import { createVerificationService } from '../../../server/services/verification-service';

vi.mock('../../../server/ws', () => ({ broadcast: vi.fn() }));
vi.mock('../../../server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});
afterEach(() => db.close());

describe('VerificationService records & queries', () => {
  it('records a result and reads it back as the latest for a goal', () => {
    const svc = createVerificationService(db, { resolveDoneCommand: () => null, resolveWorkspace: (g) => g.cwd });
    const r = svc.record({
      goal_id: 'g1', session_id: 's1', status: 'pass',
      command: 'npm test', workspace: '/repo', exit_code: 0, output: 'ok',
      duration_ms: 100, model: 'opus',
    });
    expect(r.id).toBeTruthy();
    const latest = svc.latestForGoal('g1');
    expect(latest?.status).toBe('pass');
    expect(latest?.command).toBe('npm test');
  });

  it('truncates output to 16k characters', () => {
    const svc = createVerificationService(db, { resolveDoneCommand: () => null, resolveWorkspace: (g) => g.cwd });
    const big = 'x'.repeat(20_000);
    const r = svc.record({
      goal_id: 'g1', session_id: null, status: 'fail',
      command: 'npm test', workspace: '/repo', exit_code: 1, output: big,
      duration_ms: 100, model: null,
    });
    expect(r.output!.length).toBe(16_000);
  });

  it('computes a model scorecard (pass rate per model, ignoring skipped/running)', () => {
    const svc = createVerificationService(db, { resolveDoneCommand: () => null, resolveWorkspace: (g) => g.cwd });
    const base = { session_id: null, command: 'c', workspace: '/r', exit_code: 0, output: '', duration_ms: 1 };
    svc.record({ ...base, goal_id: 'g1', status: 'pass', model: 'opus' });
    svc.record({ ...base, goal_id: 'g2', status: 'pass', model: 'opus' });
    svc.record({ ...base, goal_id: 'g3', status: 'fail', model: 'opus' });
    svc.record({ ...base, goal_id: 'g4', status: 'skipped', model: 'opus' });
    svc.record({ ...base, goal_id: 'g5', status: 'pass', model: 'sonnet' });
    const card = svc.modelScorecard();
    const opus = card.find((r) => r.model === 'opus')!;
    expect(opus.total).toBe(3); // skipped excluded
    expect(opus.pass).toBe(2);
    expect(opus.fail).toBe(1);
    expect(opus.passRate).toBeCloseTo(2 / 3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/services/verification-service.test.ts`
Expected: FAIL — `Cannot find module '.../verification-service'`.

- [ ] **Step 3: Write the service (record/query layer only)**

`server/services/verification-service.ts`
```ts
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { Goal, VerificationResult, VerificationStatus, ModelScorecardRow } from '../../src/shared/types';
import { broadcast } from '../ws';
import logger from '../logger';

const MAX_OUTPUT_CHARS = 16_000;

/** Injected resolvers so 5A (Project Registry) and 5B (worktree) can supply real values later. */
export interface VerificationDeps {
  /** Returns the doneCommand for the goal, or null when none is configured (→ 'skipped'). */
  resolveDoneCommand: (goal: Goal) => string | null;
  /** Returns the directory to run the command in (worktree when present, else goal.cwd). */
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
  id: string; goal_id: string; session_id: string | null; status: string;
  command: string | null; workspace: string | null; exit_code: number | null;
  output: string | null; duration_ms: number | null; model: string | null; created_at: number;
}

function rowToResult(row: VerificationRow): VerificationResult {
  return {
    id: row.id, goal_id: row.goal_id, session_id: row.session_id,
    status: row.status as VerificationStatus, command: row.command, workspace: row.workspace,
    exit_code: row.exit_code, output: row.output, duration_ms: row.duration_ms,
    model: row.model, created_at: row.created_at,
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
      id, input.goal_id, input.session_id, input.status, input.command,
      input.workspace, input.exit_code, output, input.duration_ms, input.model, now,
    );
    const result: VerificationResult = {
      id, goal_id: input.goal_id, session_id: input.session_id, status: input.status,
      command: input.command, workspace: input.workspace, exit_code: input.exit_code,
      output, duration_ms: input.duration_ms, model: input.model, created_at: now,
    };
    broadcast({ type: 'verification:updated', goal_id: input.goal_id, result });
    return result;
  }

  function latestForGoal(goalId: string): VerificationResult | null {
    const row = latestStmt.get(goalId);
    return row ? rowToResult(row) : null;
  }

  function modelScorecard(): ModelScorecardRow[] {
    const rows = db.prepare(`
      SELECT COALESCE(model, 'unknown') as model,
        SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) as pass,
        SUM(CASE WHEN status = 'fail' THEN 1 ELSE 0 END) as fail,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error
      FROM verification_results
      WHERE status IN ('pass', 'fail', 'error')
      GROUP BY COALESCE(model, 'unknown')
      ORDER BY model
    `).all() as Array<{ model: string; pass: number; fail: number; error: number }>;
    return rows.map((r) => {
      const total = r.pass + r.fail + r.error;
      return { model: r.model, total, pass: r.pass, fail: r.fail, error: r.error,
        passRate: total > 0 ? r.pass / total : 0 };
    });
  }

  // runForGoal is added in Task 4.
  return { record, latestForGoal, modelScorecard, _deps: deps };
}

export type VerificationService = ReturnType<typeof createVerificationService>;
export { logger as _verificationLogger };
```

> Note: `_deps` and `_verificationLogger` are placeholders consumed by Task 4 (the command runner). They are exported now so Task 4 only adds, never rewrites.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/services/verification-service.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/verification-service.ts tests/server/services/verification-service.test.ts
git commit -m "feat(5C): VerificationService record + scorecard queries"
```

---

## Task 4: VerificationService — run the doneCommand on completion

**Files:**
- Modify: `server/services/verification-service.ts` (add `runForGoal`)
- Test: `tests/server/services/verification-service.test.ts` (append a describe block)

- [ ] **Step 1: Write the failing test (append to the existing file)**

Append to `tests/server/services/verification-service.test.ts`:
```ts
describe('VerificationService runForGoal', () => {
  const goal = { id: 'g1', cwd: process.cwd(), model: 'opus' } as unknown as import('../../../src/shared/types').Goal;

  it('records "skipped" when no doneCommand is configured', async () => {
    const svc = createVerificationService(db, { resolveDoneCommand: () => null, resolveWorkspace: (g) => g.cwd });
    const r = await svc.runForGoal(goal, 's1');
    expect(r.status).toBe('skipped');
    expect(r.command).toBeNull();
  });

  it('records "pass" when the command exits 0', async () => {
    const svc = createVerificationService(db, {
      resolveDoneCommand: () => 'node -e "process.exit(0)"',
      resolveWorkspace: (g) => g.cwd,
    });
    const r = await svc.runForGoal(goal, 's1');
    expect(r.status).toBe('pass');
    expect(r.exit_code).toBe(0);
    expect(r.model).toBe('opus');
  });

  it('records "fail" when the command exits non-zero and captures output', async () => {
    const svc = createVerificationService(db, {
      resolveDoneCommand: () => 'node -e "console.error(\'boom\'); process.exit(1)"',
      resolveWorkspace: (g) => g.cwd,
    });
    const r = await svc.runForGoal(goal, 's1');
    expect(r.status).toBe('fail');
    expect(r.exit_code).toBe(1);
    expect(r.output).toContain('boom');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/services/verification-service.test.ts`
Expected: FAIL — `svc.runForGoal is not a function`.

- [ ] **Step 3: Implement `runForGoal`**

In `server/services/verification-service.ts`, add this import near the top:
```ts
import { spawn } from 'node:child_process';
```

Then add the function inside `createVerificationService`, before the `return` statement, and include `runForGoal` in the returned object:
```ts
  /**
   * Resolves the goal's doneCommand + workspace, runs it, and records the outcome.
   * No doneCommand → records 'skipped'. Spawn failure → 'error'. Exit 0 → 'pass', else 'fail'.
   * Output (stdout+stderr) is captured and truncated by record().
   */
  function runForGoal(goal: Goal, sessionId: string | null): Promise<VerificationResult> {
    const command = deps.resolveDoneCommand(goal);
    const workspace = deps.resolveWorkspace(goal);
    const model = goal.model ?? null;

    if (!command || command.trim() === '') {
      logger.info({ goalId: goal.id }, 'Verification skipped — no doneCommand');
      return Promise.resolve(record({
        goal_id: goal.id, session_id: sessionId, status: 'skipped',
        command: null, workspace, exit_code: null, output: null, duration_ms: null, model,
      }));
    }

    const startedAt = Date.now();
    return new Promise<VerificationResult>((resolve) => {
      let stdout = '';
      let settled = false;
      const finish = (status: VerificationStatus, exitCode: number | null, extra = '') => {
        if (settled) return;
        settled = true;
        resolve(record({
          goal_id: goal.id, session_id: sessionId, status,
          command, workspace, exit_code: exitCode,
          output: (stdout + extra) || null, duration_ms: Date.now() - startedAt, model,
        }));
      };

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(command, { cwd: workspace, shell: true });
      } catch (err) {
        logger.error({ err, goalId: goal.id }, 'Verification spawn threw');
        finish('error', null, String(err));
        return;
      }

      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.on('error', (err) => {
        logger.error({ err, goalId: goal.id }, 'Verification process error');
        finish('error', null, String(err));
      });
      child.on('close', (code) => {
        finish(code === 0 ? 'pass' : 'fail', code);
      });

      // Hard timeout: 10 minutes, then kill and record 'error'.
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        finish('error', null, '\n[verification timed out after 600s]');
      }, 600_000);
      timer.unref();
    });
  }
```

Change the `return` line to include `runForGoal`:
```ts
  return { record, latestForGoal, modelScorecard, runForGoal, _deps: deps };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/services/verification-service.test.ts`
Expected: PASS (6 tests total).

- [ ] **Step 5: Commit**

```bash
git add server/services/verification-service.ts tests/server/services/verification-service.test.ts
git commit -m "feat(5C): VerificationService runs doneCommand and records pass/fail"
```

---

## Task 5: Verification routes — goal detail + model scorecard

**Files:**
- Create: `server/routes/verification.ts`
- Test: `tests/server/routes/verification.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/server/routes/verification.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';
import { createVerificationService } from '../../../server/services/verification-service';
import { createVerificationRouter } from '../../../server/routes/verification';

vi.mock('../../../server/ws', () => ({ broadcast: vi.fn() }));
vi.mock('../../../server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let db: Database.Database;
let app: express.Express;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  const svc = createVerificationService(db, { resolveDoneCommand: () => null, resolveWorkspace: (g) => g.cwd });
  svc.record({ goal_id: 'g1', session_id: 's1', status: 'pass', command: 'npm test', workspace: '/r', exit_code: 0, output: 'ok', duration_ms: 1, model: 'opus' });
  svc.record({ goal_id: 'g2', session_id: 's2', status: 'fail', command: 'npm test', workspace: '/r', exit_code: 1, output: 'bad', duration_ms: 1, model: 'sonnet' });
  app = express();
  app.use('/api', createVerificationRouter(svc));
});
afterEach(() => db.close());

describe('verification routes', () => {
  it('GET /api/goals/:id/verification returns the latest result', async () => {
    const res = await request(app).get('/api/goals/g1/verification');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pass');
  });

  it('GET /api/goals/:id/verification returns 404 when none', async () => {
    const res = await request(app).get('/api/goals/nope/verification');
    expect(res.status).toBe(404);
  });

  it('GET /api/analytics/model-scorecard returns per-model pass rates', async () => {
    const res = await request(app).get('/api/analytics/model-scorecard');
    expect(res.status).toBe(200);
    const opus = res.body.find((r: { model: string }) => r.model === 'opus');
    expect(opus.passRate).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/routes/verification.test.ts`
Expected: FAIL — `Cannot find module '.../routes/verification'`.

- [ ] **Step 3: Write the router**

`server/routes/verification.ts`
```ts
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { VerificationService } from '../services/verification-service';
import logger from '../logger';

/**
 * Verification routes (5C).
 * - GET /api/goals/:id/verification     → latest VerificationResult for a goal (404 if none).
 * - GET /api/analytics/model-scorecard  → per-model pass/fail/error + passRate (Phase 2 scorecard feed).
 */
export function createVerificationRouter(service: VerificationService): Router {
  const router = Router();

  router.get('/goals/:id/verification', (req: Request, res: Response) => {
    try {
      const result = service.latestForGoal(String(req.params['id']));
      if (!result) { res.status(404).json({ error: 'No verification result for goal' }); return; }
      res.json(result);
    } catch (err) {
      logger.error({ err }, 'Failed to get verification result');
      res.status(500).json({ error: 'Failed to get verification result' });
    }
  });

  router.get('/analytics/model-scorecard', (_req: Request, res: Response) => {
    try {
      res.json(service.modelScorecard());
    } catch (err) {
      logger.error({ err }, 'Failed to compute model scorecard');
      res.status(500).json({ error: 'Failed to compute model scorecard' });
    }
  });

  return router;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/routes/verification.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/routes/verification.ts tests/server/routes/verification.test.ts
git commit -m "feat(5C): verification routes — goal detail + model scorecard"
```

---

## Task 6: Wire verification into the server (PTY onExit + router mount)

**Files:**
- Modify: `server/index.ts`
- Test: `tests/server/services/verification-wiring.test.ts`

> The two `onExit` callbacks in `index.ts` (`spawnTerminalSession` and `restartSession`) are where a goal's PTY ends. We run verification there. The default `resolveDoneCommand`/`resolveWorkspace` use a config-level default command and `goal.cwd`; Phase 5A/5B replace these resolvers with registry/worktree-backed ones later (single call site).

- [ ] **Step 1: Write the failing test**

`tests/server/services/verification-wiring.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';
import { createVerificationService } from '../../../server/services/verification-service';
import { defaultVerificationDeps } from '../../../server/verification-deps';

vi.mock('../../../server/ws', () => ({ broadcast: vi.fn() }));
vi.mock('../../../server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); runMigrations(db); });
afterEach(() => db.close());

describe('defaultVerificationDeps', () => {
  it('resolveWorkspace falls back to goal.cwd when no worktree resolver', () => {
    const deps = defaultVerificationDeps({ defaultDoneCommand: '' });
    const goal = { id: 'g1', cwd: '/repo', model: 'opus' } as unknown as import('../../../src/shared/types').Goal;
    expect(deps.resolveWorkspace(goal)).toBe('/repo');
  });

  it('resolveDoneCommand returns the config default when set', () => {
    const deps = defaultVerificationDeps({ defaultDoneCommand: 'npm run typecheck' });
    const goal = { id: 'g1', cwd: '/repo', model: 'opus' } as unknown as import('../../../src/shared/types').Goal;
    expect(deps.resolveDoneCommand(goal)).toBe('npm run typecheck');
  });

  it('resolveDoneCommand returns null when default is empty', () => {
    const deps = defaultVerificationDeps({ defaultDoneCommand: '' });
    const goal = { id: 'g1', cwd: '/repo', model: 'opus' } as unknown as import('../../../src/shared/types').Goal;
    expect(deps.resolveDoneCommand(goal)).toBeNull();
  });

  it('uses injected registry/worktree resolvers when provided', () => {
    const deps = defaultVerificationDeps({
      defaultDoneCommand: '',
      projectDoneCommand: () => 'pytest',
      worktreePath: () => '/repo/.wt/g1',
    });
    const goal = { id: 'g1', cwd: '/repo', model: 'opus' } as unknown as import('../../../src/shared/types').Goal;
    expect(deps.resolveDoneCommand(goal)).toBe('pytest');
    expect(deps.resolveWorkspace(goal)).toBe('/repo/.wt/g1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/services/verification-wiring.test.ts`
Expected: FAIL — `Cannot find module '.../server/verification-deps'`.

- [ ] **Step 3: Create the resolver factory**

`server/verification-deps.ts`
```ts
import type { Goal } from '../src/shared/types';
import type { VerificationDeps } from './services/verification-service';

export interface DefaultVerificationDepsOptions {
  /** Config-level fallback doneCommand. Empty string → no verification (records 'skipped'). */
  defaultDoneCommand: string;
  /** Phase 5A hook: per-project doneCommand resolver. Takes precedence over the default. */
  projectDoneCommand?: (goal: Goal) => string | null;
  /** Phase 5B hook: per-goal worktree path. When present, used instead of goal.cwd. */
  worktreePath?: (goal: Goal) => string | null;
}

/**
 * Builds VerificationDeps from config + optional Phase 5A/5B resolvers.
 * Precedence: projectDoneCommand → defaultDoneCommand → null.
 *             worktreePath → goal.cwd.
 */
export function defaultVerificationDeps(opts: DefaultVerificationDepsOptions): VerificationDeps {
  return {
    resolveDoneCommand: (goal) => {
      const fromProject = opts.projectDoneCommand?.(goal);
      if (fromProject && fromProject.trim() !== '') return fromProject;
      return opts.defaultDoneCommand.trim() !== '' ? opts.defaultDoneCommand : null;
    },
    resolveWorkspace: (goal) => {
      const wt = opts.worktreePath?.(goal);
      return wt && wt.trim() !== '' ? wt : goal.cwd;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/services/verification-wiring.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire into `server/index.ts`**

Add imports near the other service imports (after the `createGoalService` import, ~line 8):
```ts
import { createVerificationService } from './services/verification-service';
import { defaultVerificationDeps } from './verification-deps';
import { createVerificationRouter } from './routes/verification';
```

After `const goalService = createGoalService(db);` (~line 108) add:
```ts
const verificationService = createVerificationService(
  db,
  // Phase 5A/5B will pass projectDoneCommand/worktreePath here; for now config default + cwd.
  defaultVerificationDeps({ defaultDoneCommand: process.env['CLAUDE_DECK_DONE_COMMAND'] ?? '' }),
);
```

In `spawnTerminalSession`'s `onExit` callback, after `sessionService.end(gId);` add:
```ts
      const finished = goalService.get(gId);
      if (finished) {
        void verificationService.runForGoal(finished, gId).catch((err) => {
          logger.error({ err, goalId: gId }, 'Verification run failed');
        });
      }
```

Apply the **same** addition in `restartSession`'s `onExit` callback (same position, after `sessionService.end(gId);`).

Add the router to the `apiRouters` array in the `createApp(...)` call (~line 296):
```ts
const verificationRouter = createVerificationRouter(verificationService);
```
and include `verificationRouter` in the `apiRouters: [...]` list.

- [ ] **Step 6: Run the full server suite + typecheck**

Run: `npx vitest run tests/server` then `npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add server/index.ts server/verification-deps.ts tests/server/services/verification-wiring.test.ts
git commit -m "feat(5C): run verification on PTY exit + mount verification router"
```

---

## Task 7: KanbanCard verification chip

**Files:**
- Create: `src/components/kanban/VerificationChip.tsx`
- Modify: `src/components/kanban/KanbanCard.tsx`
- Test: `tests/client/components/VerificationChip.test.tsx`

- [ ] **Step 1: Write the failing test**

`tests/client/components/VerificationChip.test.tsx`
```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import VerificationChip from '../../../src/components/kanban/VerificationChip';
import type { VerificationResult } from '../../../src/shared/types';

function make(status: VerificationResult['status']): VerificationResult {
  return { id: 'v', goal_id: 'g', session_id: null, status, command: 'npm test',
    workspace: '/r', exit_code: status === 'pass' ? 0 : 1, output: null, duration_ms: 1, model: 'opus', created_at: 1 };
}

describe('VerificationChip', () => {
  it('renders nothing for skipped', () => {
    const { container } = render(<VerificationChip result={make('skipped')} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a pass label', () => {
    render(<VerificationChip result={make('pass')} />);
    expect(screen.getByText(/verified/i)).toBeInTheDocument();
  });

  it('renders a fail label', () => {
    render(<VerificationChip result={make('fail')} />);
    expect(screen.getByText(/failed/i)).toBeInTheDocument();
  });

  it('renders nothing when result is null', () => {
    const { container } = render(<VerificationChip result={null} />);
    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/client/components/VerificationChip.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the component**

`src/components/kanban/VerificationChip.tsx`
```tsx
import { CheckCircle2, XCircle, AlertTriangle, Loader2 } from 'lucide-react';
import type { VerificationResult } from '../../shared/types';

interface Props {
  result: VerificationResult | null;
}

/**
 * Pass/fail/error/running chip for a goal's latest verification result.
 * Renders nothing for 'skipped' or a null result (no doneCommand configured).
 */
export default function VerificationChip({ result }: Props) {
  if (!result || result.status === 'skipped') return null;

  if (result.status === 'pass') {
    return (
      <span className="mono-tabular inline-flex items-center gap-0.5 rounded-sm bg-ok-soft px-1.5 py-0.5 text-[10px] font-semibold text-ok" title={result.command ?? ''}>
        <CheckCircle2 size={9} /> Verified
      </span>
    );
  }
  if (result.status === 'running') {
    return (
      <span className="mono-tabular inline-flex items-center gap-0.5 rounded-sm bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold text-accent">
        <Loader2 size={9} className="animate-spin" /> Verifying
      </span>
    );
  }
  const isError = result.status === 'error';
  return (
    <span
      className="mono-tabular inline-flex items-center gap-0.5 rounded-sm bg-danger/20 px-1.5 py-0.5 text-[10px] font-semibold text-danger"
      title={result.output?.slice(0, 200) ?? result.command ?? ''}
    >
      {isError ? <AlertTriangle size={9} /> : <XCircle size={9} />}
      {isError ? 'Verify error' : 'Failed'}
    </span>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/client/components/VerificationChip.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire the chip into KanbanCard**

In `src/components/kanban/KanbanCard.tsx`, add the import after the format import (~line 9):
```tsx
import VerificationChip from './VerificationChip';
import type { VerificationResult } from '../../shared/types';
```

Add state next to `stats` (~line 54):
```tsx
  const [verification, setVerification] = useState<VerificationResult | null>(null);
```

Inside the existing `load()` async function in the `useEffect` (~after stats are set, before the `catch`), add a fetch:
```tsx
        const verRes = await fetch(`/api/goals/${goal.id}/verification`);
        if (verRes.ok && !cancelled) {
          setVerification((await verRes.json()) as VerificationResult);
        }
```

Render the chip in the model+stats row, right after the model badge block (inside the `<div className="mt-2 flex items-center gap-1.5">`, after the `{goal.model && ...}` block, ~line 227):
```tsx
        <VerificationChip result={verification} />
```

- [ ] **Step 6: Run client tests + typecheck**

Run: `npx vitest run tests/client/components/KanbanCard.test.tsx tests/client/components/VerificationChip.test.tsx` then `npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/components/kanban/VerificationChip.tsx src/components/kanban/KanbanCard.tsx tests/client/components/VerificationChip.test.tsx
git commit -m "feat(5C): surface verification pass/fail chip on KanbanCard"
```

---

## Task 8: Migration 024 — `budget_state` table + kill switch

**Files:**
- Create: `server/db/migrations/024_budget_state.sql`
- Test: `tests/server/db/budget-migration.test.ts`

> `budget_state` is a small key/value-ish table for state that isn't derivable from `session_usage`: the global kill switch and per-provider/day spend snapshots used for fast cap checks. Per-goal/per-day **spend** is computed from `session_usage` (already linked to goals via `sessions.goal_id`); `budget_state` holds only the kill switch and an alarm log, keeping the source of truth single.

- [ ] **Step 1: Write the failing test**

`tests/server/db/budget-migration.test.ts`
```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';

describe('migration 024 budget_state', () => {
  it('creates budget_state with the expected columns', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const cols = db.pragma('table_info(budget_state)') as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    for (const c of ['key', 'value_json', 'updated_at']) expect(names.has(c)).toBe(true);
    db.close();
  });

  it('seeds the kill_switch row as off', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const row = db.prepare("SELECT value_json FROM budget_state WHERE key = 'kill_switch'").get() as { value_json: string } | undefined;
    expect(row).toBeTruthy();
    expect(JSON.parse(row!.value_json)).toEqual({ active: false });
    db.close();
  });

  it('records version 24', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(db.prepare('SELECT version FROM schema_migrations WHERE version = 24').get()).toBeTruthy();
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/db/budget-migration.test.ts`
Expected: FAIL — `no such table: budget_state`.

- [ ] **Step 3: Write the migration**

`server/db/migrations/024_budget_state.sql`
```sql
-- 5E Budget/quota guardrails: non-derivable state (kill switch, alarm log).
CREATE TABLE IF NOT EXISTS budget_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Global kill switch (off by default).
INSERT OR IGNORE INTO budget_state (key, value_json, updated_at)
VALUES ('kill_switch', '{"active":false}', unixepoch() * 1000);

INSERT OR IGNORE INTO schema_migrations (version) VALUES (24);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/db/budget-migration.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/db/migrations/024_budget_state.sql tests/server/db/budget-migration.test.ts
git commit -m "feat(5E): add budget_state table + kill switch (migration 024)"
```

---

## Task 9: BudgetConfig accessor (over provider config, with safe fallbacks)

**Files:**
- Create: `server/services/budget-config.ts`
- Modify: `src/shared/types.ts` (add `BudgetStatus`, `RoutingRecommendation`)
- Test: `tests/server/services/budget-config.test.ts`

> Phase 1 delta B's richer `providers[]` shape may not be on the working branch yet. This accessor takes a plain config object (whatever `ConfigService.getPersisted()` returns) and extracts caps/billingMode/concurrency defensively. It never imports `config-service` directly, so it works before or after that lands.

- [ ] **Step 1: Write the failing test**

`tests/server/services/budget-config.test.ts`
```ts
import { describe, it, expect } from 'vitest';
import { readBudgetConfig } from '../../../server/services/budget-config';

describe('readBudgetConfig', () => {
  it('returns safe defaults for the legacy enabledProviders shape', () => {
    const cfg = readBudgetConfig({ enabledProviders: ['claude'] });
    expect(cfg.providers.claude.billingMode).toBe('seat');
    expect(cfg.providers.claude.budget).toEqual({});
    expect(cfg.providers.claude.maxConcurrent).toBeNull();
  });

  it('extracts caps + billingMode from the rich providers shape', () => {
    const cfg = readBudgetConfig({
      providers: [
        { id: 'claude', enabled: true, billingMode: 'metered',
          budget: { dailyUsd: 50, perGoalUsd: 10 }, maxConcurrent: 2 },
        { id: 'codex', enabled: true, billingMode: 'seat' },
      ],
    });
    expect(cfg.providers.claude.billingMode).toBe('metered');
    expect(cfg.providers.claude.budget.dailyUsd).toBe(50);
    expect(cfg.providers.claude.budget.perGoalUsd).toBe(10);
    expect(cfg.providers.claude.maxConcurrent).toBe(2);
    expect(cfg.providers.codex.billingMode).toBe('seat');
  });

  it('reports whether any provider is metered (caps only matter for metered)', () => {
    expect(readBudgetConfig({ enabledProviders: ['claude'] }).anyMetered).toBe(false);
    expect(readBudgetConfig({ providers: [{ id: 'claude', enabled: true, billingMode: 'metered' }] }).anyMetered).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/services/budget-config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the accessor + types**

`server/services/budget-config.ts`
```ts
export interface ProviderBudget {
  dailyUsd?: number;
  monthlyUsd?: number;
  perGoalUsd?: number;
}

export interface ProviderBudgetConfig {
  billingMode: 'metered' | 'seat';
  budget: ProviderBudget;
  /** Max concurrent sessions for this provider; null = unlimited. */
  maxConcurrent: number | null;
}

export interface BudgetConfig {
  providers: Record<string, ProviderBudgetConfig>;
  anyMetered: boolean;
}

interface RichProvider {
  id: string;
  enabled?: boolean;
  billingMode?: 'metered' | 'seat';
  budget?: ProviderBudget;
  maxConcurrent?: number | null;
}

/**
 * Normalizes whatever the config service returns into a budget view.
 * Accepts both the legacy `{ enabledProviders: string[] }` and the Phase 1
 * delta B `{ providers: ProviderConfig[] }` shapes. Missing budget/billingMode
 * default to "no caps, seat mode" so callers never crash on a partial config.
 */
export function readBudgetConfig(cfg: unknown): BudgetConfig {
  const providers: Record<string, ProviderBudgetConfig> = {};
  const obj = (cfg ?? {}) as { providers?: RichProvider[]; enabledProviders?: string[] };

  if (Array.isArray(obj.providers)) {
    for (const p of obj.providers) {
      providers[p.id] = {
        billingMode: p.billingMode === 'metered' ? 'metered' : 'seat',
        budget: p.budget ?? {},
        maxConcurrent: typeof p.maxConcurrent === 'number' ? p.maxConcurrent : null,
      };
    }
  } else if (Array.isArray(obj.enabledProviders)) {
    for (const id of obj.enabledProviders) {
      providers[id] = { billingMode: 'seat', budget: {}, maxConcurrent: null };
    }
  }

  // Invariant: 'claude' always present.
  if (!providers['claude']) {
    providers['claude'] = { billingMode: 'seat', budget: {}, maxConcurrent: null };
  }

  const anyMetered = Object.values(providers).some((p) => p.billingMode === 'metered');
  return { providers, anyMetered };
}
```

Append to `src/shared/types.ts`:
```ts
// ── 5E Budget/quota guardrails ───────────────────────────────────────────────

export interface BudgetStatus {
  killSwitchActive: boolean;
  /** Per-provider spend today (USD) vs configured caps. */
  providers: Array<{
    id: string;
    billingMode: 'metered' | 'seat';
    spentTodayUsd: number;
    dailyCapUsd: number | null;
    overCap: boolean;
    activeSessions: number;
    maxConcurrent: number | null;
  }>;
  /** Goals paused by a cap or the kill switch since the last status read. */
  pausedGoalIds: string[];
}

export interface RoutingRecommendation {
  requestedModel: string;
  /** The provider the requested model belongs to. */
  requestedProvider: string;
  /** null = stay on the requested provider; otherwise the suggested provider id. */
  recommendedProvider: string | null;
  recommendedModel: string | null;
  reason: string;
  /** Whether auto-route applied the recommendation (true) or it is advisory (false). */
  applied: boolean;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/services/budget-config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/budget-config.ts src/shared/types.ts tests/server/services/budget-config.test.ts
git commit -m "feat(5E): budget config accessor + budget/routing shared types"
```

---

## Task 10: BudgetService — spend, caps, kill switch, concurrency, burn-rate

**Files:**
- Create: `server/services/budget-service.ts`
- Test: `tests/server/services/budget-service.test.ts`

> Per-goal/day spend is computed from `session_usage` joined to `sessions`→`goals`. The kill switch lives in `budget_state`. Cap evaluation only blocks **metered** providers (seat profiles never pause — decision §2.6). The service returns *decisions*; the caller (Task 11) performs the actual interrupt via `processRegistry`.

- [ ] **Step 1: Write the failing test**

`tests/server/services/budget-service.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';
import { createBudgetService } from '../../../server/services/budget-service';

vi.mock('../../../server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let db: Database.Database;

function seedGoalSpend(goalId: string, model: string, costUsd: number) {
  const now = Date.now();
  db.prepare(`INSERT INTO goals (id, title, cwd, status, kanban_order, created_at, updated_at)
              VALUES (?, ?, '/r', 'active', 1, ?, ?)`).run(goalId, goalId, now, now);
  db.prepare(`INSERT INTO sessions (id, goal_id, origin, model, started_at) VALUES (?, ?, 'dashboard', ?, ?)`)
    .run(`s-${goalId}`, goalId, model, now);
  db.prepare(`INSERT INTO session_usage
    (session_id, project_dir, model, input_tokens, cache_creation_tokens, cache_read_tokens, output_tokens, total_tokens, estimated_cost_usd, message_count, session_date, first_message_at, ingested_at)
    VALUES (?, 'p', ?, 0,0,0,0,0, ?, 1, date('now'), ?, ?)`)
    .run(`s-${goalId}`, model, costUsd, now, now);
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
});
afterEach(() => db.close());

describe('BudgetService', () => {
  it('kill switch toggles and is read back', () => {
    const svc = createBudgetService(db, () => ({ enabledProviders: ['claude'] }));
    expect(svc.isKillSwitchActive()).toBe(false);
    svc.setKillSwitch(true);
    expect(svc.isKillSwitchActive()).toBe(true);
  });

  it('blocks a new spawn when the kill switch is active', () => {
    const svc = createBudgetService(db, () => ({ enabledProviders: ['claude'] }));
    svc.setKillSwitch(true);
    const d = svc.evaluateSpawn({ goalId: 'g1', model: 'opus' });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/kill switch/i);
  });

  it('allows spawn on a seat provider even over a cap (caps are metered-only)', () => {
    seedGoalSpend('g1', 'opus', 999);
    const svc = createBudgetService(db, () => ({
      providers: [{ id: 'claude', enabled: true, billingMode: 'seat', budget: { perGoalUsd: 1 } }],
    }));
    const d = svc.evaluateSpawn({ goalId: 'g1', model: 'opus' });
    expect(d.allowed).toBe(true);
  });

  it('blocks spawn on a metered provider over the per-goal cap', () => {
    seedGoalSpend('g1', 'opus', 12);
    const svc = createBudgetService(db, () => ({
      providers: [{ id: 'claude', enabled: true, billingMode: 'metered', budget: { perGoalUsd: 10 } }],
    }));
    const d = svc.evaluateSpawn({ goalId: 'g1', model: 'opus' });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/per-goal/i);
  });

  it('blocks spawn on a metered provider over the daily cap', () => {
    seedGoalSpend('g1', 'opus', 60);
    const svc = createBudgetService(db, () => ({
      providers: [{ id: 'claude', enabled: true, billingMode: 'metered', budget: { dailyUsd: 50 } }],
    }));
    const d = svc.evaluateSpawn({ goalId: 'g2', model: 'opus' });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/daily/i);
  });

  it('enforces per-provider concurrency', () => {
    const svc = createBudgetService(db, () => ({
      providers: [{ id: 'claude', enabled: true, billingMode: 'seat', maxConcurrent: 1 }],
    }));
    const d1 = svc.evaluateSpawn({ goalId: 'g1', model: 'opus', activeForProvider: 1 });
    expect(d1.allowed).toBe(false);
    expect(d1.reason).toMatch(/concurren/i);
  });

  it('flags a burn-rate alarm above the tokens/min threshold', () => {
    const svc = createBudgetService(db, () => ({ enabledProviders: ['claude'] }), { burnRateTokensPerMin: 100_000 });
    expect(svc.checkBurnRate({ goalId: 'g1', tokens: 250_000, windowMs: 60_000 }).alarm).toBe(true);
    expect(svc.checkBurnRate({ goalId: 'g1', tokens: 1_000, windowMs: 60_000 }).alarm).toBe(false);
  });

  it('evaluateRunningGoals returns goals to pause on a metered over-cap', () => {
    seedGoalSpend('g1', 'opus', 12);
    const svc = createBudgetService(db, () => ({
      providers: [{ id: 'claude', enabled: true, billingMode: 'metered', budget: { perGoalUsd: 10 } }],
    }));
    const toPause = svc.evaluateRunningGoals(['g1']);
    expect(toPause).toContain('g1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/services/budget-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the service**

`server/services/budget-service.ts`
```ts
import type Database from 'better-sqlite3';
import { resolveModel } from '../../src/shared/agents/model-registry';
import { readBudgetConfig, type BudgetConfig } from './budget-config';
import logger from '../logger';

export interface BudgetServiceOptions {
  /** tokens/min above which a burn-rate alarm fires. Default 500k. */
  burnRateTokensPerMin?: number;
}

export interface SpawnDecision {
  allowed: boolean;
  reason: string;
}

export interface BurnRateResult {
  alarm: boolean;
  tokensPerMin: number;
}

/** Reads the live config each call so Settings changes take effect without restart. */
export type ConfigReader = () => unknown;

function providerForModel(model: string): string {
  return resolveModel(model)?.provider ?? 'claude';
}

export function createBudgetService(
  db: Database.Database,
  readConfig: ConfigReader,
  options: BudgetServiceOptions = {},
) {
  const burnRateThreshold = options.burnRateTokensPerMin ?? 500_000;

  const killReadStmt = db.prepare<[], { value_json: string }>(
    "SELECT value_json FROM budget_state WHERE key = 'kill_switch'",
  );
  const killWriteStmt = db.prepare<[string, number]>(
    `INSERT INTO budget_state (key, value_json, updated_at) VALUES ('kill_switch', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  );

  function isKillSwitchActive(): boolean {
    const row = killReadStmt.get();
    if (!row) return false;
    try { return Boolean((JSON.parse(row.value_json) as { active?: boolean }).active); }
    catch { return false; }
  }

  function setKillSwitch(active: boolean): void {
    killWriteStmt.run(JSON.stringify({ active }), Date.now());
    logger.warn({ active }, 'Budget kill switch set');
  }

  function spentForGoalUsd(goalId: string): number {
    const row = db.prepare(`
      SELECT COALESCE(SUM(su.estimated_cost_usd), 0) as cost
      FROM session_usage su JOIN sessions s ON su.session_id = s.id
      WHERE s.goal_id = ?
    `).get(goalId) as { cost: number };
    return row.cost;
  }

  function spentTodayUsd(): number {
    const row = db.prepare(`
      SELECT COALESCE(SUM(estimated_cost_usd), 0) as cost
      FROM session_usage WHERE session_date = date('now')
    `).get() as { cost: number };
    return row.cost;
  }

  function config(): BudgetConfig {
    return readBudgetConfig(readConfig());
  }

  /**
   * Decides whether a goal may spawn/continue. Order: kill switch → concurrency
   * → (metered only) per-goal cap → daily cap. Seat providers never hit caps.
   */
  function evaluateSpawn(input: { goalId: string; model: string; activeForProvider?: number }): SpawnDecision {
    if (isKillSwitchActive()) {
      return { allowed: false, reason: 'Global kill switch is active' };
    }

    const cfg = config();
    const providerId = providerForModel(input.model);
    const provider = cfg.providers[providerId] ?? cfg.providers['claude'];

    if (provider.maxConcurrent !== null && (input.activeForProvider ?? 0) >= provider.maxConcurrent) {
      return { allowed: false, reason: `Provider concurrency limit reached (${provider.maxConcurrent})` };
    }

    if (provider.billingMode === 'metered') {
      const goalSpend = spentForGoalUsd(input.goalId);
      if (provider.budget.perGoalUsd != null && goalSpend >= provider.budget.perGoalUsd) {
        return { allowed: false, reason: `Per-goal cap reached ($${provider.budget.perGoalUsd})` };
      }
      if (provider.budget.dailyUsd != null && spentTodayUsd() >= provider.budget.dailyUsd) {
        return { allowed: false, reason: `Daily cap reached ($${provider.budget.dailyUsd})` };
      }
    }

    return { allowed: true, reason: 'within budget' };
  }

  /** Of the given running goal ids, returns those that must be paused (metered over-cap or kill switch). */
  function evaluateRunningGoals(runningGoalIds: string[]): string[] {
    if (isKillSwitchActive()) return [...runningGoalIds];
    const cfg = config();
    const toPause: string[] = [];
    const dailyOver = (() => {
      // daily cap is provider-wide; check the strictest metered cap
      const metered = Object.values(cfg.providers).filter((p) => p.billingMode === 'metered');
      const dailyCap = metered.reduce<number | null>((min, p) => {
        if (p.budget.dailyUsd == null) return min;
        return min == null ? p.budget.dailyUsd : Math.min(min, p.budget.dailyUsd);
      }, null);
      return dailyCap != null && spentTodayUsd() >= dailyCap;
    })();

    for (const goalId of runningGoalIds) {
      if (dailyOver) { toPause.push(goalId); continue; }
      // per-goal cap: use the model's provider when known, else any metered provider's perGoalUsd
      const goalSpend = spentForGoalUsd(goalId);
      const overPerGoal = Object.values(cfg.providers).some(
        (p) => p.billingMode === 'metered' && p.budget.perGoalUsd != null && goalSpend >= p.budget.perGoalUsd,
      );
      if (overPerGoal) toPause.push(goalId);
    }
    return toPause;
  }

  function checkBurnRate(input: { goalId: string; tokens: number; windowMs: number }): BurnRateResult {
    const minutes = input.windowMs / 60_000;
    const tokensPerMin = minutes > 0 ? input.tokens / minutes : 0;
    const alarm = tokensPerMin > burnRateThreshold;
    if (alarm) logger.warn({ goalId: input.goalId, tokensPerMin }, 'Burn-rate alarm');
    return { alarm, tokensPerMin };
  }

  return {
    isKillSwitchActive, setKillSwitch, evaluateSpawn, evaluateRunningGoals,
    checkBurnRate, spentForGoalUsd, spentTodayUsd,
  };
}

export type BudgetService = ReturnType<typeof createBudgetService>;
```

> **Dependency note:** this imports `resolveModel` from `src/shared/agents/model-registry` (Phase 0A). If Phase 0A has not landed, `providerForModel` falls back to `'claude'` via the `?? 'claude'` — but the import must resolve. If the file is genuinely absent at execution time, add a 3-line local stub `resolveModel = () => null` with a `// TODO: Phase 0A` and remove it when 0A lands. (Phase 0A is a declared prerequisite; this is the documented fallback.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/services/budget-service.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/budget-service.ts tests/server/services/budget-service.test.ts
git commit -m "feat(5E): BudgetService — caps, kill switch, concurrency, burn-rate"
```

---

## Task 11: QuotaRouter — advisory routing over window-utilization

**Files:**
- Create: `server/services/quota-router.ts`
- Test: `tests/server/services/quota-router.test.ts`

> Pure helper. Given a requested model and a window-utilization snapshot (injected — comes from Phase 2 `GET /api/analytics/window-utilization`), it recommends a cooler provider when the requested provider's window is "hot" (utilization ≥ threshold) and a cooler enabled provider exists. Advisory unless `autoRoute` is true.

- [ ] **Step 1: Write the failing test**

`tests/server/services/quota-router.test.ts`
```ts
import { describe, it, expect } from 'vitest';
import { recommendRoute } from '../../../server/services/quota-router';

const util = [
  { provider: 'claude', utilizationPct: 92 },
  { provider: 'codex', utilizationPct: 20 },
  { provider: 'antigravity', utilizationPct: 70 },
];

describe('recommendRoute', () => {
  it('stays on the requested provider when its window is cool', () => {
    const r = recommendRoute({
      requestedModel: 'sonnet', windowUtilization: [{ provider: 'claude', utilizationPct: 30 }],
      enabledProviders: ['claude', 'codex'], hotThresholdPct: 85, autoRoute: false,
      providerForModel: () => 'claude', coolestModelForProvider: (p) => `${p}-default`,
    });
    expect(r.recommendedProvider).toBeNull();
    expect(r.applied).toBe(false);
  });

  it('recommends the coolest enabled alternate when the requested provider is hot', () => {
    const r = recommendRoute({
      requestedModel: 'opus', windowUtilization: util,
      enabledProviders: ['claude', 'codex', 'antigravity'], hotThresholdPct: 85, autoRoute: false,
      providerForModel: () => 'claude', coolestModelForProvider: (p) => `${p}-default`,
    });
    expect(r.recommendedProvider).toBe('codex');
    expect(r.recommendedModel).toBe('codex-default');
    expect(r.reason).toMatch(/hot/i);
    expect(r.applied).toBe(false);
  });

  it('applies the recommendation when autoRoute is true', () => {
    const r = recommendRoute({
      requestedModel: 'opus', windowUtilization: util,
      enabledProviders: ['claude', 'codex'], hotThresholdPct: 85, autoRoute: true,
      providerForModel: () => 'claude', coolestModelForProvider: (p) => `${p}-default`,
    });
    expect(r.recommendedProvider).toBe('codex');
    expect(r.applied).toBe(true);
  });

  it('makes no recommendation when no cooler enabled provider exists', () => {
    const r = recommendRoute({
      requestedModel: 'opus', windowUtilization: [{ provider: 'claude', utilizationPct: 95 }],
      enabledProviders: ['claude'], hotThresholdPct: 85, autoRoute: true,
      providerForModel: () => 'claude', coolestModelForProvider: (p) => `${p}-default`,
    });
    expect(r.recommendedProvider).toBeNull();
    expect(r.applied).toBe(false);
  });

  it('makes no recommendation when window utilization is empty (endpoint absent)', () => {
    const r = recommendRoute({
      requestedModel: 'opus', windowUtilization: [],
      enabledProviders: ['claude', 'codex'], hotThresholdPct: 85, autoRoute: true,
      providerForModel: () => 'claude', coolestModelForProvider: (p) => `${p}-default`,
    });
    expect(r.recommendedProvider).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/services/quota-router.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the helper**

`server/services/quota-router.ts`
```ts
import type { RoutingRecommendation } from '../../src/shared/types';

export interface WindowUtilizationEntry {
  provider: string;
  /** 0–100 estimate of the provider's rolling-window quota used. */
  utilizationPct: number;
}

export interface RecommendRouteInput {
  requestedModel: string;
  windowUtilization: WindowUtilizationEntry[];
  enabledProviders: string[];
  /** Utilization ≥ this is "hot". */
  hotThresholdPct: number;
  /** When true, the recommendation is marked applied (caller switches model). */
  autoRoute: boolean;
  /** Maps a model id to its provider id (Phase 0A registry in production). */
  providerForModel: (model: string) => string;
  /** Returns the cheapest/coolest model id for a provider (registry in production). */
  coolestModelForProvider: (provider: string) => string;
}

/**
 * Recommends routing a job to a cooler provider when the requested provider's
 * seat window is hot. Pure + deterministic. Returns the requested provider
 * unchanged when it is cool, no alternate is enabled, or utilization data is
 * missing (degrades to advisory no-op so it is safe before Phase 2 lands).
 */
export function recommendRoute(input: RecommendRouteInput): RoutingRecommendation {
  const requestedProvider = input.providerForModel(input.requestedModel);
  const utilByProvider = new Map(input.windowUtilization.map((e) => [e.provider, e.utilizationPct]));
  const requestedUtil = utilByProvider.get(requestedProvider);

  const base: RoutingRecommendation = {
    requestedModel: input.requestedModel,
    requestedProvider,
    recommendedProvider: null,
    recommendedModel: null,
    reason: 'requested provider window is within limits',
    applied: false,
  };

  // No data, or requested provider is cool → no recommendation.
  if (requestedUtil == null || requestedUtil < input.hotThresholdPct) {
    return base;
  }

  // Find the coolest enabled alternate provider with utilization data.
  const alternates = input.enabledProviders
    .filter((p) => p !== requestedProvider)
    .map((p) => ({ provider: p, util: utilByProvider.get(p) }))
    .filter((a): a is { provider: string; util: number } => typeof a.util === 'number')
    .sort((a, b) => a.util - b.util);

  const coolest = alternates[0];
  if (!coolest || coolest.util >= input.hotThresholdPct) {
    return base;
  }

  return {
    ...base,
    recommendedProvider: coolest.provider,
    recommendedModel: input.coolestModelForProvider(coolest.provider),
    reason: `${requestedProvider} window hot (${requestedUtil}%) → ${coolest.provider} (${coolest.util}%)`,
    applied: input.autoRoute,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/services/quota-router.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/quota-router.ts tests/server/services/quota-router.test.ts
git commit -m "feat(5E): QuotaRouter — advisory quota-aware routing helper"
```

---

## Task 12: Budget/routing routes + server wiring (spawn enforcement + monitor)

**Files:**
- Create: `server/routes/budget.ts`
- Modify: `server/index.ts`
- Test: `tests/server/routes/budget.test.ts`

> The router exposes status + kill-switch + routing recommendation. The wiring (a) gates `spawnTerminalSession` on `evaluateSpawn`, and (b) runs a 30s monitor that pauses any running goal `evaluateRunningGoals` flags. Per-provider active counts come from a small helper over `processRegistry` + each goal's model.

- [ ] **Step 1: Write the failing test**

`tests/server/routes/budget.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';
import { createBudgetService } from '../../../server/services/budget-service';
import { createBudgetRouter } from '../../../server/routes/budget';

vi.mock('../../../server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let db: Database.Database;
let app: express.Express;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  const svc = createBudgetService(db, () => ({
    providers: [{ id: 'claude', enabled: true, billingMode: 'metered', budget: { dailyUsd: 50 } }],
  }));
  app = express();
  app.use(express.json());
  app.use('/api', createBudgetRouter(svc, {
    activeSessionsByProvider: () => ({ claude: 0 }),
    fetchWindowUtilization: async () => [{ provider: 'claude', utilizationPct: 90 }, { provider: 'codex', utilizationPct: 10 }],
    enabledProviders: () => ['claude', 'codex'],
    routingConfig: () => ({ hotThresholdPct: 85, autoRoute: false }),
  }));
});
afterEach(() => db.close());

describe('budget routes', () => {
  it('GET /api/budget/status returns kill switch + provider rows', async () => {
    const res = await request(app).get('/api/budget/status');
    expect(res.status).toBe(200);
    expect(res.body.killSwitchActive).toBe(false);
    expect(res.body.providers[0].id).toBe('claude');
    expect(res.body.providers[0].dailyCapUsd).toBe(50);
  });

  it('POST /api/budget/kill-switch flips the switch', async () => {
    const res = await request(app).post('/api/budget/kill-switch').send({ active: true });
    expect(res.status).toBe(200);
    expect(res.body.killSwitchActive).toBe(true);
    const status = await request(app).get('/api/budget/status');
    expect(status.body.killSwitchActive).toBe(true);
  });

  it('GET /api/routing/recommendation advises a cooler provider when hot', async () => {
    const res = await request(app).get('/api/routing/recommendation?model=opus');
    expect(res.status).toBe(200);
    expect(res.body.recommendedProvider).toBe('codex');
    expect(res.body.applied).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/routes/budget.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the router**

`server/routes/budget.ts`
```ts
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { BudgetService } from '../services/budget-service';
import { readBudgetConfig } from '../services/budget-config';
import { recommendRoute, type WindowUtilizationEntry } from '../services/quota-router';
import { resolveModel } from '../../src/shared/agents/model-registry';
import logger from '../logger';

const KillSwitchSchema = z.object({ active: z.boolean() });

export interface BudgetRouterDeps {
  /** Live active-session counts per provider id. */
  activeSessionsByProvider: () => Record<string, number>;
  /** Phase 2 window-utilization feed; resolves to [] when unavailable. */
  fetchWindowUtilization: () => Promise<WindowUtilizationEntry[]>;
  /** Currently enabled provider ids. */
  enabledProviders: () => string[];
  /** Routing config (threshold + auto mode) from app config. */
  routingConfig: () => { hotThresholdPct: number; autoRoute: boolean };
  /** Live config reader for the status view (defaults to {} when omitted). */
  readConfig?: () => unknown;
}

export function createBudgetRouter(service: BudgetService, deps: BudgetRouterDeps): Router {
  const router = Router();

  router.get('/budget/status', (_req: Request, res: Response) => {
    try {
      const cfg = readBudgetConfig(deps.readConfig?.() ?? {});
      const active = deps.activeSessionsByProvider();
      const dailySpend = service.spentTodayUsd();
      const providers = Object.entries(cfg.providers).map(([id, p]) => ({
        id,
        billingMode: p.billingMode,
        spentTodayUsd: Math.round(dailySpend * 10000) / 10000,
        dailyCapUsd: p.budget.dailyUsd ?? null,
        overCap: p.billingMode === 'metered' && p.budget.dailyUsd != null && dailySpend >= p.budget.dailyUsd,
        activeSessions: active[id] ?? 0,
        maxConcurrent: p.maxConcurrent,
      }));
      res.json({ killSwitchActive: service.isKillSwitchActive(), providers, pausedGoalIds: [] });
    } catch (err) {
      logger.error({ err }, 'Failed to get budget status');
      res.status(500).json({ error: 'Failed to get budget status' });
    }
  });

  router.post('/budget/kill-switch', (req: Request, res: Response) => {
    const parsed = KillSwitchSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'active (boolean) required' }); return; }
    service.setKillSwitch(parsed.data.active);
    res.json({ killSwitchActive: service.isKillSwitchActive() });
  });

  router.get('/routing/recommendation', async (req: Request, res: Response) => {
    try {
      const model = String(req.query['model'] ?? '');
      if (!model) { res.status(400).json({ error: 'model query param required' }); return; }
      const windowUtilization = await deps.fetchWindowUtilization();
      const { hotThresholdPct, autoRoute } = deps.routingConfig();
      const rec = recommendRoute({
        requestedModel: model,
        windowUtilization,
        enabledProviders: deps.enabledProviders(),
        hotThresholdPct,
        autoRoute,
        providerForModel: (m) => resolveModel(m)?.provider ?? 'claude',
        coolestModelForProvider: (p) => `${p}-default`,
      });
      res.json(rec);
    } catch (err) {
      logger.error({ err }, 'Failed to compute routing recommendation');
      res.status(500).json({ error: 'Failed to compute routing recommendation' });
    }
  });

  return router;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/routes/budget.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire into `server/index.ts`**

Add imports near the other service imports:
```ts
import { createBudgetService } from './services/budget-service';
import { createBudgetRouter } from './routes/budget';
import { resolveModel } from '../src/shared/agents/model-registry';
```

After `const verificationService = ...` (Task 6) add:
```ts
// 5E: budget guardrails. readConfig returns {} until Phase 1 ConfigService lands;
// swap to configService.getPersisted when available (single call site).
const readConfig = (): unknown => ({ enabledProviders: ['claude'] });
const budgetService = createBudgetService(db, readConfig);

/** Live active-session counts per provider, derived from the process registry. */
function activeSessionsByProvider(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const goalId of Object.keys({})) void goalId; // placeholder; replaced below
  // Count one per running goal, attributed by the goal's model → provider.
  const runningGoalIds = listRunningGoalIds();
  for (const goalId of runningGoalIds) {
    const g = goalService.get(goalId);
    const provider = resolveModel(g?.model ?? 'claude')?.provider ?? 'claude';
    counts[provider] = (counts[provider] ?? 0) + 1;
  }
  return counts;
}

/** Goal ids with a live runner in the process registry. */
function listRunningGoalIds(): string[] {
  const ids: string[] = [];
  const allGoals = goalService.list({ status: 'active' });
  for (const g of allGoals) {
    if (processRegistry.has(g.id)) ids.push(g.id);
  }
  return ids;
}
```

> Remove the `for (const goalId of Object.keys({}))` placeholder line — it is shown only to make the diff obvious; the real body is the `runningGoalIds` loop. Final `activeSessionsByProvider` is just the loop over `listRunningGoalIds()`.

Gate spawning: inside `spawnTerminalSession`, immediately after `if (!goal) throw new Error('Goal not found');` (~line 138), add:
```ts
  const decision = budgetService.evaluateSpawn({
    goalId,
    model: goal.model ?? 'claude',
    activeForProvider: activeSessionsByProvider()[resolveModel(goal.model ?? 'claude')?.provider ?? 'claude'] ?? 0,
  });
  if (!decision.allowed) {
    logger.warn({ goalId, reason: decision.reason }, 'Spawn blocked by budget guardrail');
    throw new Error(`Spawn blocked: ${decision.reason}`);
  }
```

Mount the router — add to the `apiRouters` array:
```ts
const budgetRouter = createBudgetRouter(budgetService, {
  activeSessionsByProvider,
  fetchWindowUtilization: async () => {
    // Phase 2 endpoint. Until it exists, return [] (advisory no-op).
    try {
      const port = process.env['PORT'] ?? '4100';
      const r = await fetch(`http://127.0.0.1:${port}/api/analytics/window-utilization`);
      if (!r.ok) return [];
      return (await r.json()) as Array<{ provider: string; utilizationPct: number }>;
    } catch { return []; }
  },
  enabledProviders: () => ['claude'],
  routingConfig: () => ({ hotThresholdPct: 85, autoRoute: false }),
  readConfig,
});
```
and include `budgetRouter` in the `apiRouters: [...]` list.

Add the periodic monitor (after `scheduler.start();`, ~line 305):
```ts
// 5E: pause runaway/over-cap goals every 30s.
const budgetMonitor = setInterval(() => {
  try {
    const toPause = budgetService.evaluateRunningGoals(listRunningGoalIds());
    for (const goalId of toPause) {
      const runner = processRegistry.get(goalId);
      if (runner) {
        logger.warn({ goalId }, 'Budget guardrail pausing goal');
        void runner.interrupt();
      }
    }
  } catch (err) {
    logger.error({ err }, 'Budget monitor failed');
  }
}, 30_000);
budgetMonitor.unref();
```

In `shutdown()`, after `clearInterval(ingestionInterval);` add:
```ts
  clearInterval(budgetMonitor);
```

- [ ] **Step 6: Run full server suite + typecheck**

Run: `npx vitest run tests/server` then `npm run typecheck`
Expected: PASS, no type errors. (If `resolveModel` from Phase 0A is absent, see the Task 10 dependency note — add the documented 3-line stub.)

- [ ] **Step 7: Commit**

```bash
git add server/routes/budget.ts server/index.ts tests/server/routes/budget.test.ts
git commit -m "feat(5E): budget/routing routes + spawn enforcement + pause monitor"
```

---

## Task 13: DocWriter — last-write-wins detection + attribution stamping

**Files:**
- Create: `server/services/doc-writer.ts`
- Modify: `src/shared/types.ts` (add `DocWriteResult`)
- Test: `tests/server/services/doc-writer.test.ts`

> Pure-ish file helper. `readWithBase(path)` returns content + a base hash + mtime. `writeWithAttribution({ path, content, baseHash, author })` re-reads disk; if the on-disk hash differs from `baseHash` (someone else wrote since the read), it returns `{ conflict: true }` without clobbering (last-write-wins detection — the caller decides). On success it appends an attribution trailer and writes atomically.

- [ ] **Step 1: Write the failing test**

`tests/server/services/doc-writer.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDocWriter } from '../../../server/services/doc-writer';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'docwriter-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('DocWriter', () => {
  const writer = createDocWriter();

  it('readWithBase returns content + a stable base hash', () => {
    const p = join(dir, 'handoff.md');
    writeFileSync(p, '# Handoff\nhello\n');
    const a = writer.readWithBase(p);
    const b = writer.readWithBase(p);
    expect(a.content).toContain('hello');
    expect(a.baseHash).toBe(b.baseHash);
    expect(a.exists).toBe(true);
  });

  it('readWithBase reports exists:false for a missing file', () => {
    const r = writer.readWithBase(join(dir, 'nope.md'));
    expect(r.exists).toBe(false);
    expect(r.baseHash).toBe('');
  });

  it('writes with an attribution trailer when base matches', () => {
    const p = join(dir, 'handoff.md');
    writeFileSync(p, 'original\n');
    const base = writer.readWithBase(p);
    const result = writer.writeWithAttribution({ path: p, content: 'updated\n', baseHash: base.baseHash, author: 'goal-42/codex' });
    expect(result.conflict).toBe(false);
    expect(result.written).toBe(true);
    const onDisk = readFileSync(p, 'utf-8');
    expect(onDisk).toContain('updated');
    expect(onDisk).toMatch(/— written by goal-42\/codex @ \d{4}-\d{2}-\d{2}T/);
  });

  it('detects a conflict when the file changed since read (last-write-wins)', () => {
    const p = join(dir, 'handoff.md');
    writeFileSync(p, 'original\n');
    const base = writer.readWithBase(p);
    // Someone else writes in between.
    writeFileSync(p, 'sneaky other edit\n');
    const result = writer.writeWithAttribution({ path: p, content: 'mine\n', baseHash: base.baseHash, author: 'goal-1/claude' });
    expect(result.conflict).toBe(true);
    expect(result.written).toBe(false);
    // File is NOT clobbered.
    expect(readFileSync(p, 'utf-8')).toContain('sneaky other edit');
  });

  it('writes a new file when base is empty and file does not exist', () => {
    const p = join(dir, 'new.md');
    const result = writer.writeWithAttribution({ path: p, content: 'fresh\n', baseHash: '', author: 'goal-7/claude' });
    expect(result.conflict).toBe(false);
    expect(result.written).toBe(true);
    expect(readFileSync(p, 'utf-8')).toContain('fresh');
  });

  it('does not duplicate-stamp content that already ends with a trailer', () => {
    const p = join(dir, 'handoff.md');
    writeFileSync(p, 'original\n');
    const base = writer.readWithBase(p);
    const content = 'updated\n\n— written by goal-9/claude @ 2026-06-09T00:00:00.000Z\n';
    const result = writer.writeWithAttribution({ path: p, content, baseHash: base.baseHash, author: 'goal-42/codex' });
    const onDisk = readFileSync(p, 'utf-8');
    // Exactly one trailer line.
    expect((onDisk.match(/— written by/g) ?? []).length).toBe(1);
    expect(result.written).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/services/doc-writer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the service + type**

`server/services/doc-writer.ts`
```ts
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import logger from '../logger';
import type { DocWriteResult } from '../../src/shared/types';

export interface ReadWithBaseResult {
  exists: boolean;
  content: string;
  /** sha256 of the on-disk content at read time; '' when the file does not exist. */
  baseHash: string;
  mtimeMs: number;
}

export interface WriteInput {
  path: string;
  content: string;
  /** Hash from the readWithBase() call the caller based its edit on. '' = expect no file. */
  baseHash: string;
  /** Attribution stamp identity, e.g. 'goal-42/codex'. */
  author: string;
}

const TRAILER_RE = /—\s*written by\s+\S+\s+@\s+\d{4}-\d{2}-\d{2}T/;

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Stateless writer for shared goal markdown (handoff.md, plan.md, …). */
export function createDocWriter() {
  function readWithBase(path: string): ReadWithBaseResult {
    if (!existsSync(path)) {
      return { exists: false, content: '', baseHash: '', mtimeMs: 0 };
    }
    const content = readFileSync(path, 'utf-8');
    return { exists: true, content, baseHash: hashContent(content), mtimeMs: statSync(path).mtimeMs };
  }

  /**
   * Writes content with last-write-wins conflict detection. If the file's
   * current on-disk hash differs from baseHash, returns { conflict: true,
   * written: false } and does NOT touch the file. Otherwise appends an
   * attribution trailer (unless one is already present) and writes atomically.
   */
  function writeWithAttribution(input: WriteInput): DocWriteResult {
    const current = existsSync(input.path) ? readFileSync(input.path, 'utf-8') : null;
    const currentHash = current != null ? hashContent(current) : '';

    if (currentHash !== input.baseHash) {
      logger.warn({ path: input.path, author: input.author }, 'DocWriter conflict — base hash stale');
      return { conflict: true, written: false, path: input.path, baseHash: currentHash };
    }

    const trailer = `\n\n— written by ${input.author} @ ${new Date().toISOString()}\n`;
    const stamped = TRAILER_RE.test(input.content.trimEnd().split('\n').slice(-1)[0] ?? '')
      ? input.content
      : input.content.replace(/\s*$/, '') + trailer;

    const tmp = `${input.path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, stamped, 'utf-8');
    renameSync(tmp, input.path);

    return { conflict: false, written: true, path: input.path, baseHash: hashContent(stamped) };
  }

  return { readWithBase, writeWithAttribution };
}

export type DocWriter = ReturnType<typeof createDocWriter>;
```

Append to `src/shared/types.ts`:
```ts
// ── 5F Shared-markdown attribution ───────────────────────────────────────────

export interface DocWriteResult {
  /** True when the on-disk file changed since the base read (write was refused). */
  conflict: boolean;
  /** True when the write succeeded. */
  written: boolean;
  path: string;
  /** sha256 of the resulting on-disk content (or the conflicting content on conflict). */
  baseHash: string;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/services/doc-writer.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/doc-writer.ts src/shared/types.ts tests/server/services/doc-writer.test.ts
git commit -m "feat(5F): DocWriter — last-write-wins detection + attribution stamping"
```

---

## Task 14: Attributed document write endpoint

**Files:**
- Modify: `server/routes/system.ts` (add `POST /api/goals/:id/document`)
- Test: `tests/server/routes/document-write.test.ts`

> The existing `GET /api/goals/:id/document` reads from `goal.cwd`. This adds the write side: read the base hash, apply the DocWriter, return 409 on conflict. The same path-traversal guards as the GET route are reused.

- [ ] **Step 1: Write the failing test**

`tests/server/routes/document-write.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../../../server/db/migrate';
import { createSystemRouter } from '../../../server/routes/system';

vi.mock('../../../server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let db: Database.Database;
let app: express.Express;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'docwrite-'));
  db = new Database(':memory:');
  runMigrations(db);
  const now = Date.now();
  db.prepare(`INSERT INTO goals (id, title, cwd, status, kanban_order, created_at, updated_at)
              VALUES ('g1', 'G', ?, 'active', 1, ?, ?)`).run(dir, now, now);
  app = express();
  app.use(express.json());
  const router = createSystemRouter();
  app.use('/api', (req, _res, next) => { (req.app as unknown as { locals: Record<string, unknown> }).locals = { db }; next(); }, router);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('POST /api/goals/:id/document', () => {
  it('writes a document with an attribution trailer', async () => {
    const res = await request(app)
      .post('/api/goals/g1/document')
      .send({ name: 'handoff.md', content: 'hello\n', baseHash: '', author: 'goal-1/claude' });
    expect(res.status).toBe(200);
    expect(res.body.written).toBe(true);
    const onDisk = readFileSync(join(dir, 'handoff.md'), 'utf-8');
    expect(onDisk).toMatch(/— written by goal-1\/claude @/);
  });

  it('returns 409 on a stale base hash (conflict)', async () => {
    writeFileSync(join(dir, 'handoff.md'), 'original\n');
    const res = await request(app)
      .post('/api/goals/g1/document')
      .send({ name: 'handoff.md', content: 'mine\n', baseHash: 'deadbeef', author: 'goal-1/claude' });
    expect(res.status).toBe(409);
    expect(res.body.conflict).toBe(true);
    expect(readFileSync(join(dir, 'handoff.md'), 'utf-8')).toContain('original');
  });

  it('rejects path traversal in name', async () => {
    const res = await request(app)
      .post('/api/goals/g1/document')
      .send({ name: '../escape.md', content: 'x', baseHash: '', author: 'a' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown goal', async () => {
    const res = await request(app)
      .post('/api/goals/nope/document')
      .send({ name: 'handoff.md', content: 'x', baseHash: '', author: 'a' });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/routes/document-write.test.ts`
Expected: FAIL — route returns 404 (no such handler) → assertion fails.

- [ ] **Step 3: Add the route to `server/routes/system.ts`**

Add this import at the top of `server/routes/system.ts` (with the other imports):
```ts
import { createDocWriter } from '../services/doc-writer';
```

Add a module-level writer instance just above `export function createSystemRouter(...)`:
```ts
const docWriter = createDocWriter();
```

Add the route inside `createSystemRouter`, immediately after the existing `GET /api/goals/:id/document` handler (~line 417):
```ts
/**
 * POST /api/goals/:id/document
 * Body: { name: string, content: string, baseHash: string, author: string }
 * Writes a .md document into the goal's cwd with last-write-wins conflict
 * detection (5F). Returns 409 when baseHash is stale (file changed since read).
 */
router.post('/goals/:id/document', (req, res) => {
  try {
    const db = (req.app as unknown as { locals: { db: import('better-sqlite3').Database } }).locals?.db;
    if (!db) { res.status(500).json({ error: 'Database not available' }); return; }

    const goalId = String(req.params['id']);
    const { name, content, baseHash, author } = req.body as {
      name?: string; content?: string; baseHash?: string; author?: string;
    };

    if (typeof name !== 'string' || typeof content !== 'string' || typeof author !== 'string') {
      res.status(400).json({ error: 'name, content, author are required' });
      return;
    }
    if (name.includes('..') || name.includes('/') || name.includes('\\') || !name.endsWith('.md')) {
      res.status(400).json({ error: 'Invalid filename' });
      return;
    }

    const goal = db.prepare('SELECT cwd FROM goals WHERE id = ?').get(goalId) as { cwd: string } | undefined;
    if (!goal) { res.status(404).json({ error: 'Goal not found' }); return; }

    const filePath = path.join(goal.cwd, name);
    const result = docWriter.writeWithAttribution({
      path: filePath, content, baseHash: baseHash ?? '', author,
    });

    if (result.conflict) { res.status(409).json(result); return; }
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, 'Failed to write document');
    res.status(500).json({ error: message });
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/routes/document-write.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full server suite + typecheck**

Run: `npx vitest run tests/server` then `npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add server/routes/system.ts tests/server/routes/document-write.test.ts
git commit -m "feat(5F): attributed document write endpoint with conflict detection"
```

---

## Task 15: Full-suite verification + self-review fixes

**Files:** none (verification task)

- [ ] **Step 1: Run the whole test suite (node + jsdom projects)**

Run: `npm test`
Expected: All tests PASS — no regressions vs the Phase 0 green baseline; the new 5C/5E/5F suites pass.

- [ ] **Step 2: Run typecheck and lint**

Run: `npm run typecheck` then `npm run lint`
Expected: No type errors; lint clean (or only pre-existing warnings).

- [ ] **Step 3: Confirm migrations are sequential and idempotent**

Run: `npx vitest run tests/server/db/verification-migration.test.ts tests/server/db/budget-migration.test.ts tests/server/db/migrate.test.ts`
Expected: PASS — 023 and 024 apply once, record versions 23/24, and re-running migrations is a no-op.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "test(phase5-governance): full-suite green for 5C/5E/5F"
```

---

## Self-Review (by plan author)

**1. Spec coverage** — every scoped item maps to a task:
- 5C verification gate: migration (T1), types/events (T2), service record+query (T3), command runner (T4), routes incl. model scorecard (T5), PTY onExit wiring (T6), KanbanCard chip (T7). doneCommand default from Project Registry + worktree run are injected via `defaultVerificationDeps` resolvers (T6) — the documented Phase 5A/5B seam.
- 5E guardrails: migration + kill switch (T8), config accessor over provider `budget` field (T9), caps/pause/burn-rate/kill-switch/concurrency service (T10), quota-aware router (T11), routes + spawn enforcement + 30s pause monitor + advisory-by-default/auto opt-in (T12). Pauses sessions (interrupt) on metered profile only; seat never paused (decision §2.6).
- 5F attribution: DocWriter last-write-wins + trailer (T13), attributed write endpoint (T14).

**2. Placeholder scan** — the only literal placeholder is the intentionally-flagged throwaway line in T12's `activeSessionsByProvider` diff, with an explicit "remove this line" note and the real loop shown. No TBD/TODO-as-implementation; the two genuine prerequisite seams (Phase 0A `resolveModel`, Phase 1 ConfigService) have documented fallbacks (3-line stub / `() => ({ enabledProviders: ['claude'] })`) at single call sites.

**3. Type consistency** — `VerificationResult`/`VerificationStatus`/`ModelScorecardRow` (T2) are used identically in T3/T5/T7. `VerificationDeps.resolveDoneCommand|resolveWorkspace` (T3) match `defaultVerificationDeps` output (T6). `BudgetStatus`/`RoutingRecommendation` (T9) match the router responses (T12). `RoutingRecommendation` fields from `recommendRoute` (T11) match the type (T9). `DocWriteResult` (T13) matches the endpoint response (T14). `createBudgetService(db, readConfig, options)` signature is consistent across T10/T12 tests and wiring.

**Known risks / missing contracts called out inline:**
- Phase 2 `GET /api/analytics/window-utilization` does **not** exist on the working branch — `fetchWindowUtilization` degrades to `[]` (advisory no-op) until it lands.
- Phase 1 delta B richer `providers[]` config is not on the working branch — `readBudgetConfig` accepts both shapes; `readConfig` is stubbed to `{ enabledProviders: ['claude'] }` at one call site, swap to `configService.getPersisted` when Phase 1 lands.
- Phase 5A Project Registry / 5B worktree resolvers are injected (`projectDoneCommand`/`worktreePath`) and currently fall back to a config-level default command + `goal.cwd`.
- Phase 0A `model-registry` is a hard import in `budget-service.ts`/`budget.ts`; if absent at execution time, add the documented 3-line `resolveModel` stub.
