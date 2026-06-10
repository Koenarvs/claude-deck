# Phase 4 — Enable the Stubbed Features (Implementation Plan)

**Date:** 2026-06-09
**Branch:** `feat/multi-agent-foundation`
**Roadmap:** `docs/superpowers/plans/2026-06-09-master-roadmap.md` → "Phase 4 — Enable the stubbed features"
**Skill:** authored per `superpowers:writing-plans` (bite-sized TDD, exact paths, real code, commit per task, Self-Review).

This plan covers **four independent task-groups**. They share no state and can be executed/committed in any order:

- **4A — Approval enforcement** (route supervised goals through `ApprovalCoordinator.request()`, mount `<GlobalApprovalQueue/>`).
- **4B — Trace subsystem** (mount router, instantiate `TraceWriter`, populate `trace_dir`, schedule pruning).
- **4C — Interrupt wiring + persisted home-route**.
- **4D — Markdown view+edit** (ships as its own plan; enable/wire steps noted here so it is not forgotten).

> **Vitest split:** server tests live in `tests/server/**` (node env), client tests in `tests/client/**` (jsdom env). Each task names its exact test path.

---

## Locked contracts this plan depends on (from Phase 1)

These are **prerequisites** delivered by Phase 1 (foundation Tasks 2–10 + deltas). Where a contract is not yet on the branch, each task below states the **fallback seam** so it can land independently and tighten when Phase 1 merges.

| Contract | Source | State on `feat/multi-agent-foundation` (verified 2026-06-09) | Used by |
|---|---|---|---|
| `AgentCatalogEntry.capabilities.canApprove` (Delta C) | `src/shared/agents/types.ts` | **NOT present yet** — `AgentCatalogEntry` has no `capabilities` field. | 4A gate |
| `config.tracePruneDays` persists via `ConfigService` (Task 8) | sibling `feat/multi-agent-impl` `server/services/config-service.ts` + migration `015_app_config.sql` | **NOT on this branch** — `app_config` table + `ConfigService` + migration 015 are sibling-only. `GET/PUT /api/config` (`server/routes/system.ts:131,144`) still returns hardcoded defaults / discards writes. | 4B prune schedule |
| `config.homeRoute` persists via `ConfigService` (Task 8) | same | same | 4C home-route |
| `processRegistry` runner registered per goal | `server/process-registry.ts` + `server/index.ts:190` (`processRegistry.set(goalId, ptyMgr)`) | **Present and live.** `PtyManager implements Killable` with real `interrupt()`. | 4C interrupt |
| `sessions.trace_dir TEXT` column | `server/db/migrations/001_init.sql:39` | **Present.** | 4B |
| `TraceWriter`, `pruneTraces`, `createTraceRouter`, tar-utils | `server/trace-writer.ts`, `server/trace-pruner.ts`, `server/routes/trace.ts`, `server/tar-utils.ts` | **Present + unit-tested** (`tests/server/trace-writer.test.ts`, `trace-pruner.test.ts`) but **never instantiated/mounted/scheduled.** | 4B |

**Sequencing note:** 4B-prune and 4C-home-route both consume `ConfigService` (Phase 1 Task 8). If Phase 1 has not landed when you start, execute the **ConfigService-fallback path** spelled out in 4B-Task-3 / 4C-Task-2 (read the persisted value if `app_config`/`ConfigService` exists, else fall back to the env/hardcoded default). When Phase 1 merges, delete the fallback branch — each such site is marked `// PHASE1-FALLBACK`.

**Migrations used by this plan:** **none.** `sessions.trace_dir` already exists; approvals/`app_config` tables are owned by migration 001 / Phase-1's 015 respectively. (If you run 4B/4C *before* Phase 1 merges 015 and you need persisted config, that is Phase 1's migration, not this plan's — do not duplicate it here.)

---

# 4A — Make Supervised Approvals REAL

## Problem (verified)

`server/hook-ingest.ts`:
- `onPreToolUse` (~285–309) and `onPermissionRequest` (~331–356) call `this.approvalCoordinator.notify(...)` then **immediately `return { decision: 'allow' }`**.
- `ApprovalCoordinator.notify()` (`server/approval-coordinator.ts:199–243`) inserts a `pending` approval row, broadcasts `approval:pending`, and **auto-approves after a 30s `setTimeout`** — a cosmetic badge, never a gate.
- The real blocking machinery — `ApprovalCoordinator.request(req, isAutonomous)` (`:55–146`) — is fully built (deferred promise + DB row + timeout + `resolve()`), **wired into the route** (`server/routes/approvals.ts` POST `/approvals/:id/decide` → `coordinator.resolve()`), **and into the client** (`src/lib/ws-manager.ts:63–68` dispatches `approval:pending`→`addPending`, `approval:resolved`→`markResolved`) — but **nothing calls `request()`.**
- `src/components/global/GlobalApprovalQueue.tsx` + `ApprovalCard.tsx` are built but imported **nowhere**. `src/components/AppShell.tsx` mounts `ConnectionIndicator`/`ToastContainer`/`CommandPalette`/`TweaksPanel` but **not** the approval queue.

So: the hook never blocks, and even if it did, the user would have no UI to decide. Both halves must land together.

## Decision: default = **enforce + mount**. Alternative = **remove**.

The roadmap (§Phase 4A) and Phase 6 (orchestrator) both require approvals to be able to **block** a tool call. **Default path below enforces.** A `notify()`-removal path is documented at the end of 4A as an explicit alternative the user may choose instead; do **not** execute both.

## Capability gate

Only providers whose `capabilities.canApprove === true` participate in blocking approvals. Others **pass through** (return `allow` immediately, documented). On this branch the only provider is Claude (`canApprove: true`), but the gate must be in code now so non-Claude providers (Phase 3) degrade honestly.

**Seam:** a tiny resolver `server/approval-policy.ts` that answers "for this goal, should PreToolUse block?" — combining (a) the goal's `permission_mode` (only `supervised` blocks; `autonomous` auto-allows) and (b) the provider capability (`canApprove`). Until Phase 1's catalog lands, `canApprove` resolves to `true` for Claude and is the single line to update when the catalog exists (`// PHASE1-FALLBACK`).

---

### 4A — Task 1: `server/approval-policy.ts` — the gate (TDD)

**Goal:** one pure-ish function deciding the approval posture for a goal, given DB access for `permission_mode` and a capability lookup.

**Test first** — `tests/server/approval-policy.test.ts` (node):

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/db/migrate';
import { resolveApprovalPosture } from '../../server/approval-policy';

function db(): Database.Database {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  runMigrations(d);
  return d;
}

describe('resolveApprovalPosture', () => {
  let d: Database.Database;
  beforeEach(() => { d = db(); });
  afterEach(() => { d.close(); });

  function makeGoal(id: string, mode: 'supervised' | 'autonomous', model = 'opus') {
    d.prepare(
      `INSERT INTO goals (id, title, status, priority, permission_mode, model, kanban_order, created_at, updated_at)
       VALUES (?, ?, 'active', 0, ?, ?, 0, 0, 0)`,
    ).run(id, 'g-' + id, mode, model);
  }

  it('supervised + canApprove provider => block', () => {
    makeGoal('g1', 'supervised');
    expect(resolveApprovalPosture(d, 'g1')).toBe('block');
  });

  it('autonomous => pass-through (auto-allow) even if provider can approve', () => {
    makeGoal('g2', 'autonomous');
    expect(resolveApprovalPosture(d, 'g2')).toBe('pass-through');
  });

  it('null goal (unlinked session) => pass-through', () => {
    expect(resolveApprovalPosture(d, null)).toBe('pass-through');
  });

  it('provider lacking canApprove => pass-through, regardless of mode', () => {
    // 'codex-model' resolves to a provider with canApprove:false in the (future) catalog.
    // Until Phase 1, providerCanApprove() returns true only for claude models; force the
    // non-claude branch here by passing an override.
    makeGoal('g3', 'supervised', 'gpt-5.5');
    expect(resolveApprovalPosture(d, 'g3')).toBe('pass-through');
  });
});
```

**Implement** — `server/approval-policy.ts`:

```ts
import type Database from 'better-sqlite3';

export type ApprovalPosture = 'block' | 'pass-through';

/**
 * Whether the provider behind `model` can participate in blocking approvals.
 *
 * PHASE1-FALLBACK: once the agent catalog (Delta C) lands, replace this body with
 *   catalog.find(p => p.id === resolveModel(model)?.provider)?.capabilities.canApprove === true
 * For now only Claude exists and Claude can approve; non-Claude model ids (gpt-*, gemini-*)
 * are treated as canApprove:false so Phase-3 providers degrade honestly the moment they appear.
 */
export function providerCanApprove(model: string | null): boolean {
  if (!model) return true; // default/unknown on a Claude-only install => Claude
  const m = model.toLowerCase();
  if (m.startsWith('gpt') || m.startsWith('codex') || m.startsWith('gemini') || m.startsWith('antigravity')) {
    return false;
  }
  return true; // claude family (opus/sonnet/haiku/fable/default)
}

/**
 * Resolves the approval posture for a goal's tool call:
 * - 'block'        — hold the hook open and wait for a UI decision (supervised + provider can approve)
 * - 'pass-through' — auto-allow immediately (autonomous, unlinked, or provider can't approve)
 */
export function resolveApprovalPosture(db: Database.Database, goalId: string | null): ApprovalPosture {
  if (!goalId) return 'pass-through';
  const row = db
    .prepare(`SELECT permission_mode, model FROM goals WHERE id = ?`)
    .get(goalId) as { permission_mode: string; model: string | null } | undefined;
  if (!row) return 'pass-through';
  if (row.permission_mode !== 'supervised') return 'pass-through';
  if (!providerCanApprove(row.model)) return 'pass-through';
  return 'block';
}
```

**Run:** `npx vitest run tests/server/approval-policy.test.ts` → green. **Commit:** `feat(4A): approval posture resolver gated by permission_mode + provider capability`.

---

### 4A — Task 2: route PreToolUse / PermissionRequest through `request()` (TDD)

**Goal:** in `hook-ingest.ts`, when posture is `block`, call `approvalCoordinator.request(...)` (blocking, supervised) and **return its decision**; when `pass-through`, keep `notify()` + immediate allow.

**Test first** — extend `tests/server/hook-ingest.test.ts` (node). Mirror the existing `createTestDb`/mock-broadcast setup. Add a `describe('onPreToolUse — enforcement')`:

```ts
import { resolveApprovalPosture } from '../../server/approval-policy';

// helper: insert a supervised goal so PreToolUse blocks
function insertSupervisedGoal(db: Database.Database, id: string) {
  db.prepare(
    `INSERT INTO goals (id, title, status, priority, permission_mode, model, kanban_order, created_at, updated_at)
     VALUES (?, ?, 'active', 0, 'supervised', 'opus', 0, 0, 0)`,
  ).run(id, 'g-' + id);
}

it('supervised goal: PreToolUse blocks until resolve(approved) => allow', async () => {
  insertSupervisedGoal(db, 'goal-sup');
  // session linked to the goal (session_id = goal_id convention)
  db.prepare(
    `INSERT INTO sessions (id, goal_id, origin, started_at, stream_event_count, hook_event_count, stderr_bytes)
     VALUES ('goal-sup', 'goal-sup', 'dashboard', 0, 0, 0, 0)`,
  ).run();

  const decisionPromise = ingest.onPreToolUse({ session_id: 'goal-sup', tool_name: 'Bash', tool_input: { command: 'ls' } });

  // an approval row appears as pending
  const pending = db.prepare(`SELECT id FROM approvals WHERE status = 'pending'`).get() as { id: string };
  expect(pending).toBeDefined();

  const ok = coordinator.resolve(pending.id, 'approved');
  expect(ok).toBe(true);

  await expect(decisionPromise).resolves.toEqual({ decision: 'allow' });
});

it('supervised goal: resolve(denied) => deny with reason', async () => {
  insertSupervisedGoal(db, 'goal-deny');
  db.prepare(
    `INSERT INTO sessions (id, goal_id, origin, started_at, stream_event_count, hook_event_count, stderr_bytes)
     VALUES ('goal-deny', 'goal-deny', 'dashboard', 0, 0, 0, 0)`,
  ).run();
  const p = ingest.onPreToolUse({ session_id: 'goal-deny', tool_name: 'Bash', tool_input: {} });
  const row = db.prepare(`SELECT id FROM approvals WHERE status='pending'`).get() as { id: string };
  coordinator.resolve(row.id, 'denied', 'nope');
  await expect(p).resolves.toEqual({ decision: 'deny', reason: 'nope' });
});

it('autonomous goal: PreToolUse passes through immediately (no blocking)', async () => {
  db.prepare(
    `INSERT INTO goals (id, title, status, priority, permission_mode, model, kanban_order, created_at, updated_at)
     VALUES ('goal-auto', 'a', 'active', 0, 'autonomous', 'opus', 0, 0, 0)`,
  ).run();
  db.prepare(
    `INSERT INTO sessions (id, goal_id, origin, started_at, stream_event_count, hook_event_count, stderr_bytes)
     VALUES ('goal-auto', 'goal-auto', 'dashboard', 0, 0, 0, 0)`,
  ).run();
  await expect(
    ingest.onPreToolUse({ session_id: 'goal-auto', tool_name: 'Bash', tool_input: {} }),
  ).resolves.toEqual({ decision: 'allow' });
});

it('unlinked session: PreToolUse passes through', async () => {
  await expect(
    ingest.onPreToolUse({ session_id: 'nope', tool_name: 'Bash', tool_input: {} }),
  ).resolves.toEqual({ decision: 'allow' });
});
```

> The existing `coordinator` in this test file is constructed with a **100ms** timeout (`new ApprovalCoordinator(db, 100)`), so the deny-by-timeout branch (`request()`'s `setTimeout`) is exercised cheaply. Keep that. (For the always-on server the real default is 30 min — `approval-coordinator.ts:41`.)

**Implement** — edit `server/hook-ingest.ts`. Import the resolver and replace the two `notify()`-then-allow bodies.

In `onPreToolUse` (currently `~299–308`):

```ts
import { resolveApprovalPosture } from './approval-policy';
// ...
const posture = resolveApprovalPosture(this.db, goalId);

if (posture === 'block') {
  // Supervised + provider can approve: hold the hook open until the UI decides
  // (request() inserts the pending row, broadcasts approval:pending, and resolves
  // when POST /approvals/:id/decide → coordinator.resolve(), or on timeout => deny).
  return this.approvalCoordinator.request(
    {
      session_id: sessionId,
      goal_id: goalId,
      tool_name: toolName,
      tool_args: JSON.stringify(payload.tool_input ?? {}),
    },
    false, // isAutonomous=false => blocking deferred
  );
}

// Pass-through: autonomous, unlinked, or non-approving provider.
// Broadcast a transient badge (auto-clears) but do not block.
this.approvalCoordinator.notify({
  session_id: sessionId,
  goal_id: goalId,
  tool_name: toolName,
  tool_args: JSON.stringify(payload.tool_input ?? {}),
});
return { decision: 'allow' };
```

Apply the **identical** change to `onPermissionRequest` (`~346–355`).

**Run:** `npx vitest run tests/server/hook-ingest.test.ts tests/server/approval-coordinator.test.ts` → green (the existing pass-through tests still pass because un-goaled/autonomous payloads take the `notify()` branch). **Commit:** `feat(4A): block supervised PreToolUse/PermissionRequest via ApprovalCoordinator.request`.

---

### 4A — Task 3: mount `<GlobalApprovalQueue/>` in AppShell (TDD)

**Goal:** the queue renders globally so a blocked hook is decidable. The store + WS dispatch are already wired (`ws-manager.ts:63–68`); only the mount is missing.

**Test first** — `tests/client/components/AppShell.test.tsx` (jsdom). If the file exists, add a case; else create it.

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import AppShell from '../../../src/components/AppShell';
import { useApprovalsStore } from '../../../src/stores/useApprovalsStore';
import type { Approval } from '../../../src/shared/types';

function approval(over: Partial<Approval> = {}): Approval {
  return {
    id: 'ap-1', session_id: 's1', goal_id: 'g1abcdef99', tool_name: 'Bash',
    tool_args: JSON.stringify({ command: 'ls' }), status: 'pending',
    decided_reason: null, requested_at: Date.now(), resolved_at: null, ...over,
  };
}

describe('AppShell — global approval queue', () => {
  beforeEach(() => { useApprovalsStore.setState({ pending: [], resolved: [] }); });

  it('does not render the queue when there are no pending approvals', () => {
    render(<MemoryRouter><AppShell><div>child</div></AppShell></MemoryRouter>);
    expect(screen.queryByText(/approval/i)).toBeNull();
  });

  it('renders the queue when an approval is pending', () => {
    useApprovalsStore.setState({ pending: [approval()], resolved: [] });
    render(<MemoryRouter><AppShell><div>child</div></AppShell></MemoryRouter>);
    expect(screen.getByText(/1 approval pending/i)).toBeInTheDocument();
    expect(screen.getByText('Bash')).toBeInTheDocument();
  });
});
```

> `GlobalApprovalQueue` returns `null` for empty `pending` (`GlobalApprovalQueue.tsx:38`), so the first assertion holds without conditional mount logic. `Sidebar` is rendered by AppShell and may need its stores; if `Sidebar` makes network calls in test, the existing AppShell test (if any) already stubs them — reuse that setup. If creating the file fresh and `Sidebar` errors, wrap the render to tolerate it or mock `../../../src/components/Sidebar`.

**Implement** — edit `src/components/AppShell.tsx`:

```ts
import GlobalApprovalQueue from './global/GlobalApprovalQueue';
// ...
{/* Global overlays */}
<ConnectionIndicator />
<ToastContainer />
<GlobalApprovalQueue />
<CommandPalette isOpen={isCommandPaletteOpen} onClose={closeCommandPalette} />
{tweaksOpen && <TweaksPanel />}
```

**Run:** `npx vitest run tests/client/components/AppShell.test.tsx` → green. **Commit:** `feat(4A): mount GlobalApprovalQueue in AppShell`.

---

### 4A — Task 4: end-to-end resolve-the-deferred regression (TDD)

**Goal:** lock the full server loop: a blocking `request()` is resolved by the route handler the UI calls, and the deferred promise settles. (Client→server HTTP is already covered by `tests/client/global-ux.test.tsx:457` posting to `/api/approvals/:id/decide`; this task proves the **server** route resolves the in-flight deferred.)

**Test first** — `tests/server/approvals-route.test.ts` (node). Build the router with a real `ApprovalCoordinator`, start a blocking `request()`, then call the route handler's logic via a supertest-style request (or call `coordinator.resolve` through the mounted Express app). Minimal version using `supertest` if present, else direct:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { runMigrations } from '../../server/db/migrate';
import { ApprovalCoordinator } from '../../server/approval-coordinator';
import { createApprovalsRouter } from '../../server/routes/approvals';

describe('POST /approvals/:id/decide resolves a blocking request()', () => {
  let db: Database.Database; let coord: ApprovalCoordinator; let app: express.Express;
  beforeEach(() => {
    db = new Database(':memory:'); db.pragma('foreign_keys = ON'); runMigrations(db);
    coord = new ApprovalCoordinator(db, 5_000);
    app = express(); app.use(express.json()); app.use('/api', createApprovalsRouter(db, coord));
  });
  afterEach(() => { coord.shutdown(); db.close(); });

  it('approve resolves the pending deferred with allow', async () => {
    const pending = coord.request(
      { session_id: 's', goal_id: 'g', tool_name: 'Bash', tool_args: '{}' }, false,
    );
    const row = db.prepare(`SELECT id FROM approvals WHERE status='pending'`).get() as { id: string };
    const res = await request(app).post(`/api/approvals/${row.id}/decide`).send({ decision: 'approved' });
    expect(res.status).toBe(200);
    await expect(pending).resolves.toEqual({ decision: 'allow' });
  });
});
```

> If `supertest` is **not** a dev dependency, skip the HTTP layer and assert directly: `coord.resolve(id, 'approved')` returns `true` and `await pending` settles. Check `package.json` first; do not add a dependency for a single test if the direct path proves the contract.

**Implement:** no production change expected — this is a **characterization test** that the wiring from Tasks 1–2 is end-to-end. If it fails, the bug is in Task 2's `request()` call shape; fix there.

**Run:** `npx vitest run tests/server/approvals-route.test.ts` → green. **Commit:** `test(4A): regression — decide route resolves blocking approval deferral`.

---

### 4A — ALTERNATIVE PATH (do NOT combine with the default): REMOVE approvals

Only if the user explicitly chooses to drop approvals rather than enforce them:

- Delete `ApprovalCoordinator.notify()` and the `notify()` calls in `hook-ingest.ts` (keep `request()`/`resolve()` only if Phase 6 still needs them; otherwise delete the whole coordinator + route + `approvals` table reads).
- Delete `GlobalApprovalQueue.tsx`, `ApprovalCard.tsx`, `useApprovalsStore.ts`, and the `approval:*` cases in `ws-manager.ts` + `events.ts`.
- Update the README/UI so no approval affordance is advertised.

**This contradicts Phase 6's "approvals can block" dependency — flag it to the user before taking this path.** Default remains enforce+mount.

### 4A — Self-Review

- ✅ Supervised+Claude goals now **block** on PreToolUse/PermissionRequest and wait for a real UI decision (Task 2).
- ✅ Capability gate present (`providerCanApprove`) with a single `// PHASE1-FALLBACK` line to swap for the catalog (Task 1) — non-Claude providers pass through, documented.
- ✅ `<GlobalApprovalQueue/>` mounted; store/WS already wired (Task 3).
- ✅ Deferred resolves via the existing route end-to-end (Task 4).
- ⚠️ **Missing contract:** `AgentCatalogEntry.capabilities.canApprove` is not on the branch yet — the gate uses a model-prefix heuristic until Phase 1 Delta C lands. Tighten then.
- ⚠️ Autonomous goals still spawn with `--permission-mode bypassPermissions` (`pty-manager.ts:86`) — blocking only ever applies to **supervised** goals; autonomous is auto-allow by design.

---

# 4B — Trace Subsystem

## Problem (verified)

- `server/routes/trace.ts` `createTraceRouter` is **never mounted** in `server/index.ts` (the `apiRouters` array at `:296` lacks it).
- `server/trace-writer.ts` `TraceWriter` is **never instantiated** by `PtyManager` (`server/pty-manager.ts` writes no trace files).
- `server/hook-ingest.ts` hard-codes `trace_dir NULL` on session insert (`:191–192`, `VALUES (?, ?, ?, ?, ?, ?, NULL, ...)`).
- `server/trace-pruner.ts` `pruneTraces` is **never scheduled**.
- **No trace DB table is required** — `sessions.trace_dir TEXT` already exists (`migrations/001_init.sql:39`). **No migration in 4B.**
- `TraceWriter` and `pruneTraces` are already unit-tested (`tests/server/trace-writer.test.ts`, `trace-pruner.test.ts`); this group adds the **wiring** + its tests only.

Trace dir convention (matches `trace-pruner.ts:23` safety check, which only deletes under `<dataDir>/traces/`): **`<dataDir>/traces/<sessionId>/`**.

---

### 4B — Task 1: mount `createTraceRouter` in index.ts (TDD)

**Goal:** the GET trace endpoints (`/api/sessions/:id/trace/*`, `/api/goals/:id/trace`) are reachable.

**Test first** — `tests/server/trace-route.test.ts` (node), using the same in-memory-DB + express pattern as 4A Task 4:

```ts
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/db/migrate';
import { createTraceRouter } from '../../server/routes/trace';

// build app with the router mounted under /api
// 404 when session has no trace_dir; 404 when session absent.
it('returns 404 for a session with no trace_dir', async () => {
  const db = new Database(':memory:'); runMigrations(db);
  db.prepare(`INSERT INTO sessions (id, origin, started_at, stream_event_count, hook_event_count, stderr_bytes) VALUES ('s1','external',0,0,0,0)`).run();
  const app = express(); app.use('/api', createTraceRouter(db, '/tmp/data'));
  const res = await request(app).get('/api/sessions/s1/trace/stream');
  expect(res.status).toBe(404);
});
```

**Implement** — `server/index.ts`:

```ts
import { createTraceRouter } from './routes/trace';
// ...
const traceRouter = createTraceRouter(db, env.dataDir);
// add to the apiRouters array (~:296):
const app = createApp({ apiRouters: [
  scheduledRouter, goalsRouter, sessionsRouter, hooksRouter,
  approvalsRouter, systemRouterWithSkills, skillsRouter, traceRouter,
] });
```

**Run:** `npx vitest run tests/server/trace-route.test.ts` → green. **Commit:** `feat(4B): mount trace router in index`.

---

### 4B — Task 2: populate `session.trace_dir` on insert (TDD)

**Goal:** every session row carries its trace directory so the router/pruner can find files. `HookIngest.onSessionStart` is the canonical session-creation site; it must compute and store `<dataDir>/traces/<sessionId>`.

**Design:** `HookIngest` has no `dataDir` today. Add an optional constructor arg `traceRootDir?: string` (default `null` → preserves current NULL behavior so existing tests pass unchanged). When provided, write `path.join(traceRootDir, sessionId)`.

**Test first** — extend `tests/server/hook-ingest.test.ts`:

```ts
it('populates trace_dir under the configured traces root when set', () => {
  const ingestWithTrace = new HookIngest(db, coordinator, undefined, '/data/traces');
  ingestWithTrace.onSessionStart({ session_id: 'ts-1', cwd: '/x' });
  const row = db.prepare(`SELECT trace_dir FROM sessions WHERE id='ts-1'`).get() as { trace_dir: string };
  expect(row.trace_dir).toBe(require('node:path').join('/data/traces', 'ts-1'));
});

it('leaves trace_dir NULL when no traces root is configured (back-compat)', () => {
  ingest.onSessionStart({ session_id: 'ts-2', cwd: '/x' });
  const row = db.prepare(`SELECT trace_dir FROM sessions WHERE id='ts-2'`).get() as { trace_dir: string | null };
  expect(row.trace_dir).toBeNull();
});
```

**Implement** — `server/hook-ingest.ts`:
1. Add field + ctor param (after `skillExecutionService`): `private traceRootDir: string | null;` set from a 4th arg `traceRootDir?: string` → `?? null`.
2. In `onSessionStart`, compute `const traceDir = this.traceRootDir ? path.join(this.traceRootDir, sessionId) : null;` (import `path` at top).
3. Change the INSERT (`:191`) from the literal `NULL` to a bound `?` and pass `traceDir`:
```ts
`INSERT INTO sessions (id, goal_id, origin, cwd, model, display_name, trace_dir, stream_event_count, hook_event_count, stderr_bytes, started_at, ended_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, 0, ?, NULL)`
// .run(sessionId, linkedGoalId, origin, cwd, model, displayName, traceDir, now)
```
4. In `server/index.ts`, pass the root when constructing `HookIngest` (`:115`):
```ts
import { join } from 'node:path'; // already imported
const hookIngest = new HookIngest(db, approvalCoordinator, skillExecutionService, join(env.dataDir, 'traces'));
```

**Run:** `npx vitest run tests/server/hook-ingest.test.ts` → green. **Commit:** `feat(4B): persist session.trace_dir = <dataDir>/traces/<sessionId>`.

---

### 4B — Task 3: schedule `pruneTraces` via node-cron (TDD)

**Goal:** old traces are pruned daily using the persisted `config.tracePruneDays`.

**Design:** add `server/trace-prune-job.ts` exporting `startTracePruneJob(db, dataDir, getPruneDays)` that registers a daily cron (`'0 3 * * *'`, 03:00) and on each fire calls `pruneTraces(db, dataDir, getPruneDays())`. `getPruneDays` is a thunk so the value is read fresh each run (respects Settings changes without restart). Returns the cron task so `shutdown()` can `.stop()` it.

**Test first** — `tests/server/trace-prune-job.test.ts` (node). Don't wait for real cron — assert the job invokes the pruner with the thunk's value. Use a fake cron via `vi.mock('node-cron', ...)` exposing the registered callback, then invoke it:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

let registered: (() => void) | null = null;
vi.mock('node-cron', () => ({
  default: { schedule: (_expr: string, cb: () => void) => { registered = cb; return { stop: vi.fn() }; } },
}));

const pruneMock = vi.fn().mockReturnValue(0);
vi.mock('../../server/trace-pruner', () => ({ pruneTraces: (...a: unknown[]) => pruneMock(...a) }));

import Database from 'better-sqlite3';
import { runMigrations } from '../../server/db/migrate';
import { startTracePruneJob } from '../../server/trace-prune-job';

describe('startTracePruneJob', () => {
  beforeEach(() => { registered = null; pruneMock.mockClear(); });

  it('runs pruneTraces with the value from getPruneDays() each fire', () => {
    const db = new Database(':memory:'); runMigrations(db);
    let days = 90;
    const task = startTracePruneJob(db, '/data', () => days);
    expect(registered).toBeTypeOf('function');

    registered!();
    expect(pruneMock).toHaveBeenLastCalledWith(db, '/data', 90);

    days = 7;                 // Settings changed at runtime
    registered!();
    expect(pruneMock).toHaveBeenLastCalledWith(db, '/data', 7);

    task.stop();
    db.close();
  });
});
```

**Implement** — `server/trace-prune-job.ts`:

```ts
import cron from 'node-cron';
import type Database from 'better-sqlite3';
import { pruneTraces } from './trace-pruner';
import logger from './logger';

/**
 * Schedules a daily (03:00) trace-pruning job. `getPruneDays` is read on each
 * fire so Settings changes take effect without a restart. Returns the cron task
 * (call .stop() on shutdown).
 */
export function startTracePruneJob(
  db: Database.Database,
  dataDir: string,
  getPruneDays: () => number,
) {
  const task = cron.schedule('0 3 * * *', () => {
    try {
      const days = getPruneDays();
      const pruned = pruneTraces(db, dataDir, days);
      logger.info({ pruned, days }, 'Scheduled trace prune complete');
    } catch (err) {
      logger.error({ err }, 'Scheduled trace prune failed');
    }
  });
  logger.info('Trace prune job scheduled (daily 03:00)');
  return task;
}
```

**Wire in `server/index.ts`:**
```ts
import { startTracePruneJob } from './trace-prune-job';
import { join } from 'node:path';
// ConfigService thunk — PHASE1-FALLBACK:
//   If ConfigService (Phase 1 Task 8) is present, use configService.getPersisted().tracePruneDays.
//   Until then, default to 90 (matches pruneTraces default + system.ts traceRetentionDays).
const getPruneDays = () => /* configService?.getPersisted().tracePruneDays ?? */ 90;
const tracePruneTask = startTracePruneJob(db, join(env.dataDir, 'traces'), getPruneDays);
```
Add to `shutdown()` (alongside `scheduler.stop()`): `tracePruneTask.stop();`.

**Run:** `npx vitest run tests/server/trace-prune-job.test.ts` → green. **Commit:** `feat(4B): schedule daily trace pruning using config.tracePruneDays`.

---

### 4B — Task 4: instantiate `TraceWriter` in `PtyManager` (TDD)

**Goal:** running sessions actually write `stream.jsonl` / `stderr.log` / `meta.json` to their `trace_dir`, so the now-reachable endpoints serve real files.

**Design:** `PtyManager` receives the goal but not the session's trace dir. Since session_id = goal_id for dashboard spawns, the trace dir is `<dataDir>/traces/<goalId>`. Pass `traceDir` via `PtyManagerOptions` (optional → back-compat: no writer when absent). On `start()`/`resume()`:
- create `new TraceWriter(this.goalId, traceDir)`,
- in the `onData` handler, `traceWriter?.appendStream(data)` (raw CLI stdout) — note PTY data is the rendered terminal stream, which is the trace we have; `stderr` is not separately available from node-pty, so `stderr.log` stays empty (documented),
- on `onExit`, `await traceWriter?.writeMeta({ session_id, exitCode, ended_at: Date.now() })` then `traceWriter?.close()`.

> Honest limitation to document inline: node-pty multiplexes stdout+stderr into one stream, so `stream.jsonl` gets the combined PTY output and `stderr.log` is empty for PTY sessions. `hooks.jsonl` is populated by `HookIngest` only if we also thread the writer there — **out of scope for 4B-PTY**; note it as a follow-up (the GET `/trace/hooks` endpoint will 404 until a future task wires `appendHook`). Keeping 4B to PTY stream + meta is the bite-sized cut.

**Test first** — `tests/server/pty-manager-trace.test.ts` (node). Mock `node-pty` so no real process spawns; capture the `onData`/`onExit` callbacks and drive them; assert files exist under a temp dir. Pattern:

```ts
import os from 'node:os'; import fs from 'node:fs'; import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const onDataCbs: Array<(d: string) => void> = [];
const onExitCbs: Array<(e: { exitCode: number }) => void> = [];
vi.mock('node-pty', () => ({
  spawn: () => ({
    onData: (cb: (d: string) => void) => onDataCbs.push(cb),
    onExit: (cb: (e: { exitCode: number }) => void) => onExitCbs.push(cb),
    write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
  }),
}));
vi.mock('../../server/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { PtyManager } from '../../server/pty-manager';

it('writes stream.jsonl and meta.json to traceDir over the session lifecycle', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-'));
  const traceDir = path.join(tmp, 'goal-1');
  const goal: any = { id: 'goal-1', cwd: tmp, permission_mode: 'supervised', model: 'default' };
  const mgr = new PtyManager(goal, { broadcast: vi.fn(), traceDir });
  mgr.start();
  onDataCbs.forEach((cb) => cb('{"type":"x"}\n'));
  onExitCbs.forEach((cb) => cb({ exitCode: 0 }));
  await new Promise((r) => setTimeout(r, 20)); // allow async writeMeta/close
  expect(fs.existsSync(path.join(traceDir, 'stream.jsonl'))).toBe(true);
  expect(fs.readFileSync(path.join(traceDir, 'stream.jsonl'), 'utf-8')).toContain('"type":"x"');
  expect(fs.existsSync(path.join(traceDir, 'meta.json'))).toBe(true);
});
```

**Implement** — `server/pty-manager.ts`:
1. `import { TraceWriter } from './trace-writer';`
2. `PtyManagerOptions` gains `traceDir?: string;`
3. Field `private traceWriter: TraceWriter | null = null;` and `private readonly traceDir: string | undefined;` set in ctor.
4. In `start()` (and `resume()`), before/after spawn: `if (this.traceDir) this.traceWriter = new TraceWriter(this.goalId, this.traceDir);`
5. In the `onData` handler: `this.traceWriter?.appendStream(data);`
6. In the `onExit` handler (both methods): wrap the existing body to also
   ```ts
   void (async () => {
     try {
       await this.traceWriter?.writeMeta({ session_id: this.goalId, exitCode, ended_at: Date.now() });
       await this.traceWriter?.close();
     } catch (err) { logger.error({ err, goalId: this.goalId }, 'TraceWriter close failed'); }
   })();
   ```
7. In `cleanup()`, also `await this.traceWriter?.close();` (idempotent; `close()` is guarded).
8. In `server/index.ts`, pass `traceDir: join(env.dataDir, 'traces', goalId)` into **both** `new PtyManager(goal, { ... })` option objects (`spawnTerminalSession` ~:164 and `restartSession` ~:254).

**Run:** `npx vitest run tests/server/pty-manager-trace.test.ts` → green. Then full server suite `npx vitest run tests/server` to confirm no regression. **Commit:** `feat(4B): write per-session PTY trace via TraceWriter`.

### 4B — Self-Review

- ✅ Router mounted (Task 1); `trace_dir` populated (Task 2); pruning scheduled w/ live config (Task 3); PTY writes stream+meta (Task 4).
- ✅ **No migration** — `sessions.trace_dir` pre-exists; pruner safety-check root (`<dataDir>/traces/`) matches the dir convention used everywhere.
- ⚠️ `stderr.log` stays empty and `hooks.jsonl` unwired for PTY sessions (node-pty multiplexes; hook→writer threading is a documented follow-up). GET `/trace/stderr` and `/trace/hooks` 404 until then — acceptable; `/trace/stream`, `/trace/meta`, `/trace/bundle` work.
- ⚠️ `config.tracePruneDays` read via a `// PHASE1-FALLBACK` thunk (defaults 90) until ConfigService lands.

---

# 4C — Interrupt Wiring + Persisted Home-Route

## Problem (verified)

- `server/routes/goals.ts` POST `/goals/:id/interrupt` (`~340–355`) returns `{ killed: true }` **without touching `processRegistry`** — the comment literally says `// B1 integration: processRegistry.get(id)?.interrupt()`.
- `src/routes.tsx:20` hardcodes `{ index: true, element: <Navigate to="/board" replace /> }` instead of reading the (now-persisted) `config.homeRoute`. `HomeRouteToggle.tsx` PUTs `homeRoute` to `/api/config` but nothing reads it back at the index route.

---

### 4C — Task 1: wire interrupt to `processRegistry` (TDD)

**Goal:** POST `/goals/:id/interrupt` calls the live runner's `interrupt()` and transitions the goal to `waiting`.

**Design:** the goals router is created by `createGoalsRouter(goalService, spawnTerminal, interGoalMessageService)`. It needs access to `processRegistry` — import the singleton directly in `goals.ts` (it is a module singleton, `export const processRegistry`). The handler: look up the goal (404 if absent), `const runner = processRegistry.get(goal.id)`, if present `await runner.interrupt()` and set status `waiting`; return `{ killed: <bool> }` reflecting whether a runner existed.

**Test first** — locate the existing goals-route test (`tests/server/*goals*`) and add a case; if none, create `tests/server/goals-interrupt.test.ts`. Mock `processRegistry`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/db/migrate';
import { createGoalService } from '../../server/services/goal-service';

const interruptMock = vi.fn().mockResolvedValue(undefined);
const getMock = vi.fn();
vi.mock('../../server/process-registry', () => ({
  processRegistry: { get: (id: string) => getMock(id) },
}));
vi.mock('../../server/ws', () => ({ broadcast: vi.fn() }));

import { createGoalsRouter } from '../../server/routes/goals';

function appWith(db: Database.Database) {
  const svc = createGoalService(db);
  const app = express(); app.use(express.json());
  app.use('/api', createGoalsRouter(svc, undefined, undefined as any));
  return { app, svc };
}

describe('POST /goals/:id/interrupt', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys=ON'); runMigrations(db); getMock.mockReset(); interruptMock.mockClear(); });
  afterEach(() => db.close());

  it('404 when goal missing', async () => {
    const { app } = appWith(db);
    const res = await request(app).post('/api/goals/nope/interrupt');
    expect(res.status).toBe(404);
  });

  it('calls runner.interrupt() and returns killed:true when a runner is live', async () => {
    const { app, svc } = appWith(db);
    const g = svc.create({ title: 'g', cwd: '/x', permission_mode: 'supervised', model: 'default' } as any);
    getMock.mockReturnValue({ interrupt: interruptMock, cleanup: vi.fn() });
    const res = await request(app).post(`/api/goals/${g.id}/interrupt`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ killed: true });
    expect(interruptMock).toHaveBeenCalledOnce();
    expect(svc.get(g.id)!.status).toBe('waiting');
  });

  it('returns killed:false when no runner is registered', async () => {
    const { app, svc } = appWith(db);
    const g = svc.create({ title: 'g2', cwd: '/x', permission_mode: 'supervised', model: 'default' } as any);
    getMock.mockReturnValue(undefined);
    const res = await request(app).post(`/api/goals/${g.id}/interrupt`);
    expect(res.body).toEqual({ killed: false });
  });
});
```

**Implement** — `server/routes/goals.ts`:
```ts
import { processRegistry } from '../process-registry';
// ...
router.post('/goals/:id/interrupt', async (req: Request, res: Response) => {
  try {
    const goal = goalService.get(String(req.params['id']));
    if (!goal) { res.status(404).json({ error: 'Goal not found' }); return; }

    const runner = processRegistry.get(goal.id);
    if (runner) {
      await runner.interrupt();
      goalService.update(goal.id, { status: 'waiting' });
      res.json({ killed: true });
      return;
    }
    res.json({ killed: false });
  } catch (err) {
    logger.error({ err }, 'Failed to interrupt goal');
    res.status(500).json({ error: 'Failed to interrupt goal' });
  }
});
```
(Make the handler `async`.)

**Run:** `npx vitest run tests/server/goals-interrupt.test.ts` → green. **Commit:** `feat(4C): wire goal interrupt to processRegistry.interrupt() + status=waiting`.

---

### 4C — Task 2: index route reads persisted `config.homeRoute` (TDD)

**Goal:** navigating to `/` redirects to the configured home route (`/board` fallback), read from `/api/config`.

**Design:** `routes.tsx`'s `{ index: true }` element is static. Replace the static `<Navigate to="/board">` with a tiny `<HomeRedirect/>` component that reads `config.homeRoute` (from `useConfigStore`, populated at app boot) and `<Navigate>`s there, defaulting to `/board` while config is null/loading. The config must be fetched once at boot — add a `GET /api/config` fetch into the existing boot path (`App.tsx` already runs `useWsManager()`; add a `useEffect` that fetches `/api/config` and `setConfig`). `useConfigStore` already exists.

> The server `GET /api/config` (`system.ts:131`) returns `homeRoute` today (hardcoded `/board`); once ConfigService (Phase 1) backs it, the same client code reads the persisted value with no change. `// PHASE1-FALLBACK`: no client change needed when Phase 1 lands — only the server response becomes dynamic.

**Test first** — `tests/client/components/HomeRedirect.test.tsx` (jsdom):
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import HomeRedirect from '../../../src/components/HomeRedirect';
import { useConfigStore } from '../../../src/stores/useConfigStore';

function renderAt(home: string | null) {
  if (home) useConfigStore.setState({ config: { homeRoute: home } as any });
  else useConfigStore.setState({ config: null });
  const router = createMemoryRouter([
    { path: '/', element: <HomeRedirect /> },
    { path: '/board', element: <div>BOARD</div> },
    { path: '/dashboard', element: <div>DASH</div> },
  ], { initialEntries: ['/'] });
  render(<RouterProvider router={router} />);
}

describe('HomeRedirect', () => {
  beforeEach(() => useConfigStore.setState({ config: null }));
  it('falls back to /board when config is null', () => { renderAt(null); expect(screen.getByText('BOARD')).toBeInTheDocument(); });
  it('redirects to /dashboard when configured', () => { renderAt('/dashboard'); expect(screen.getByText('DASH')).toBeInTheDocument(); });
});
```

**Implement** — `src/components/HomeRedirect.tsx`:
```ts
import { Navigate } from 'react-router';
import { useConfigStore } from '../stores/useConfigStore';

/** Index-route redirect to the user's configured home route ('/board' fallback). */
export default function HomeRedirect() {
  const home = useConfigStore((s) => s.config?.homeRoute) ?? '/board';
  return <Navigate to={home} replace />;
}
```
`src/routes.tsx`:
```ts
import HomeRedirect from './components/HomeRedirect';
// ...
{ index: true, element: <HomeRedirect /> },
```
`src/App.tsx` (boot fetch of config):
```ts
import { useEffect } from 'react';
import { useConfigStore } from './stores/useConfigStore';
// inside App():
const setConfig = useConfigStore((s) => s.setConfig);
useEffect(() => {
  fetch('/api/config').then((r) => r.json()).then(setConfig).catch(() => {});
}, [setConfig]);
```

**Run:** `npx vitest run tests/client/components/HomeRedirect.test.tsx` → green. **Commit:** `feat(4C): index route reads persisted config.homeRoute (board fallback)`.

### 4C — Self-Review

- ✅ Interrupt now kills the live PTY (`runner.interrupt()` is the real node-pty kill, `pty-manager.ts:328`) and flips the goal to `waiting`; honest `killed` boolean.
- ✅ Home-route is config-driven with `/board` fallback; client reads `/api/config` at boot — works pre- and post-Phase-1 with no client change.
- ⚠️ Depends on `processRegistry` singleton import in `goals.ts` (present, live). No migration.

---

# 4D — Markdown View + Edit

**Status:** design exists and its blocker is cleared. **Recommendation: ship as its own plan**, written now via `superpowers:writing-plans` against `docs/superpowers/specs/2026-06-08-markdown-view-edit-design.md`. It is larger than the other three groups (shared component + two save backends + guarded write endpoint) and orthogonal to approvals/trace/interrupt — folding it inline would bloat this plan past bite-size.

The design was **"Blocked on the Persistent Settings goal"** (spec §8) for one reason only: the **editable-roots allowlist** for the generic `PUT /api/file` write endpoint (spec §7). **Phase 1 (settings persistence + the "Document roots" list via `ConfigService`) clears exactly that blocker.** Everything else in the spec (§5 component, §6 contract, the skill-save path via `skill-file-service.saveSkillContent`) was never blocked.

**Enable/wire checklist (so it is not forgotten — expand into the dedicated plan):**

1. **Reconcile §7 allowlist source with Phase 1.** The write allowlist = the persisted "Document roots" list from `ConfigService` (Phase 1 Task 8/10). Add a `getDocumentRoots()` accessor; `PUT /api/file` resolves `realpathSync(target)` and accepts only if under an allowed root (else 403). Until that Settings list exists, seed roots from the existing `skill_directories` + each goal's `cwd` as the minimum allowlist.
2. **Build `src/components/shared/MarkdownView.tsx` + `markdownProse.ts`** (spec §5/§6) — md/txt read toggle + distinct Edit→textarea→Save/Cancel; `onSave` omitted ⇒ read-only. De-dupe the copy-pasted `prose` block now in `SkillsPage.tsx` + `GoalPlanPane.tsx`.
3. **Add `skill-file-service.saveSkillContent(skillPath, skillName, newContent, changeReason, expectedHash?)`** — snapshot current content as a `skill_versions` row (mirroring `applySuggestion`) then write; expose via a skill route. (Bypasses the generic endpoint; reuses version history.)
4. **Add guarded `PUT /api/file`** (spec §7 guards: allowlist-by-root, no traversal/symlink-escape, edit-only/must-exist, text+≤1 MB, optimistic concurrency via `mtimeMs` → 409, audit line).
5. **Wire the three call sites** (`ClaudeMdPage.tsx:154`, `SkillsPage.tsx:618`, `GoalPlanPane.tsx:354`) to `MarkdownView`, each supplying the correct `onSave` (skill-save for skills; `PUT /api/file` for CLAUDE.md + goal docs).
6. **TDD per spec §9** — MarkdownView unit (defaults pretty, toggle, edit/save/cancel, read-only); `PUT /api/file` (traversal/outside-root/non-existent/oversized/binary rejected, valid accepted, 409 on mtime mismatch); `saveSkillContent` (writes + version row, stale-hash error); keep existing SkillsPage test green.

**Out of scope** (spec §10): create/delete/rename, WYSIWYG, toggle persistence, orchestrator `memory.md` UI, collaborative editing.

### 4D — Self-Review

- ✅ Blocker (editable-roots from persisted settings) is explicitly tied to Phase 1's Document-roots list — the one dependency the spec named.
- ✅ Enable/wire steps captured so the feature is not dropped even though it ships as its own plan.
- ⚠️ **Missing contract:** Phase 1's "Document roots" Settings list is the allowlist source; if Phase 1 ships config persistence **without** a Document-roots field, 4D-step-1's fallback (skill_directories + goal cwds) is required. Confirm with Phase 1's final shape.

---

## Overall Self-Review (plan author)

**Coverage vs. the four asks:**
- 4A — supervised approvals route through `request()` (blocking), `<GlobalApprovalQueue/>` mounted, decide-route resolves the deferred end-to-end; capability-gated; remove-path documented as the explicit alternative. ✅
- 4B — router mounted, `trace_dir` persisted, pruning scheduled (live config), PTY writes stream+meta; **no migration** (column pre-exists). ✅
- 4C — interrupt wired to `processRegistry.interrupt()`; index route reads persisted `homeRoute`. ✅
- 4D — referenced its design; ships as its own plan now the settings-persistence blocker is cleared; enable/wire steps inlined so nothing is forgotten. ✅

**TDD discipline:** every code task is test-first with an exact `tests/server/**` (node) or `tests/client/**` (jsdom) path, real code (no placeholders), one commit per task.

**Phase-1 coupling, made independent:** 4A's `canApprove` gate, 4B-prune's `tracePruneDays`, and 4C's `homeRoute` all consume Phase-1 contracts that are **not yet on this branch**. Each has a `// PHASE1-FALLBACK` seam so the task lands now and tightens to one line when Phase 1 merges. None of the four groups blocks another.

**Known risks called out inline:** capability gate is a model-prefix heuristic until Delta C's catalog lands (4A); node-pty multiplexes stdout/stderr so `stderr.log`/`hooks.jsonl` stay empty for PTY traces (4B, follow-up); `supertest` may be absent → direct-assert fallback noted (4A/4B/4C); 4D's allowlist source depends on Phase 1 exposing a Document-roots field (fallback to skill_directories + goal cwds).

**Migrations used: none.**
