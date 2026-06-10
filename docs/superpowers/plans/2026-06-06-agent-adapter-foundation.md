# Agent Adapter Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a provider abstraction (`AgentAdapter`) so Claude-Deck can run multiple LLM CLIs, with Claude refactored into the first adapter — Claude behavior must remain byte-for-byte identical.

**Architecture:** A shared `AgentAdapter` interface encapsulates everything that varies per CLI (binary, spawn args, prompt injection, MCP config, hook install, usage parsing). A registry maps a `model` string → its adapter. App config gains `enabledProviders`, now persisted as a JSON blob in SQLite. The Settings page exposes a provider toggle. No new agent runs yet — the Antigravity adapter is a follow-on spec.

**Tech Stack:** TypeScript 5.5 (strict), Express v5, better-sqlite3, Zod, React 19, Vitest. Spec: `docs/superpowers/specs/2026-06-06-agent-adapter-foundation-design.md`. Base: `main` @ `b43cfa6`.

**Branch:** `feat/agent-adapter-foundation` (already created; the spec is committed there).

**TDD rhythm (every task):** write failing test → run it, confirm it fails for the expected reason → write minimal code → run it, confirm pass → run `npm run typecheck` → commit. Commands are listed per task; the rhythm is not re-spelled each time but every task ends in a green test + commit.

---

## ⚠️ Plan Revisions (2026-06-08) — read first; these OVERRIDE the task text below

After this plan was written, `main` absorbed a large analytics redesign + skill-tracking merge
(`DW-32001`/`DW-32000`) plus deploy/perf commits. Re-validated against current `main`. The architecture is
unchanged; these deltas apply:

- **Migration number:** `012_session_usage`, `013_skill_tracking`, `014_hook_events_session_index` now exist.
  Task 3's migration is **`015_app_config.sql`** (version `15`), not `014`.
- **Task 8 is simplified to "real `/api/config` + provider catalog only."** Analytics is now table-backed
  (`server/services/ingestion-service.ts` → `session_usage` table; endpoints query it). Do **NOT** refactor the
  analytics pipeline in the Foundation — it works and is Claude-only. Provider-aware ingestion is deferred to
  **Spec B** (Antigravity), whose adapter usage methods (`listSessionLogs`/`parseUsage`) will feed
  `ingestion-service` then. (Deviation from spec §5, intentional: preserves behavior, YAGNI.)
- **Task 9:** `pty-manager.ts` was rewritten. Current anchors: `start()` ~L83, `resume()` ~L212,
  `buildMcpConfig()` ~L339, constructor ~L75 (`constructor(goal, options)` with an `onReady?` option). The
  arg-building logic is byte-identical to the `ClaudeAdapter` in Task 6 **except** the MCP env also includes
  `CLAUDE_DECK_GOAL_ID: goalId` — so `McpServerDescriptor.env` must carry `{ CLAUDE_DECK_URL, CLAUDE_DECK_GOAL_ID }`.
  Preserve the `onReady` callback and the idle/regex/45s-fallback machinery (parameterize `idleMs` + regex from
  `adapter.promptStrategy`). `new PtyManager` call sites in `index.ts` are now **L164 and L254**.
- **Task 5:** unchanged, but its primitives are consumed by the `ClaudeAdapter` interface impl only — not wired
  into the (table-backed) analytics pipeline in the Foundation. That wiring is Spec B.
- **Task 0 (expanded):** also fix the pre-existing red baseline (user-approved): the `broadcast()`/`ServerEvent`
  typecheck mismatch for `skill:*` events (note `events.ts` already lists them in `ServerEventSchema` — pin the
  actual mismatch, likely the `broadcast` signature in `server/ws.ts`), the `execFile` `input`-option type error
  in the skill services, and the 2 failing `tests/client/pages/SkillsPage.test.tsx` cases (`toString` of
  undefined). Target: `npm test` 0 failed, `npm run typecheck` clean.

---

## ⚠️ Plan Revisions (2026-06-09) — read first; these OVERRIDE task text below

These deltas come from `docs/superpowers/plans/2026-06-09-master-roadmap.md` (§2 decisions + "Phase 1 — deltas A/B/C") and the sibling-branch reconciliation in `docs/superpowers/specs/2026-06-08-settings-persistence-design.md`. They **override** the corresponding task text below. Apply them as written; the original task bodies are kept for context only.

**Branch reality verified on `feat/multi-agent-foundation` (2026-06-09):** migrations stop at **`014_hook_events_session_index.sql`**; there is **no** `015_app_config.sql`, **no** `PersistedConfigSchema`/`enabledProviders` in `src/shared/schemas.ts`, and **no** `src/shared/agents/model-registry.ts`. Therefore:
- The 2026-06-08 revision's "migration is **`015_app_config.sql`** (version 15)" still holds for Task 3 (next free number is 015 on this branch).
- Delta B's reconciliation path **(a)** is the active one here (define the record shape directly). Path **(b)** + migration `016_provider_config.sql` only applies **if** the sibling `feat/multi-agent-impl` branch (which shipped 015 with `enabledProviders: string[]`) is merged onto this branch first. Both paths are specified below; pick by checking `git log` / `server/db/migrations/` for `015_app_config.sql` at execution time.

**Dependency added:** Phase 0A's `src/shared/agents/model-registry.ts` (single source of truth for pricing/tier/contextWindow via `resolveModel(raw)`) **must exist before Task 5/6** — Delta D makes those tasks delegate to it. If it is not present, stop and build it (Phase 0A plan) first.

### Delta A — `RawUsage` carries a per-model breakdown (amends Task 1 types + Task 5 `parseUsage`)
Decision 4 (per-model attribution) needs `RawUsage` to break tokens down per model **before** Task 1 is committed and consumed by Task 5/6. This is a 1-shaped change now and a 3-adapter breaking change later — **land it before committing Task 1.** Replace the `RawUsage` interface in `src/shared/agents/types.ts` with:
```ts
/** Per-model token totals within a session. */
export interface RawModelUsage {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  messageCount: number;
}

/** Session usage: top-level fields are the rolled-up session totals (back-compat);
 *  `byModel` carries the per-model rows (single-model sessions → 1-element array). */
export interface RawUsage extends RawModelUsage {
  byModel: RawModelUsage[];
}
```
- **Task 1 test (`tests/shared/agents/types.test.ts`)** must construct the new shape, e.g.:
  ```ts
  const u: RawUsage = {
    inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, messageCount: 1, model: 'claude-opus-4-8',
    byModel: [{ inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, messageCount: 1, model: 'claude-opus-4-8' }],
  };
  ```
- **Task 5 `parseClaudeUsage` is amended** (see the "Delta A — amended Task 5 Step 4.3" block under Task 5 below) to aggregate per-`message.model` into `byModel` AND return the rolled-up totals at the top level.
- **`MockAdapter` (Task 7)** and any other `RawUsage` literal must add `byModel: []` (or a 1-element array) to stay compilable.

### Delta B — `AppConfig` providers are records, not a string list (amends Task 2 schema + Task 3 config-service)
Decisions 1–3 & 6: billing mode is per-provider config, not adapter, so `enabledProviders: string[]` becomes a `providers` record array. Add to `src/shared/schemas.ts` (Task 2):
```ts
export const ProviderConfigSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
  billingMode: z.enum(['metered', 'seat']).default('seat'),
  seatPriceUsdMonthly: z.number().nonnegative().optional(),       // seat mode → value multiplier
  budget: z.object({ dailyUsd: z.number(), monthlyUsd: z.number(), perGoalUsd: z.number() })
            .partial().optional(),                                // metered mode → caps/alerts
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
```
…and replace `enabledProviders: z.array(z.string()).default(['claude'])` in `AppConfigSchema`/`PersistedConfigSchema` with:
```ts
  providers: z.array(ProviderConfigSchema).default([{ id: 'claude', enabled: true, billingMode: 'seat' }]),
```
**Config-service (Task 3) changes:**
- `normalizeProviders(list: ProviderConfig[])` enforces the invariant: a `'claude'` record is **always present & enabled** (`billingMode: 'seat'` if absent). It dedupes by `id` (last write wins) and forces `claude.enabled = true`.
- `DEFAULTS.providers = [{ id: 'claude', enabled: true, billingMode: 'seat' }]`.
- The registry's `adapterForModel(model, enabledIds)` **still takes string ids** — derive them at the call site:
  ```ts
  const enabledIds = persisted.providers.filter((p) => p.enabled).map((p) => p.id);
  ```
- `buildCatalog(...)` (Task 7) and Task 8's `/api/config` response take `enabledIds` (derived as above), not the raw provider records.

**RECONCILIATION (sibling `feat/multi-agent-impl` shipped 015 with `enabledProviders: string[]`):**
- **(a) 015 NOT yet merged onto this branch (current reality):** define the `providers` record shape directly in Task 2's `PersistedConfigSchema` and Task 3's config-service/migration. There is no `enabledProviders` to migrate from. Use migration **`015_app_config.sql`** as written in Task 3 (the table stores a JSON blob; the `providers` shape lives entirely in the Zod schema, so no column change is needed).
- **(b) 015 ALREADY merged (its `config_json` holds `{enabledProviders:[...]}`):** add migration **`016_provider_config.sql`** to rewrite existing rows in-place from `{enabledProviders:[...]}` → `{providers:[...]}`, defaulting `billingMode:'seat'`, no budget, no seat price. Because the rewrite needs JSON transformation SQLite can't easily express, run it as a JS data-migration step inside the migration runner (or a one-shot guarded by the `schema_migrations` version). SQL + JS:
  ```sql
  -- server/db/migrations/016_provider_config.sql
  -- Schema is unchanged (config_json is an opaque TEXT blob); this migration only
  -- records the version. The blob rewrite runs in the JS companion below, because
  -- {enabledProviders:[...]} → {providers:[...]} is a JSON transform, not DDL.
  INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (16, strftime('%s', 'now'));
  ```
  ```ts
  // Runs once, after 016's SQL, in the migration runner (or config-service bootstrap
  // guarded by `SELECT 1 FROM schema_migrations WHERE version = 16`):
  function migrate016(db: Database.Database): void {
    const row = db.prepare('SELECT config_json FROM app_config WHERE id = 1').get() as
      | { config_json: string } | undefined;
    if (!row) return;
    let cfg: Record<string, unknown>;
    try { cfg = JSON.parse(row.config_json); } catch { return; } // corrupt → leave for getPersisted() fallback
    if (Array.isArray(cfg['providers'])) return;                  // already migrated, idempotent
    const ids = Array.isArray(cfg['enabledProviders']) ? (cfg['enabledProviders'] as string[]) : ['claude'];
    const idSet = new Set(['claude', ...ids]);                    // claude-always-present invariant
    cfg['providers'] = [...idSet].map((id) => ({ id, enabled: true, billingMode: 'seat' as const }));
    delete cfg['enabledProviders'];
    db.prepare('UPDATE app_config SET config_json = ?, updated_at = ? WHERE id = 1')
      .run(JSON.stringify(cfg), Date.now());
  }
  ```
  Tests for path (b): seed a row with `{enabledProviders:['claude','antigravity']}`, run `migrate016`, assert `getPersisted().providers` has two enabled records both `billingMode:'seat'`, and that re-running `migrate016` is a no-op (idempotent).

### Delta C — capability matrix on the interface (amends Task 1 `AgentCatalogEntry` + Task 4 interface + Task 6 `ClaudeAdapter`)
Decision 8: adapters declare what they can do so the UI degrades honestly. Add to `src/shared/agents/types.ts` (Task 1):
```ts
/** What an adapter's CLI can actually do; the UI greys out unsupported affordances. */
export interface AgentCapabilities {
  canObserveHooks: boolean;
  canResume: boolean;
  canMcp: boolean;
  canApprove: boolean;
  canStream: boolean;
}
```
- Add `capabilities: AgentCapabilities;` to `AgentCatalogEntry` (Task 1).
- Add `readonly capabilities: AgentCapabilities;` to the `AgentAdapter` interface (Task 4).
- **Also add to the `AgentAdapter` interface (Task 4)** a Phase-3 context-file mapping hook:
  ```ts
  /** Phase 3: point the CLI's native context file (CLAUDE.md / AGENTS.md / GEMINI.md)
   *  at the shared goal docs. Claude's impl writes/links CLAUDE.md, or no-ops if present. */
  prepareContext(ctx: SpawnContext): void;
  ```
- `ClaudeAdapter` (Task 6) sets **all five capabilities `true`** and provides a minimal `prepareContext` (see the "Delta C — amended Task 6" block under Task 6). `MockAdapter` (Task 7) and the registry's `buildCatalog` must also carry `capabilities` — see those tasks' delta notes.

### Delta D — pricing/contextWindow delegate to the Phase 0A registry (amends Task 5 + Task 6)
Decision (Phase 0A): there is exactly one pricing/tier/window table — `src/shared/agents/model-registry.ts` (`resolveModel(raw) → ModelEntry | null`). Task 5/6 must **delegate** pricing + contextWindow to it, not keep a local Claude-only table. `parseUsage`/transcript parsing **stays in the adapter** (it is provider-specific); only pricing/window lookup moves:
```ts
import { resolveModel } from '../../src/shared/agents/model-registry';

// in usage-service.ts (Task 5), replacing the local MODEL_PRICING table:
export function claudePricingFor(model: string | null): ModelPricing {
  const entry = resolveModel(model);
  // null pricing (seat-only / unknown) → zeros; cost is computed as 0 and the model is flagged unpriced upstream.
  return entry?.pricing ?? { input: 0, cache_read: 0, cache_creation: 0, output: 0 };
}
export function claudeContextWindow(model: string | null, currentContextTokens: number): number {
  return resolveModel(model)?.contextWindow ?? 200_000;
}
```
The `ClaudeAdapter.pricingFor(model)` (Task 6) is then just `return resolveModel(model)?.pricing ?? { input: 0, cache_read: 0, cache_creation: 0, output: 0 };` (or keep delegating through `claudePricingFor`). **Delete** the local `MODEL_PRICING`/`getPricing`/`getContextWindow` tables from `usage-service.ts` once the registry exists (Phase 0A already does this; re-confirm in Task 5).

### Settings-persistence convergence (amends Task 8 + Task 10)
Foundation **Task 8's real `/api/config` wiring SUPERSEDES the standalone `2026-06-08-settings-persistence-design.md` plan** — do not run that plan separately. Fold its two extras in here:
- **Settings scrollbar fix** → wrap `SettingsPage` content in `flex-1 overflow-y-auto px-6 py-4` (matching `AnalyticsPage`/`SkillsPage`) → **Task 10**.
- **`/api/config` round-trip + field-name (`tracePruneDays`) + provider-invariant tests** → add to **Task 8** (GET-on-empty returns defaults; PUT→GET round-trips; invalid PUT → 400 writes nothing; PUT clearing providers still returns a `claude` record; `tracePruneDays` read back identically). These replace the standalone plan's test list.

---

## Task 0: Prerequisite — green baseline via Vitest env split + Node 24

Two independent issues, fixed together because the refactor's safety net needs a green baseline:

1. **The real cause of the 337 failures (version-independent):** `vite.config.ts` sets a single global
   `environment: 'jsdom'`, so all 28 `tests/server/**` files run in the browser env where `node:os`/`fs` are
   externalized (`os.tmpdir is not a function`). No server test uses a `// @vitest-environment node` pragma.
   The fix is a per-project environment split (client → jsdom, server → node).
2. **Runtime target → Node 24.** The repo pins Node 22 (`.nvmrc`, Docker), but we are standardizing on Node 24
   (dev machine + forward-looking; Node 22 enters maintenance). **Verified on this machine:** `better-sqlite3`
   `^12.9` loads and `node-pty` `^1.1` spawns+kills a PTY on `v24.14.1`.

**No refactor starts until the baseline is green.**

**Files:**
- Modify: `vite.config.ts` (replace the `test` block with a projects split)
- Modify: `.nvmrc` (`22` → `24`)
- Modify: `package.json` (add `engines`)
- Modify: `Dockerfile` (`node:22-alpine` → `node:24-alpine`, all 3 stages: lines 2, 8, 15)
- Modify: `tests/client/components/Sidebar.test.tsx:25` (remove unused `makeSession`)
- Modify: `tests/client/stores/useApprovalsStore.test.ts:3` (remove unused `ApprovalDecision`)
- Modify: `tests/client/stores/useUIConfigStore.test.ts:3` (remove unused import line)

- [ ] **Step 1: Bump the runtime.**
  - `.nvmrc` → `24`
  - `package.json`: add a top-level `"engines": { "node": ">=24" }`
  - `Dockerfile`: replace all three `FROM node:22-alpine` with `FROM node:24-alpine`
  - Then: `nvm use 24` (install first if needed) and `npm ci` to (re)build native modules against Node 24.

- [ ] **Step 2: Fix the Vitest environment split.** Replace the `test` block in `vite.config.ts` with:
```ts
  test: {
    globals: true,
    exclude: ['**/node_modules/**', '**/.claude/worktrees/**', '**/dist/**'],
    projects: [
      {
        extends: true,
        test: {
          name: 'client',
          environment: 'jsdom',
          setupFiles: ['./tests/setup-dom.ts'],
          include: ['tests/client/**/*.test.{ts,tsx}', 'tests/shared/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'server',
          environment: 'node',
          setupFiles: ['./tests/setup.ts'],
          include: ['tests/server/**/*.test.ts'],
        },
      },
    ],
  },
```
  (`extends: true` inherits the root `plugins`/`resolve`. `tests/setup.ts` and `tests/setup-dom.ts` both already
  exist. Do not change any test logic — only the environment wiring.)

- [ ] **Step 3: Fix the 3 unused-import typecheck errors** (delete the unused identifiers/imports named above).

- [ ] **Step 4: Confirm green.** Run `npm run typecheck` (expect no errors) and `npm test` (expect the server
  project's 28 files to now run under node and pass; **0 failed** overall). Record the passing counts — this is
  the baseline the refactor must preserve.

- [ ] **Step 5: Verify the runtime end-to-end.**
  - `npm run dev` boots; create a goal and confirm a Claude session spawns (node-pty works on 24).
  - `docker build -t claude-deck-test .` succeeds (native modules compile on `node:24-alpine`/musl). **If the
    Docker native build fails**, leave dev green, revert only the Dockerfile change, and note "Docker → Node 24"
    as a follow-up — do not block the Foundation on it.

- [ ] **Step 6: Commit.**
```bash
git add vite.config.ts .nvmrc package.json Dockerfile tests/client
git commit -m "build: target Node 24 + split Vitest server/client test environments"
```

> If the baseline cannot be made fully green for reasons unrelated to this work, STOP and report — do not proceed with a red baseline.

---

## Task 1: Shared agent types

**Files:**
- Create: `src/shared/agents/types.ts`
- Test: `tests/shared/agents/types.test.ts`

These are framework-free types shared by client and server. No runtime logic, so the "test" is a compile-time usage assertion.

> **⚠️ 2026-06-09 OVERRIDES (apply before committing this task):**
> - **Delta A:** replace the `RawUsage` interface below with the `RawModelUsage` + `RawUsage extends RawModelUsage { byModel }` pair (see Delta A above). Update the Step-2 test literal to include `byModel`.
> - **Delta C:** add the `AgentCapabilities` interface and add `capabilities: AgentCapabilities` to `AgentCatalogEntry` (see Delta C above). The Step-2 `AgentCatalogEntry` literal must add `capabilities: { canObserveHooks: true, canResume: true, canMcp: true, canApprove: true, canStream: true }`.

- [ ] **Step 1: Write the file.**
```ts
// src/shared/agents/types.ts

/** One entry in the model picker. `value` is provider-qualified (e.g. 'opus', 'antigravity'). */
export interface ModelOption {
  value: string;
  label: string;
}

/** The claude-deck MCP server, described provider-agnostically. Each adapter serializes it itself. */
export interface McpServerDescriptor {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Everything an adapter needs to launch a session. */
export interface SpawnContext {
  goalId: string;
  model: string;
  cwd: string;
  permissionMode: 'autonomous' | 'supervised';
  mcpServer: McpServerDescriptor | null;
}

/** Per-session token totals parsed from a provider's transcript. */
export interface RawUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  messageCount: number;
  model: string | null;
}

/** Per-token USD pricing (already divided to per-token, not per-million). */
export interface ModelPricing {
  input: number;
  cache_read: number;
  cache_creation: number;
  output: number;
}

/** Client-facing catalog entry for one provider (no server-only methods). */
export interface AgentCatalogEntry {
  id: string;
  label: string;
  enabled: boolean;
  models: ModelOption[];
  /** Optional hint shown in Settings when enabling (e.g. how to authenticate). */
  authHint?: string;
}
```

- [ ] **Step 2: Write the compile assertion test.**
```ts
// tests/shared/agents/types.test.ts
import { describe, it, expect } from 'vitest';
import type { SpawnContext, RawUsage, AgentCatalogEntry } from '../../../src/shared/agents/types';

describe('agent shared types', () => {
  it('SpawnContext is constructible', () => {
    const ctx: SpawnContext = {
      goalId: 'g1', model: 'opus', cwd: '/tmp',
      permissionMode: 'supervised', mcpServer: null,
    };
    expect(ctx.goalId).toBe('g1');
  });
  it('RawUsage and catalog shapes hold', () => {
    const u: RawUsage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, messageCount: 1, model: 'claude-opus-4-8' };
    const c: AgentCatalogEntry = { id: 'claude', label: 'Claude Code', enabled: true, models: [{ value: 'opus', label: 'Opus' }] };
    expect(u.outputTokens + c.models.length).toBe(3);
  });
});
```

- [ ] **Step 3:** Run `npx vitest run tests/shared/agents/types.test.ts` → PASS. Run `npm run typecheck` → clean.

- [ ] **Step 4: Commit.**
```bash
git add src/shared/agents/types.ts tests/shared/agents/types.test.ts
git commit -m "feat: shared agent adapter types"
```

---

## Task 2: AppConfig schema + persisted-config schema

**Files:**
- Modify: `src/shared/schemas.ts` (the `AppConfigSchema` block, ~lines 255–262)
- Modify: `src/shared/types.ts:252-259` (`AppConfig` interface)
- Test: `tests/shared/schemas.test.ts` (append)

> **⚠️ 2026-06-09 OVERRIDE — Delta B:** `enabledProviders: string[]` becomes a `providers: ProviderConfig[]` record array. Add `ProviderConfigSchema`/`ProviderConfig` (see Delta B above) and replace every `enabledProviders` reference in this task — schema field, `PersistedConfigSchema.pick`, the `AppConfig` interface (`src/shared/types.ts`), and the Step-1/Step-3 tests — with `providers`. The default is `[{ id: 'claude', enabled: true, billingMode: 'seat' }]`. The Step-3 test should assert `providers[0]` is the enabled claude record; the `PersistedConfigSchema.pick` keys become `['defaultModel','defaultPermissionMode','homeRoute','providers','tracePruneDays']`. (Reconciliation: on this branch 015 is not merged, so define the record shape directly — path (a).)

- [ ] **Step 1: Write failing test** (append to `tests/shared/schemas.test.ts`):
```ts
import { AppConfigSchema, PersistedConfigSchema } from '../../src/shared/schemas';

describe('AppConfigSchema enabledProviders', () => {
  it('defaults enabledProviders to ["claude"]', () => {
    const parsed = AppConfigSchema.parse({
      homeRoute: '/board', dataDir: '', hooksInstalled: false,
      tracePruneDays: 90, defaultModel: 'default', defaultPermissionMode: 'supervised',
    });
    expect(parsed.enabledProviders).toEqual(['claude']);
  });
  it('PersistedConfigSchema picks only the settable fields', () => {
    const p = PersistedConfigSchema.parse({
      homeRoute: '/board', tracePruneDays: 90, defaultModel: 'opus',
      defaultPermissionMode: 'autonomous', enabledProviders: ['claude', 'antigravity'],
    });
    expect(Object.keys(p).sort()).toEqual(
      ['defaultModel', 'defaultPermissionMode', 'enabledProviders', 'homeRoute', 'tracePruneDays'],
    );
  });
});
```

- [ ] **Step 2:** Run it → FAIL (`PersistedConfigSchema` undefined; `enabledProviders` missing).

- [ ] **Step 3: Edit `src/shared/schemas.ts`.** Replace the `AppConfigSchema` definition with:
```ts
export const AppConfigSchema = z.object({
  homeRoute: z.string(),
  dataDir: z.string(),
  hooksInstalled: z.boolean(),
  tracePruneDays: z.number().int().min(1),
  defaultModel: GoalModelSchema,
  defaultPermissionMode: PermissionModeSchema,
  enabledProviders: z.array(z.string()).default(['claude']),
});

/** The subset of AppConfig that is persisted (dataDir/hooksInstalled are computed at runtime). */
export const PersistedConfigSchema = AppConfigSchema.pick({
  homeRoute: true,
  tracePruneDays: true,
  defaultModel: true,
  defaultPermissionMode: true,
  enabledProviders: true,
});
export type PersistedConfig = z.infer<typeof PersistedConfigSchema>;
```

- [ ] **Step 4: Edit `src/shared/types.ts:252-259`.** Add the field to `AppConfig`:
```ts
export interface AppConfig {
  homeRoute: string;
  dataDir: string;
  hooksInstalled: boolean;
  tracePruneDays: number;
  defaultModel: GoalModel;
  defaultPermissionMode: PermissionMode;
  enabledProviders: string[];
}
```

- [ ] **Step 5:** Run the test → PASS. `npm run typecheck` → clean.

- [ ] **Step 6: Commit.**
```bash
git add src/shared/schemas.ts src/shared/types.ts tests/shared/schemas.test.ts
git commit -m "feat: add enabledProviders to app config schema + persisted-config pick"
```

---

## Task 3: Config persistence (migration 014 + config-service)

**Files:**
- Create: `server/db/migrations/014_app_config.sql`
- Create: `server/services/config-service.ts`
- Test: `tests/server/services/config-service.test.ts`

> **⚠️ 2026-06-09 OVERRIDES:**
> - **Migration number** (per the 2026-06-08 revision, re-verified): this is **`015_app_config.sql`** (version `15`). On this branch (`feat/multi-agent-foundation`) the next free number is 015 — migrations stop at `014_hook_events_session_index.sql`. The SQL body below is otherwise unchanged except the version literal `14` → `15` and the filename.
> - **Delta B (record providers + reconciliation):** `normalizeProviders` now takes `ProviderConfig[]` and enforces a present-&-enabled `claude` record (dedupe by `id`, force `claude.enabled = true`). `DEFAULTS.providers = [{ id: 'claude', enabled: true, billingMode: 'seat' }]`. The config-service tests' `enabledProviders` assertions become `providers` assertions (e.g. `getPersisted().providers.find(p => p.id === 'claude')?.enabled === true`).
> - **Reconciliation path (b):** if a sibling merge brought 015 with `{enabledProviders:[...]}` rows, ALSO add `016_provider_config.sql` + the `migrate016` JS data-migration (full SQL/JS in Delta B above) and a sub-task: write its idempotency test, run it, commit. On the current branch this sub-task is a **no-op** (no 015 to migrate from).

- [ ] **Step 1: Write the migration.**
```sql
-- Migration 014: single-row app configuration stored as a JSON blob.
CREATE TABLE IF NOT EXISTS app_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  config_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (14, strftime('%s', 'now'));
```

- [ ] **Step 2: Write failing test.**
```ts
// tests/server/services/config-service.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createConfigService } from '../../../server/services/config-service';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE app_config (id INTEGER PRIMARY KEY CHECK (id = 1), config_json TEXT NOT NULL, updated_at INTEGER NOT NULL);`);
  return db;
}

describe('config-service', () => {
  let svc: ReturnType<typeof createConfigService>;
  beforeEach(() => { svc = createConfigService(freshDb()); });

  it('seeds defaults when no row exists', () => {
    const c = svc.getPersisted();
    expect(c.defaultModel).toBe('default');
    expect(c.enabledProviders).toEqual(['claude']);
    expect(c.tracePruneDays).toBe(90);
  });

  it('persists and merges partial updates', () => {
    svc.updatePersisted({ defaultModel: 'opus' });
    expect(svc.getPersisted().defaultModel).toBe('opus');
    expect(svc.getPersisted().homeRoute).toBe('/board'); // unchanged
  });

  it("always keeps 'claude' enabled", () => {
    svc.updatePersisted({ enabledProviders: [] });
    expect(svc.getPersisted().enabledProviders).toContain('claude');
    svc.updatePersisted({ enabledProviders: ['antigravity'] });
    expect(svc.getPersisted().enabledProviders).toEqual(expect.arrayContaining(['claude', 'antigravity']));
  });

  it('round-trips through a fresh service on the same db', () => {
    svc.updatePersisted({ enabledProviders: ['claude', 'antigravity'], tracePruneDays: 30 });
    const db2 = (svc as unknown as { _db: Database.Database })._db ?? null; // not used; see note
    expect(svc.getPersisted().tracePruneDays).toBe(30);
  });
});
```

- [ ] **Step 3:** Run it → FAIL (`createConfigService` undefined).

- [ ] **Step 4: Write `server/services/config-service.ts`.**
```ts
import type Database from 'better-sqlite3';
import { PersistedConfigSchema, type PersistedConfig } from '../../src/shared/schemas';
import logger from '../logger';

const DEFAULTS: PersistedConfig = {
  homeRoute: '/board',
  tracePruneDays: 90,
  defaultModel: 'default',
  defaultPermissionMode: 'supervised',
  enabledProviders: ['claude'],
};

/** Ensures 'claude' is always enabled and the list is de-duplicated. */
function normalizeProviders(list: string[]): string[] {
  return Array.from(new Set(['claude', ...list]));
}

export function createConfigService(db: Database.Database) {
  const readStmt = db.prepare<[], { config_json: string }>(
    'SELECT config_json FROM app_config WHERE id = 1',
  );
  const upsertStmt = db.prepare<[string, number]>(
    `INSERT INTO app_config (id, config_json, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`,
  );

  function getPersisted(): PersistedConfig {
    const row = readStmt.get();
    if (!row) return { ...DEFAULTS };
    try {
      const parsed = PersistedConfigSchema.parse(JSON.parse(row.config_json));
      parsed.enabledProviders = normalizeProviders(parsed.enabledProviders);
      return parsed;
    } catch (err) {
      logger.warn({ err }, 'app_config row invalid; returning defaults');
      return { ...DEFAULTS };
    }
  }

  function updatePersisted(partial: Partial<PersistedConfig>): PersistedConfig {
    const current = getPersisted();
    const merged: PersistedConfig = { ...current, ...partial };
    merged.enabledProviders = normalizeProviders(merged.enabledProviders);
    const validated = PersistedConfigSchema.parse(merged);
    upsertStmt.run(JSON.stringify(validated), Date.now());
    return validated;
  }

  return { getPersisted, updatePersisted };
}

export type ConfigService = ReturnType<typeof createConfigService>;
```
(Delete the unused `db2` line from the test — it was illustrative; replace that test body with a second-service round-trip: construct a new `createConfigService` over the *same* `Database` instance and assert the value persists.)

- [ ] **Step 5:** Run test → PASS. `npm run typecheck` → clean.

- [ ] **Step 6: Commit.**
```bash
git add server/db/migrations/014_app_config.sql server/services/config-service.ts tests/server/services/config-service.test.ts
git commit -m "feat: persist app config as json blob (migration 014 + config-service)"
```

---

## Task 4: AgentAdapter interface

**Files:**
- Create: `server/agents/agent-adapter.ts`

Interface-only; verified by the adapters that implement it (Tasks 6–7). One approved refinement: hook methods are async (the underlying installer is async).

> **⚠️ 2026-06-09 OVERRIDE — Delta C:** add two members to the `AgentAdapter` interface below:
> ```ts
> import type { /* …existing… */ AgentCapabilities } from '../../src/shared/agents/types';
> // …inside AgentAdapter, in the Identity & catalog block:
>   readonly capabilities: AgentCapabilities;
> // …new section, Context (Phase 3 context-file mapping):
>   prepareContext(ctx: SpawnContext): void;
> ```
> `AgentCapabilities` is defined in Task 1 (Delta C). `prepareContext` maps the CLI's native context file (CLAUDE.md / AGENTS.md / GEMINI.md) onto the shared goal docs; the Foundation only needs Claude's minimal impl (Task 6).

- [ ] **Step 1: Write the interface.**
```ts
// server/agents/agent-adapter.ts
import type {
  ModelOption, SpawnContext, RawUsage, ModelPricing,
} from '../../src/shared/agents/types';

export type PromptStrategy =
  | { kind: 'idle'; idleMs: number }
  | { kind: 'regex'; promptRegex: RegExp; idleMs: number }
  | { kind: 'flag' };

export interface AgentAdapter {
  // Identity & catalog
  readonly id: string;
  readonly label: string;
  readonly models: ModelOption[];
  readonly authHint?: string;

  // Launch
  resolveBinary(): string;
  buildStartArgs(ctx: SpawnContext): string[];
  buildResumeArgs(sessionId: string, ctx: SpawnContext): string[];
  readonly promptStrategy: PromptStrategy;

  // Observe (hooks)
  installHooks(): Promise<void>;
  uninstallHooks(): Promise<void>;
  hooksInstalled(): Promise<boolean>;

  // Account (usage / analytics)
  locateSessionLog(sessionId: string): string | null;
  parseUsage(logPath: string): RawUsage;
  listSessionLogs(sinceMs: number): string[];
  pricingFor(model: string): ModelPricing;
  contextWindowFor(model: string, currentTokens: number): number;
}
```

- [ ] **Step 2:** `npm run typecheck` → clean. (No standalone test; implementers cover it.)

- [ ] **Step 3: Commit.**
```bash
git add server/agents/agent-adapter.ts
git commit -m "feat: AgentAdapter interface"
```

---

## Task 5: Extract Claude usage primitives from usage-service

Expose the per-file primitives the ClaudeAdapter needs, returning the shared `RawUsage` shape, **without changing the numbers** the existing exported functions produce.

> **⚠️ 2026-06-09 OVERRIDES (depends on Phase 0A's `model-registry.ts` existing):**
> - **Delta D (pricing/window delegation):** `claudePricingFor`/`claudeContextWindow` no longer carry a local Claude-only table — they delegate to `resolveModel()` from `src/shared/agents/model-registry.ts` (full bodies in Delta D above). Phase 0A already deletes the local `MODEL_PRICING`/`getPricing`/`getContextWindow`; re-confirm they are gone. The Step-2 test `claudePricingFor('claude-opus-4-8').output` still equals `75 / 1_000_000` because the registry's opus rate is byte-identical, and `claudeContextWindow('claude-opus-4-8', 250_000)` still returns `1_000_000` for the `[1m]`/over-200k case (registry contextWindow). Parsing stays local; only the lookup moves.
> - **Delta A (`byModel`):** `parseClaudeUsage` must aggregate per-`message.model` into `byModel` AND return the rolled-up session totals at the top level. Replace Step 4.3's parser body with the amended version below; add a Step-2 assertion that single-model fixtures yield a 1-element `byModel` whose totals equal the top-level totals.

**Files:**
- Modify: `server/services/usage-service.ts`
- Test: `tests/server/services/usage-service-primitives.test.ts`
- Fixture: `tests/fixtures/usage/sample-session.jsonl`

- [ ] **Step 1: Create the fixture** `tests/fixtures/usage/sample-session.jsonl` (two assistant turns):
```jsonl
{"type":"system","subtype":"init","model":"claude-opus-4-8","timestamp":"2026-06-01T00:00:00Z"}
{"message":{"usage":{"input_tokens":100,"cache_creation_input_tokens":20,"cache_read_input_tokens":5,"output_tokens":50}}}
{"message":{"usage":{"input_tokens":200,"cache_creation_input_tokens":0,"cache_read_input_tokens":10,"output_tokens":80}}}
```

- [ ] **Step 2: Write failing test.**
```ts
// tests/server/services/usage-service-primitives.test.ts
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { parseClaudeUsage, claudePricingFor, claudeContextWindow } from '../../../server/services/usage-service';

const fixture = path.resolve(__dirname, '../../fixtures/usage/sample-session.jsonl');

describe('claude usage primitives', () => {
  it('parseClaudeUsage sums tokens across turns', () => {
    const u = parseClaudeUsage(fixture);
    expect(u.inputTokens).toBe(300);
    expect(u.cacheCreationTokens).toBe(20);
    expect(u.cacheReadTokens).toBe(15);
    expect(u.outputTokens).toBe(130);
    expect(u.messageCount).toBe(2);
    expect(u.model).toBe('claude-opus-4-8');
  });
  it('pricingFor maps opus by substring', () => {
    expect(claudePricingFor('claude-opus-4-8').output).toBeCloseTo(75 / 1_000_000);
  });
  it('contextWindowFor returns 1M when tokens exceed 200k', () => {
    expect(claudeContextWindow('claude-opus-4-8', 250_000)).toBe(1_000_000);
  });
});
```

- [ ] **Step 3:** Run it → FAIL (functions not exported).

- [ ] **Step 4: Edit `server/services/usage-service.ts`.**
  1. Add `import type { RawUsage, ModelPricing } from '../../src/shared/agents/types';` and change the local `ModelPricing` interface usage to the shared one (delete the duplicate local `interface ModelPricing`, keep `MODEL_PRICING` typed as `Record<string, ModelPricing>`).
  2. Export the existing helpers by renaming for clarity (keep old private names as aliases if referenced internally):
```ts
export function claudePricingFor(model: string | null): ModelPricing {
  // body identical to existing getPricing()
}
export function claudeContextWindow(model: string | null, currentContextTokens: number): number {
  // body identical to existing getContextWindow()
}
export function locateClaudeJsonl(sessionId: string): string | null {
  // body identical to existing findJsonlFile()
}
```
  3. Add a single-file parser that returns `RawUsage` (extract the per-line loop already used in `getSessionUsage`/`getAllSessionUsageSummaries`):
```ts
export function parseClaudeUsage(filePath: string): RawUsage {
  const out: RawUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, messageCount: 0, model: null };
  let content: string;
  try { content = readFileSync(filePath, 'utf-8'); } catch { return out; }
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (!out.model) {
        if (parsed?.type === 'system' && parsed?.subtype === 'init' && parsed?.model) out.model = parsed.model;
        else if (parsed?.model) out.model = parsed.model;
      }
      const usage = parsed?.message?.usage;
      if (!usage) continue;
      out.inputTokens += (usage.input_tokens as number) ?? 0;
      out.cacheCreationTokens += (usage.cache_creation_input_tokens as number) ?? 0;
      out.cacheReadTokens += (usage.cache_read_input_tokens as number) ?? 0;
      out.outputTokens += (usage.output_tokens as number) ?? 0;
      out.messageCount++;
    } catch { /* skip malformed */ }
  }
  return out;
}
```

  **⚠️ Delta A — amended Task 5 Step 4.3 (REPLACES the parser above):** aggregate per-message `model` into `byModel`, then roll up to the top-level totals. A message's model is `parsed.message.model` when present, else the session `init` model, else `null`. Use this body instead:
```ts
export function parseClaudeUsage(filePath: string): RawUsage {
  const out: RawUsage = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    messageCount: 0, model: null, byModel: [],
  };
  let content: string;
  try { content = readFileSync(filePath, 'utf-8'); } catch { return out; }

  let sessionModel: string | null = null;             // from the system/init line
  const byModel = new Map<string, RawModelUsage>();    // keyed by model string ('' = unknown)
  const bump = (key: string | null): RawModelUsage => {
    const k = key ?? '';
    let row = byModel.get(k);
    if (!row) {
      row = { model: key, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, messageCount: 0 };
      byModel.set(k, row);
    }
    return row;
  };

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (!sessionModel) {
        if (parsed?.type === 'system' && parsed?.subtype === 'init' && parsed?.model) sessionModel = parsed.model;
        else if (parsed?.model && !parsed?.message) sessionModel = parsed.model;
      }
      const usage = parsed?.message?.usage;
      if (!usage) continue;
      const msgModel: string | null = parsed?.message?.model ?? sessionModel ?? null;
      const row = bump(msgModel);
      const inp = (usage.input_tokens as number) ?? 0;
      const cc = (usage.cache_creation_input_tokens as number) ?? 0;
      const cr = (usage.cache_read_input_tokens as number) ?? 0;
      const outp = (usage.output_tokens as number) ?? 0;
      row.inputTokens += inp;       out.inputTokens += inp;
      row.cacheCreationTokens += cc; out.cacheCreationTokens += cc;
      row.cacheReadTokens += cr;     out.cacheReadTokens += cr;
      row.outputTokens += outp;      out.outputTokens += outp;
      row.messageCount++;            out.messageCount++;
    } catch { /* skip malformed */ }
  }

  // top-level `model` = back-compat session model (init line, else the first model seen).
  out.model = sessionModel ?? [...byModel.values()].find((r) => r.model)?.model ?? null;
  out.byModel = [...byModel.values()];   // single-model session → 1-element array
  return out;
}
```
  (Add `import type { RawModelUsage } from '../../src/shared/agents/types';` alongside the `RawUsage` import. Existing top-level totals are unchanged — only `byModel` is new — so the Step-2 token-sum assertions stay green.)

  4. Add an enumerator returning JSONL paths modified within the window (extract directory scan from `getAllSessionUsageSummaries`):
```ts
export function listClaudeJsonl(sinceMs = 0): string[] {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return [];
  const cutoff = sinceMs > 0 ? Date.now() - sinceMs : 0;
  const paths: string[] = [];
  for (const project of readdirSync(CLAUDE_PROJECTS_DIR)) {
    const dir = join(CLAUDE_PROJECTS_DIR, project);
    let entries: string[]; try { entries = readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const fp = join(dir, entry);
      try { if (cutoff > 0 && statSync(fp).mtimeMs < cutoff) continue; } catch { continue; }
      paths.push(fp);
    }
  }
  return paths;
}
```
  Keep `getSessionUsage`, `getAllSessionUsageSummaries`, `getAggregateTotals`, `getDailyCosts` intact for now (Task 8 moves aggregation). Existing tests must stay green.

- [ ] **Step 5:** Run the new test + the existing `usage-service` test → PASS. `npm run typecheck` → clean.

- [ ] **Step 6: Commit.**
```bash
git add server/services/usage-service.ts tests/server/services/usage-service-primitives.test.ts tests/fixtures/usage/sample-session.jsonl
git commit -m "refactor: export claude usage primitives returning shared RawUsage"
```

---

## Task 6: ClaudeAdapter (reference implementation)

**Files:**
- Create: `server/agents/claude-adapter.ts`
- Test: `tests/server/agents/claude-adapter.test.ts`

The arg-building tests are the **characterization** of current `pty-manager` behavior — they must encode exactly today's argv.

> **⚠️ 2026-06-09 OVERRIDES:**
> - **Delta C:** `ClaudeAdapter` declares `readonly capabilities` all-`true` and implements `prepareContext`. Add a Step-1 test asserting `a.capabilities.canApprove === true` (and that all five flags are true). Code (add to the class body):
>   ```ts
>   readonly capabilities: AgentCapabilities = {
>     canObserveHooks: true, canResume: true, canMcp: true, canApprove: true, canStream: true,
>   };
>
>   /** Phase 3 context-file mapping. Claude already reads CLAUDE.md from cwd; if the
>    *  shared goal docs live elsewhere this would link/copy them. Minimal/no-op for now. */
>   prepareContext(_ctx: SpawnContext): void { /* CLAUDE.md is read from cwd; nothing to do yet */ }
>   ```
>   (Add `AgentCapabilities` to the `import type … from '../../src/shared/agents/types'` line.)
> - **Delta D:** `pricingFor`/`contextWindowFor` delegate to the Phase 0A registry. Keep delegating through the now-registry-backed `claudePricingFor`/`claudeContextWindow` (Task 5), e.g. `pricingFor(model) { return resolveModel(model)?.pricing ?? { input: 0, cache_read: 0, cache_creation: 0, output: 0 }; }` — do **not** reintroduce a local pricing table.

- [ ] **Step 1: Write failing test.**
```ts
// tests/server/agents/claude-adapter.test.ts
import { describe, it, expect } from 'vitest';
import { ClaudeAdapter } from '../../../server/agents/claude-adapter';
import type { SpawnContext } from '../../../src/shared/agents/types';

const base: SpawnContext = { goalId: 'goal-1', model: 'default', cwd: '/repo', permissionMode: 'supervised', mcpServer: null };
const a = new ClaudeAdapter();

describe('ClaudeAdapter args (characterization)', () => {
  it('start: session id only for supervised + default model', () => {
    expect(a.buildStartArgs(base)).toEqual(['--session-id', 'goal-1']);
  });
  it('start: adds bypassPermissions for autonomous and --model for non-default', () => {
    expect(a.buildStartArgs({ ...base, permissionMode: 'autonomous', model: 'opus' }))
      .toEqual(['--session-id', 'goal-1', '--permission-mode', 'bypassPermissions', '--model', 'opus']);
  });
  it('start: serializes mcp server into --mcp-config', () => {
    const args = a.buildStartArgs({ ...base, mcpServer: { name: 'claude-deck', command: 'node', args: ['/x/index.js'], env: { CLAUDE_DECK_URL: 'http://127.0.0.1:4100' } } });
    const idx = args.indexOf('--mcp-config');
    expect(idx).toBeGreaterThan(-1);
    expect(JSON.parse(args[idx + 1])).toEqual({ mcpServers: { 'claude-deck': { command: 'node', args: ['/x/index.js'], env: { CLAUDE_DECK_URL: 'http://127.0.0.1:4100' } } } });
  });
  it('resume: --resume first', () => {
    expect(a.buildResumeArgs('sess-9', base)).toEqual(['--resume', 'sess-9']);
  });
  it('catalog: exposes default/opus/sonnet/haiku', () => {
    expect(a.models.map((m) => m.value)).toEqual(['default', 'opus', 'sonnet', 'haiku']);
  });
});
```

- [ ] **Step 2:** Run it → FAIL (module missing).

- [ ] **Step 3: Write `server/agents/claude-adapter.ts`.**
```ts
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { AgentAdapter, PromptStrategy } from './agent-adapter';
import type { ModelOption, SpawnContext, RawUsage, ModelPricing, McpServerDescriptor } from '../../src/shared/agents/types';
import { hookInstallerService } from '../services/hook-installer-service';
import {
  parseClaudeUsage, locateClaudeJsonl, listClaudeJsonl, claudePricingFor, claudeContextWindow,
} from '../services/usage-service';

let cachedPath: string | null = null;

function serializeMcp(mcp: McpServerDescriptor): string {
  return JSON.stringify({ mcpServers: { [mcp.name]: { command: mcp.command, args: mcp.args, env: mcp.env } } });
}

export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude';
  readonly label = 'Claude Code';
  readonly models: ModelOption[] = [
    { value: 'default', label: 'Default' },
    { value: 'opus', label: 'Opus' },
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'haiku', label: 'Haiku' },
  ];
  readonly promptStrategy: PromptStrategy = { kind: 'regex', promptRegex: /(?:>{1,2}|❯)\s*$/, idleMs: 5000 };

  resolveBinary(): string {
    if (cachedPath) return cachedPath;
    try {
      let p = execSync('which claude', { encoding: 'utf-8' }).trim();
      if (p.startsWith('/c/')) p = 'C:/' + p.slice(3);
      if (process.platform === 'win32' && !p.endsWith('.exe')) p += '.exe';
      cachedPath = p;
    } catch {
      cachedPath = process.platform === 'win32' ? 'claude.exe' : 'claude';
    }
    return cachedPath;
  }

  buildStartArgs(ctx: SpawnContext): string[] {
    const args: string[] = ['--session-id', ctx.goalId];
    if (ctx.permissionMode === 'autonomous') args.push('--permission-mode', 'bypassPermissions');
    if (ctx.model && ctx.model !== 'default') args.push('--model', ctx.model);
    if (ctx.mcpServer) args.push('--mcp-config', serializeMcp(ctx.mcpServer));
    return args;
  }

  buildResumeArgs(sessionId: string, ctx: SpawnContext): string[] {
    const args: string[] = ['--resume', sessionId];
    if (ctx.permissionMode === 'autonomous') args.push('--permission-mode', 'bypassPermissions');
    if (ctx.mcpServer) args.push('--mcp-config', serializeMcp(ctx.mcpServer));
    return args;
  }

  async installHooks(): Promise<void> { await hookInstallerService.install(); }
  async uninstallHooks(): Promise<void> { await hookInstallerService.uninstall(); }
  async hooksInstalled(): Promise<boolean> { return (await hookInstallerService.status()).installed; }

  locateSessionLog(sessionId: string): string | null { return locateClaudeJsonl(sessionId); }
  parseUsage(logPath: string): RawUsage { return parseClaudeUsage(logPath); }
  listSessionLogs(sinceMs: number): string[] { return listClaudeJsonl(sinceMs); }
  pricingFor(model: string): ModelPricing { return claudePricingFor(model); }
  contextWindowFor(model: string, currentTokens: number): number { return claudeContextWindow(model, currentTokens); }
}
```

- [ ] **Step 4:** Run test → PASS. `npm run typecheck` → clean.

- [ ] **Step 5: Commit.**
```bash
git add server/agents/claude-adapter.ts tests/server/agents/claude-adapter.test.ts
git commit -m "feat: ClaudeAdapter reference implementation"
```

---

## Task 7: Registry + MockAdapter fixture

**Files:**
- Create: `server/agents/registry.ts`
- Create: `tests/fixtures/mock-adapter.ts`
- Test: `tests/server/agents/registry.test.ts`

> **⚠️ 2026-06-09 OVERRIDES (Deltas A + C):**
> - **MockAdapter** must satisfy the amended interface: add `readonly capabilities: AgentCapabilities = { canObserveHooks: false, canResume: false, canMcp: false, canApprove: false, canStream: true };` (a deliberately-degraded provider so capability-gating is testable), add `prepareContext(_ctx: SpawnContext): void {}`, and make its `parseUsage()` return `{ …, byModel: [] }`. Import `AgentCapabilities` in the fixture.
> - **`buildCatalog`** must include `capabilities: a.capabilities` in each entry it returns (the UI reads it). Add a registry-test assertion that `buildCatalog([...])`'s mock entry has `capabilities.canApprove === false` and the claude entry `=== true`.
> - **`adapterForModel(model, enabled)` still takes string ids** (Delta B): callers derive `enabled = providers.filter(p=>p.enabled).map(p=>p.id)` — the registry signature is unchanged.

- [ ] **Step 1: Write the MockAdapter fixture** (a fake second provider for tests — keeps the real catalog Claude-only):
```ts
// tests/fixtures/mock-adapter.ts
import type { AgentAdapter, PromptStrategy } from '../../server/agents/agent-adapter';
import type { ModelOption, SpawnContext, RawUsage, ModelPricing } from '../../src/shared/agents/types';

export class MockAdapter implements AgentAdapter {
  readonly id = 'mock';
  readonly label = 'Mock Agent';
  readonly models: ModelOption[] = [{ value: 'mock', label: 'Mock' }];
  readonly authHint = 'set MOCK_API_KEY';
  readonly promptStrategy: PromptStrategy = { kind: 'idle', idleMs: 1000 };
  resolveBinary(): string { return 'mock'; }
  buildStartArgs(ctx: SpawnContext): string[] { return ['--mock', ctx.goalId]; }
  buildResumeArgs(sessionId: string): string[] { return ['--mock-resume', sessionId]; }
  async installHooks(): Promise<void> {}
  async uninstallHooks(): Promise<void> {}
  async hooksInstalled(): Promise<boolean> { return false; }
  locateSessionLog(): string | null { return null; }
  parseUsage(): RawUsage { return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, messageCount: 0, model: 'mock' }; }
  listSessionLogs(): string[] { return []; }
  pricingFor(): ModelPricing { return { input: 0, cache_read: 0, cache_creation: 0, output: 0 }; }
  contextWindowFor(): number { return 200_000; }
}
```

- [ ] **Step 2: Write failing test.**
```ts
// tests/server/agents/registry.test.ts
import { describe, it, expect } from 'vitest';
import { adapterForModel, enabledModelOptions, buildCatalog, makeRegistry } from '../../../server/agents/registry';
import { ClaudeAdapter } from '../../../server/agents/claude-adapter';
import { MockAdapter } from '../../fixtures/mock-adapter';

const reg = makeRegistry([new ClaudeAdapter(), new MockAdapter()]);

describe('registry', () => {
  it('resolves a model to its adapter', () => {
    expect(reg.adapterForModel('opus', ['claude', 'mock']).id).toBe('claude');
    expect(reg.adapterForModel('mock', ['claude', 'mock']).id).toBe('mock');
  });
  it('falls back to claude for unknown/default/disabled', () => {
    expect(reg.adapterForModel('default', ['claude']).id).toBe('claude');
    expect(reg.adapterForModel('totally-unknown', ['claude']).id).toBe('claude');
    expect(reg.adapterForModel('mock', ['claude']).id).toBe('claude'); // mock disabled
  });
  it('enabledModelOptions is the union of enabled providers', () => {
    expect(reg.enabledModelOptions(['claude']).map((m) => m.value)).toEqual(['default', 'opus', 'sonnet', 'haiku']);
    expect(reg.enabledModelOptions(['claude', 'mock']).some((m) => m.value === 'mock')).toBe(true);
  });
  it('buildCatalog marks enabled flags', () => {
    const cat = reg.buildCatalog(['claude']);
    expect(cat.find((c) => c.id === 'claude')?.enabled).toBe(true);
    expect(cat.find((c) => c.id === 'mock')?.enabled).toBe(false);
  });
});

it('default registry exports module-level helpers (claude only)', () => {
  expect(adapterForModel('opus', ['claude']).id).toBe('claude');
  expect(enabledModelOptions(['claude']).length).toBe(4);
  expect(buildCatalog(['claude']).length).toBe(1);
});
```

- [ ] **Step 3:** Run it → FAIL (module missing).

- [ ] **Step 4: Write `server/agents/registry.ts`.**
```ts
import type { AgentAdapter } from './agent-adapter';
import type { AgentCatalogEntry, ModelOption } from '../../src/shared/agents/types';
import { ClaudeAdapter } from './claude-adapter';
import logger from '../logger';

export function makeRegistry(adapters: AgentAdapter[]) {
  const byId = new Map(adapters.map((a) => [a.id, a]));
  const claude = byId.get('claude');
  if (!claude) throw new Error('registry requires a "claude" adapter');

  function allAdapters(): AgentAdapter[] { return [...adapters]; }
  function getAdapter(id: string): AgentAdapter | undefined { return byId.get(id); }

  function adapterForModel(model: string, enabled: string[]): AgentAdapter {
    for (const a of adapters) {
      if (!enabled.includes(a.id)) continue;
      if (a.models.some((m) => m.value === model)) return a;
    }
    if (model && model !== 'default') {
      logger.warn({ model, enabled }, 'No enabled adapter owns model; falling back to claude');
    }
    return claude!;
  }

  function enabledModelOptions(enabled: string[]): ModelOption[] {
    const opts: ModelOption[] = [];
    for (const a of adapters) if (enabled.includes(a.id)) opts.push(...a.models);
    return opts;
  }

  function buildCatalog(enabled: string[]): AgentCatalogEntry[] {
    return adapters.map((a) => ({
      id: a.id, label: a.label, enabled: enabled.includes(a.id), models: a.models,
      ...(a.authHint ? { authHint: a.authHint } : {}),
    }));
  }

  return { allAdapters, getAdapter, adapterForModel, enabledModelOptions, buildCatalog };
}

export type Registry = ReturnType<typeof makeRegistry>;

// Default production registry — Claude-only catalog for the Foundation.
const defaultRegistry = makeRegistry([new ClaudeAdapter()]);
export const allAdapters = defaultRegistry.allAdapters;
export const getAdapter = defaultRegistry.getAdapter;
export const adapterForModel = defaultRegistry.adapterForModel;
export const enabledModelOptions = defaultRegistry.enabledModelOptions;
export const buildCatalog = defaultRegistry.buildCatalog;
```

- [ ] **Step 5:** Run test → PASS. `npm run typecheck` → clean.

- [ ] **Step 6: Commit.**
```bash
git add server/agents/registry.ts tests/fixtures/mock-adapter.ts tests/server/agents/registry.test.ts
git commit -m "feat: agent registry with model resolution + catalog"
```

---

## Task 8: Provider-aware analytics + real /api/config

**Files:**
- Create: `server/services/analytics-service.ts`
- Modify: `server/services/usage-service.ts` (move aggregation out / re-export)
- Modify: `server/routes/system.ts` (config GET/PUT + analytics imports)
- Modify: `server/index.ts` (construct ConfigService; pass into system router)
- Test: `tests/server/services/analytics-service.test.ts`

> **⚠️ 2026-06-09 OVERRIDES:**
> - **Delta B (records → ids):** the `/api/config` handlers operate on `persisted.providers` (records). Derive `const enabledIds = persisted.providers.filter(p => p.enabled).map(p => p.id);` and pass `enabledIds` to `buildCatalog(...)`. The GET/PUT response shape returns `providers: buildCatalog(enabledIds)` (catalog entries, with `capabilities`) — the persisted *records* round-trip under the same `providers` key inside the spread `...persisted`. If that key collision is confusing, name the catalog field distinctly (e.g. `catalog: buildCatalog(enabledIds)`) and keep `providers` as the persisted records; pick one and make the Task 10 client read the same key.
> - **Settings-persistence convergence (supersedes the standalone plan):** add these route tests to `tests/server/services/analytics-service.test.ts` or a sibling `tests/server/routes/system-config.test.ts`: (1) GET on an empty table returns documented defaults incl. a single enabled `claude` provider record; (2) PUT→GET round-trips updated `defaultModel`/`tracePruneDays`/`providers`; (3) invalid PUT (`tracePruneDays: 0`, bad permission enum) → `400`, nothing written; (4) PUT clearing/omitting providers still returns a `claude` record (normalizeProviders invariant); (5) `tracePruneDays` field-name guard (read back identically). These REPLACE running `2026-06-08-settings-persistence-design.md` separately.
> - **Delta A/D (analytics math):** `analytics-service` costs via the registry-backed `adapter.pricingFor(model)`. Prefer attributing cost per `u.byModel[]` row (each row's model → its registry pricing), summing into the totals — this is the per-model-correct path Decision 4 wants and avoids mispricing mixed-model sessions. Rolled-up totals must still match the prior Claude-only numbers for single-model fixtures.

- [ ] **Step 1: Write `server/services/analytics-service.ts`** (iterates adapters; for Claude-only this matches current numbers):
```ts
import { allAdapters } from '../agents/registry';

export interface AggregateTotals { sessions: number; cost: number; tokensIn: number; tokensOut: number; }
export interface DailyCostEntry { date: string; cost: number; sessions: number; }

function roundUsd(n: number): number { return Math.round(n * 10000) / 10000; }

export function getAggregateTotals(sinceDaysAgo = 0): AggregateTotals {
  const sinceMs = sinceDaysAgo > 0 ? sinceDaysAgo * 86_400_000 : 0;
  let sessions = 0, cost = 0, tokensIn = 0, tokensOut = 0;
  for (const adapter of allAdapters()) {
    for (const logPath of adapter.listSessionLogs(sinceMs)) {
      const u = adapter.parseUsage(logPath);
      if (u.messageCount === 0) continue;
      sessions++;
      const p = adapter.pricingFor(u.model ?? '');
      cost += u.inputTokens * p.input + u.cacheReadTokens * p.cache_read + u.cacheCreationTokens * p.cache_creation + u.outputTokens * p.output;
      tokensIn += u.inputTokens + u.cacheCreationTokens + u.cacheReadTokens;
      tokensOut += u.outputTokens;
    }
  }
  return { sessions, cost: roundUsd(cost), tokensIn, tokensOut };
}

export function getDailyCosts(sinceDaysAgo = 0): DailyCostEntry[] {
  // Mirror the existing date-grouping in usage-service.getDailyCosts but driven by adapters.
  // Use file mtime as the date key (matches prior fallback behavior).
  const sinceMs = sinceDaysAgo > 0 ? sinceDaysAgo * 86_400_000 : 0;
  const byDate = new Map<string, { cost: number; sessions: number }>();
  for (const adapter of allAdapters()) {
    for (const logPath of adapter.listSessionLogs(sinceMs)) {
      const u = adapter.parseUsage(logPath);
      if (u.messageCount === 0) continue;
      const { statSync } = require('node:fs') as typeof import('node:fs');
      const dateStr = new Date(statSync(logPath).mtimeMs).toISOString().split('T')[0];
      const p = adapter.pricingFor(u.model ?? '');
      const cost = u.inputTokens * p.input + u.cacheReadTokens * p.cache_read + u.cacheCreationTokens * p.cache_creation + u.outputTokens * p.output;
      const cur = byDate.get(dateStr) ?? { cost: 0, sessions: 0 };
      cur.cost += cost; cur.sessions += 1; byDate.set(dateStr, cur);
    }
  }
  return [...byDate.entries()].map(([date, v]) => ({ date, cost: roundUsd(v.cost), sessions: v.sessions })).sort((a, b) => a.date.localeCompare(b.date));
}
```
> Note: the prior `getDailyCosts` grouped by first-message timestamp with mtime fallback. If exact parity matters, have `parseUsage` also return a `firstMessageAt` (extend `RawUsage` with an optional field) and use it here. For the Foundation, mtime grouping is acceptable and documented; verify against a fixture in Step 2.

- [ ] **Step 2: Write test** asserting totals from a temp `~/.claude/projects`-style fixture dir equal hand-computed values. Use the Claude pricing (`opus`: input 15/M, cache_read 1.5/M, cache_creation 18.75/M, output 75/M). Build a temp dir, point the adapter at it (inject via a test-only env or by constructing `makeRegistry` with a ClaudeAdapter whose `listSessionLogs`/`locateSessionLog` you stub to return the fixture path), and assert `getAggregateTotals` math. Run → FAIL, then PASS after Step 1.

- [ ] **Step 3: Update `server/routes/system.ts`.**
  1. Replace the analytics imports (line 7) `import { getAggregateTotals, getDailyCosts } from '../services/usage-service';` → `from '../services/analytics-service';`.
  2. Change the router factory signature to also accept the config service and registry helpers:
```ts
import type { ConfigService } from '../services/config-service';
import { buildCatalog } from '../agents/registry';
import { hookInstallerService } from '../services/hook-installer-service';
// ...
export function createSystemRouter(skillDirService?: SkillDirectoryService, configService?: ConfigService): Router {
```
  3. Replace the `GET /api/config` handler (lines 131-138):
```ts
router.get('/config', async (_req, res) => {
  if (!configService) { res.status(501).json({ error: 'Config service not available' }); return; }
  const persisted = configService.getPersisted();
  const status = await hookInstallerService.status();
  res.json({
    ...persisted,
    dataDir: process.env['CLAUDE_DECK_DATA_DIR'] ?? '',   // keep prior behavior; see note
    hooksInstalled: status.installed,
    providers: buildCatalog(persisted.enabledProviders),
  });
});
```
  4. Replace the `PUT /api/config` handler (lines 144-148):
```ts
router.put('/config', async (req, res) => {
  if (!configService) { res.status(501).json({ error: 'Config service not available' }); return; }
  try {
    const updated = configService.updatePersisted(req.body ?? {});
    const status = await hookInstallerService.status();
    res.json({ ...updated, dataDir: process.env['CLAUDE_DECK_DATA_DIR'] ?? '', hooksInstalled: status.installed, providers: buildCatalog(updated.enabledProviders) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});
```
  > `dataDir`: the pre-existing stub never returned a real `dataDir`. If the project already exposes a data directory (check `server/db/*` setup for where the SQLite file lives), import and use that here instead of the env fallback. Do not invent a new directory.

- [ ] **Step 4: Update `server/index.ts`.** Where the system router is constructed (search `createSystemRouter(`), build and pass the ConfigService:
```ts
import { createConfigService } from './services/config-service';
// ... after `db` is available:
const configService = createConfigService(db);
// ... change:
const systemRouter = createSystemRouter(skillDirectoryService, configService);
```

- [ ] **Step 5:** Decide on `usage-service.getAggregateTotals/getDailyCosts`: leave them in place (now unused by routes) or delete and re-export from analytics-service. Prefer deleting the two now-duplicated functions from `usage-service.ts` and updating any other importers (grep `getAggregateTotals|getDailyCosts`). Keep `getSessionUsage` (still used elsewhere — grep to confirm).

- [ ] **Step 6:** Run `npm test` (analytics + system route tests) → PASS. `npm run typecheck` → clean. Manually hit `GET /api/config` (`npm run dev`, then `curl localhost:4100/api/config`) and confirm it returns `enabledProviders: ["claude"]` and a `providers` array.

- [ ] **Step 7: Commit.**
```bash
git add server/services/analytics-service.ts server/services/usage-service.ts server/routes/system.ts server/index.ts tests/server/services/analytics-service.test.ts
git commit -m "feat: provider-aware analytics + persisted /api/config with provider catalog"
```

---

## Task 9: PtyManager uses the adapter

**Files:**
- Modify: `server/pty-manager.ts`
- Modify: `server/index.ts` (both `new PtyManager` call sites: ~132 and ~222)
- Test: `tests/server/pty-manager-adapter.test.ts`

> **⚠️ 2026-06-09 OVERRIDE — Delta B:** at the `adapterForModel(...)` call sites (Step 4), derive enabled ids from the provider records, not a bare `enabledProviders` array:
> ```ts
> const persisted = configService.getPersisted();
> const enabledIds = persisted.providers.filter((p) => p.enabled).map((p) => p.id);
> const adapter = adapterForModel(goal.model ?? 'default', enabledIds);
> ```

- [ ] **Step 1: Write failing test** (verifies PtyManager asks the adapter for args; no real spawn):
```ts
// tests/server/pty-manager-adapter.test.ts
import { describe, it, expect, vi } from 'vitest';
import { PtyManager } from '../../server/pty-manager';
import { ClaudeAdapter } from '../../server/agents/claude-adapter';
import type { Goal } from '../../src/shared/types';

const goal = { id: 'goal-1', cwd: '/repo', model: 'opus', permission_mode: 'autonomous' } as Goal;

describe('PtyManager + adapter', () => {
  it('builds start argv via the adapter', () => {
    const adapter = new ClaudeAdapter();
    const spy = vi.spyOn(adapter, 'buildStartArgs');
    const mgr = new PtyManager(goal, adapter, { broadcast: () => {} });
    // Expose arg building for test via a pure method (see Step 3): buildLaunchArgs()
    expect(mgr.buildLaunchArgs()).toEqual(['--session-id', 'goal-1', '--permission-mode', 'bypassPermissions', '--model', 'opus']);
    expect(spy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2:** Run it → FAIL (constructor arity / `buildLaunchArgs` missing).

- [ ] **Step 3: Edit `server/pty-manager.ts`.**
  1. Constructor (lines 73-78) gains `adapter`:
```ts
import type { AgentAdapter } from './agents/agent-adapter';
// ...
constructor(goal: Goal, private readonly adapter: AgentAdapter, options: PtyManagerOptions) {
  this.goal = goal;
  this.goalId = goal.id;
  this.broadcast = options.broadcast;
  this.onExitCallback = options.onExit;
}
```
  2. Add a pure `buildLaunchArgs()` and `private spawnContext()`:
```ts
private spawnContext() {
  return {
    goalId: this.goalId,
    model: this.goal.model ?? 'default',
    cwd: this.goal.cwd,
    permissionMode: this.goal.permission_mode,
    mcpServer: this.buildMcpDescriptor(),
  };
}
buildLaunchArgs(): string[] { return this.adapter.buildStartArgs(this.spawnContext()); }
```
  3. In `start()` (line 80-94): replace `resolveClaudePath()` → `this.adapter.resolveBinary()`; replace the inline `args` block with `const args = this.buildLaunchArgs();`.
  4. In `resume()` (line 203-213): `const claudePath = this.adapter.resolveBinary();` and `const args = this.adapter.buildResumeArgs(sessionId, this.spawnContext());`.
  5. Replace `buildMcpConfig()` (302-322) with `buildMcpDescriptor(): McpServerDescriptor | null` returning the structured descriptor (same values, no `JSON.stringify`):
```ts
private buildMcpDescriptor(): McpServerDescriptor | null {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const mcpEntry = path.resolve(__dirname, '..', 'mcp', 'dist', 'index.js');
    const port = process.env['PORT'] ?? '4100';
    return { name: 'claude-deck', command: 'node', args: [mcpEntry], env: { CLAUDE_DECK_URL: `http://127.0.0.1:${port}` } };
  } catch (err) { logger.warn({ err }, 'PTY: Failed to build MCP descriptor'); return null; }
}
```
  6. Drive the prompt-injection block (159-182) from `this.adapter.promptStrategy`: use `promptStrategy.idleMs` for the idle timer, and apply the regex branch only when `promptStrategy.kind === 'regex'` using `promptStrategy.promptRegex`. Behavior for Claude is unchanged (idleMs 5000, same regex).
  7. Delete the now-unused module-level `resolveClaudePath()`/`resolvedClaudePath`.

- [ ] **Step 4: Edit `server/index.ts`** — at both `new PtyManager` sites (~132, ~222):
```ts
import { adapterForModel } from './agents/registry';
// configService already constructed in Task 8
const adapter = adapterForModel(goal.model ?? 'default', configService.getPersisted().enabledProviders);
const ptyMgr = new PtyManager(goal, adapter, { broadcast, onExit(/* unchanged */) { /* ... */ } });
```

- [ ] **Step 5:** Run `npm test` (new test + existing pty-manager tests) → PASS. `npm run typecheck` → clean. The existing pty-manager tests confirm the refactor preserved behavior; if any assert on the removed `buildMcpConfig`/`resolveClaudePath`, update them to the new method names (behavior identical).

- [ ] **Step 6: Commit.**
```bash
git add server/pty-manager.ts server/index.ts tests/server/pty-manager-adapter.test.ts
git commit -m "refactor: PtyManager spawns via AgentAdapter (claude behavior preserved)"
```

---

## Task 10: Settings provider toggle + shared model options

**Files:**
- Create: `src/shared/agents/catalog-client.ts` (client helper)
- Create: `src/components/settings/AgentsSection.tsx`
- Modify: `src/pages/SettingsPage.tsx` (render AgentsSection; source model options from providers)
- Modify: `src/components/kanban/NewGoalModal.tsx`, `src/components/goal/GoalHeader.tsx`, `src/components/scheduled/ScheduledTaskEditor.tsx` (consume shared options), `src/components/kanban/KanbanCard.tsx` (labels/colors fallback for unknown providers)
- Test: `tests/client/components/AgentsSection.test.tsx`

The `/api/config` response now includes `providers: AgentCatalogEntry[]`. The client derives model options from enabled providers.

> **⚠️ 2026-06-09 OVERRIDES:**
> - **Settings-persistence convergence (scrollbar fix folds in here):** wrap `SettingsPage` content in `flex-1 overflow-y-auto px-6 py-4` (matching `AnalyticsPage`/`SkillsPage`) — this is the standalone settings plan's scrollbar fix, now part of Task 10. Verify each control round-trips against the persisted value (the round-trip *server* tests live in Task 8).
> - **Delta B:** `onToggle` produces the new enabled **id list**, but the PUT body must carry provider **records**. Map ids → records before PUT: keep each existing provider's `billingMode`/`budget`/`seatPrice` and flip `enabled`, e.g. `updateConfig({ providers: catalog.map(p => ({ id: p.id, enabled: ids.includes(p.id), billingMode: existing(p.id)?.billingMode ?? 'seat' })) })`. The AgentsSection test's `onToggle(['claude','antigravity'])` contract is unchanged at the component boundary; the records mapping happens in `SettingsPage`.
> - **Delta C (capability-gated UI):** `AgentCatalogEntry` now carries `capabilities`. In `AgentsSection` (and any per-provider affordance), grey out / disable controls a provider can't support (e.g. don't offer an approval/resume toggle when `capabilities.canApprove`/`canResume` is false). For the Foundation, Claude is all-true so nothing greys out, but wire the read so Phase 3/4 providers degrade honestly. The test fixtures must include `capabilities` on each `AgentCatalogEntry`.

- [ ] **Step 1: Write the client helper.**
```ts
// src/shared/agents/catalog-client.ts
import type { AgentCatalogEntry, ModelOption } from './types';

/** Model options shown in pickers = union of enabled providers' models, with 'default' first. */
export function modelOptionsFromCatalog(providers: AgentCatalogEntry[]): ModelOption[] {
  const enabled = providers.filter((p) => p.enabled);
  const opts = enabled.flatMap((p) => p.models);
  // Ensure 'default' is present and first.
  const withoutDefault = opts.filter((o) => o.value !== 'default');
  return [{ value: 'default', label: 'Default' }, ...withoutDefault];
}
```

- [ ] **Step 2: Write failing test.**
```tsx
// tests/client/components/AgentsSection.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AgentsSection from '../../../src/components/settings/AgentsSection';
import type { AgentCatalogEntry } from '../../../src/shared/agents/types';

const providers: AgentCatalogEntry[] = [
  { id: 'claude', label: 'Claude Code', enabled: true, models: [{ value: 'opus', label: 'Opus' }] },
  { id: 'antigravity', label: 'Antigravity', enabled: false, models: [{ value: 'antigravity', label: 'Antigravity' }], authHint: 'Run agy once to sign in' },
];

describe('AgentsSection', () => {
  it('renders providers; claude toggle is disabled (always on)', () => {
    render(<AgentsSection providers={providers} onToggle={() => {}} />);
    const claude = screen.getByLabelText(/Claude Code/i) as HTMLInputElement;
    expect(claude.checked).toBe(true);
    expect(claude.disabled).toBe(true);
  });
  it('toggling a non-claude provider calls onToggle with the new enabled list', () => {
    const onToggle = vi.fn();
    render(<AgentsSection providers={providers} onToggle={onToggle} />);
    fireEvent.click(screen.getByLabelText(/Antigravity/i));
    expect(onToggle).toHaveBeenCalledWith(['claude', 'antigravity']);
  });
});
```

- [ ] **Step 3:** Run it → FAIL (component missing).

- [ ] **Step 4: Write `src/components/settings/AgentsSection.tsx`.**
```tsx
import type { AgentCatalogEntry } from '../../shared/agents/types';

interface Props {
  providers: AgentCatalogEntry[];
  onToggle: (enabledIds: string[]) => void;
}

export default function AgentsSection({ providers, onToggle }: Props) {
  const enabledIds = providers.filter((p) => p.enabled).map((p) => p.id);

  function toggle(id: string, next: boolean) {
    const set = new Set(enabledIds);
    if (next) set.add(id); else set.delete(id);
    set.add('claude'); // always on
    onToggle([...set]);
  }

  return (
    <div className="rounded-lg border border-deck-border bg-deck-surface p-4">
      <h3 className="text-sm font-semibold text-deck-text">Agents</h3>
      <p className="mt-1 text-xs text-deck-muted">Enable the LLM CLIs available when creating goals. Claude Code is always on.</p>
      <div className="mt-3 space-y-2">
        {providers.map((p) => {
          const isClaude = p.id === 'claude';
          return (
            <label key={p.id} className="flex items-center gap-3 text-sm text-deck-text">
              <input
                type="checkbox"
                aria-label={p.label}
                checked={p.enabled}
                disabled={isClaude}
                onChange={(e) => toggle(p.id, e.target.checked)}
              />
              <span className="font-medium">{p.label}{isClaude && <span className="ml-2 text-xs text-deck-muted">(default)</span>}</span>
              {p.enabled && p.authHint && <span className="text-xs text-deck-muted">— {p.authHint}</span>}
            </label>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Wire into `SettingsPage.tsx`.**
  1. The config response now carries `providers`. Extend the local type used in `fetchConfig`/`updateConfig` to `AppConfig & { providers?: AgentCatalogEntry[] }` (or store providers in component state).
  2. Render `<AgentsSection providers={config.providers ?? []} onToggle={(ids) => void updateConfig({ enabledProviders: ids })} />` below the Defaults block.
  3. Replace the hardcoded `MODEL_OPTIONS` (lines 9-14) with `modelOptionsFromCatalog(config.providers ?? [])` for the Default Model select.

- [ ] **Step 6: Replace hardcoded model lists** in `NewGoalModal.tsx` (20-25), `GoalHeader.tsx` (28-33), `ScheduledTaskEditor.tsx` (18-22): fetch the catalog (these components can read it from a shared store or accept it as a prop; simplest is a tiny `useProviders()` hook that GETs `/api/config` once and caches via `useConfigStore`). Build options with `modelOptionsFromCatalog`. For `KanbanCard.tsx` (32-44), keep the existing label/color maps but add a fallback: unknown model → label = the provider/model string, color = a neutral class, so non-Claude models render without a crash.

- [ ] **Step 7:** Run `npm test` (AgentsSection + existing client tests) → PASS. `npm run typecheck` → clean. `npm run dev` and confirm: Settings shows an Agents section with Claude locked-on; the model pickers still show Default/Opus/Sonnet/Haiku.

- [ ] **Step 8: Commit.**
```bash
git add src/shared/agents/catalog-client.ts src/components/settings/AgentsSection.tsx src/pages/SettingsPage.tsx src/components/kanban/NewGoalModal.tsx src/components/goal/GoalHeader.tsx src/components/scheduled/ScheduledTaskEditor.tsx src/components/kanban/KanbanCard.tsx tests/client/components/AgentsSection.test.tsx
git commit -m "feat: Settings agents toggle + provider-driven model pickers"
```

---

## Final verification

- [ ] Run `npm run typecheck` → clean.
- [ ] Run `npm test` → failure count equals the Task 0 baseline (i.e., 0 new failures).
- [ ] Run `npm run dev`, create a goal with model **Opus**, confirm it spawns Claude exactly as before (identical argv in logs), plan/approvals/analytics all still work.
- [ ] Confirm `GET /api/config` returns `enabledProviders` + `providers` catalog; toggling in Settings persists across a server restart.

**⚠️ 2026-06-09 additions:**
- [ ] `GET /api/config` returns `providers` as **records** (`{id,enabled,billingMode}`) and a catalog with per-provider `capabilities`; toggling persists across restart (round-trip server tests in Task 8 green).
- [ ] `parseUsage` returns `byModel` (single-model Claude session → 1-element array; totals match top-level).
- [ ] Pricing/contextWindow come from `src/shared/agents/model-registry.ts` (`resolveModel`) — no local `MODEL_PRICING` left in `usage-service.ts`.
- [ ] `ClaudeAdapter.capabilities` all true; `prepareContext` present; Settings shows the Agents section with Claude locked-on (no greyed affordances on this Claude-only build).
- [ ] If migration 015 was merged from the sibling branch: `016_provider_config.sql` + `migrate016` ran (idempotent test green); otherwise this is a confirmed no-op.

---

## Self-Review (completed by plan author)

**Spec coverage:** §2 interface → Task 4/6; §3 registry → Task 7; §4 config+persistence+Settings → Tasks 2,3,8,10; §5 spawn wiring/Claude refactor → Tasks 6,8,9; §6 testing → tests in every task + MockAdapter (Task 7) + characterization (Tasks 6,9) + parity (Tasks 5,8); §0 baseline prerequisite → Task 0. All covered.

**Type consistency:** `AgentAdapter` (Task 4) is implemented identically by `ClaudeAdapter` (Task 6) and `MockAdapter` (Task 7); `RawUsage`/`ModelPricing`/`ModelOption`/`SpawnContext`/`McpServerDescriptor`/`AgentCatalogEntry` defined once (Task 1) and reused; `PersistedConfig` (Task 2) consumed by config-service (Task 3) and routes (Task 8); `adapterForModel`/`enabledModelOptions`/`buildCatalog` names consistent across Tasks 7/8/9/10.

**Known soft spots flagged in-line:** `getDailyCosts` date-grouping parity (Task 8 note — extend `RawUsage` with `firstMessageAt` if exact parity required); `dataDir` source (Task 8 note — wire to the real data dir if exported); the async `hooksInstalled()` refinement vs the spec's sync signature (documented, innocuous).
