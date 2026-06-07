# Agent Adapter Foundation — Design Spec

**Status:** Design APPROVED — pending final spec read by user.
**Date:** 2026-06-06
**Scope:** Foundation layer only. Antigravity (and later Codex) adapters are separate, follow-on specs.
**Base:** Built on merged `main` (`b43cfa6`, includes dw-32000 skill-improvement). See §0.

---

## 0. Repository baseline & prerequisites

- **Base branch:** `main` at `b43cfa6` — the `feat/dw-32000-skill-improvement` work was fast-forward-merged
  in (skill execution tracking: new `skill-*` services, `routes/skills.ts`, migration `013_skill_tracking.sql`,
  `+70` lines in `hook-ingest.ts`). Local `main` is **4 commits ahead of `origin/main` and not yet pushed.**
- **Preserved WIP:** three uncommitted local changes (single-port production deploy: `app.ts` static serving,
  `index.ts` `restartSession` → full `session:observed`, `ecosystem.config.cjs` tsx run) are committed on
  branch **`wip/single-port-deploy`** (`aea1f30`). NOT on `main`. Note: that branch also edits `index.ts`
  near the second PtyManager call site (line ~222) — coordinate when both land.
- **⚠️ Prerequisite — green test baseline:** the suite is currently **red (337 failed / 309 passed)**, but this
  is **pre-existing**, not caused by any work here (identical on pre-merge `66f3a15`). **Root cause (version-
  independent):** `vite.config.ts` sets a single global `environment: 'jsdom'`, so all 28 `tests/server/**`
  files run in the browser env (`node:os`/`fs` externalized → `os.tmpdir is not a function`); no server test
  uses a `// @vitest-environment node` pragma. It would be red on Node 22 too. **Decision:** the plan's FIRST
  task (Task 0) (a) fixes the Vitest environment split (client → jsdom, server → node via `test.projects`), and
  (b) standardizes the runtime on **Node 24** (repo currently pins Node 22 via `.nvmrc`/Docker; we bump to 24 —
  verified that `better-sqlite3 ^12.9` loads and `node-pty ^1.1` spawns on `v24.14.1`). The behavior-preserving
  strategy (§5/§6) depends on the green baseline. Also: 3 trivial unused-import typecheck errors in test files
  — cosmetic, fixed in passing.

---

## 1. Purpose & Context

Claude-Deck currently hardwires Claude Code at every layer: `pty-manager.ts` resolves the `claude`
binary and builds Claude-specific args; `hook-installer-service.ts` writes Claude hooks; `usage-service.ts`
parses `~/.claude/projects/**/*.jsonl`. To let users run other LLM CLIs (Antigravity first), we need a
provider abstraction **before** any second agent is implemented.

This spec defines that abstraction — the `AgentAdapter` interface, a provider registry, the config/Settings
plumbing to toggle providers, and the refactor of the existing Claude path into the first adapter. **No new
agent runs as a result of this spec.** Claude must behave identically afterward; the Antigravity adapter is
purely additive in a later spec.

### Locked decisions (from brainstorming)
- **Foundation only.** Antigravity adapter is a separate spec.
- **"LLMs are just models."** No new per-goal field; the existing `model` string selects both the CLI and
  the model. A registry maps a model value → its adapter.
- **Full interface now.** The `AgentAdapter` interface covers spawn + prompt + MCP + hook-install +
  usage-parsing. Claude is the complete reference implementation of all of it.
- **Config persistence = single-row JSON blob**, validated by `AppConfigSchema`.

### Out of scope
- The Antigravity adapter implementation (spawn/auth/hooks/analytics) — follow-on **Spec B**.
- Codex or any third provider.
- Any change to goal lifecycle, Kanban, or orchestration semantics.

---

## 2. The `AgentAdapter` interface  ✅ approved

One adapter instance per provider. Everything that varies per CLI lives behind it, grouped by lifecycle.

```ts
// src/shared/agents/types.ts  (shared; client reads catalog/models, not server methods)
interface ModelOption { value: string; label: string; } // provider-qualified value, e.g. 'opus', 'antigravity'

interface McpServerDescriptor {            // the claude-deck MCP server, provider-agnostic
  name: string;                            // 'claude-deck'
  command: string;                         // 'node'
  args: string[];
  env: Record<string, string>;
}

interface SpawnContext {
  goalId: string;
  model: string;                           // selected model value
  cwd: string;
  permissionMode: 'autonomous' | 'supervised';
  mcpServer: McpServerDescriptor | null;   // approved refinement (was mcpConfigPath: string)
}

interface RawUsage {
  inputTokens: number; outputTokens: number;
  cacheReadTokens: number; cacheCreationTokens: number;
  messageCount: number; model: string | null;
}
interface ModelPricing { input: number; cache_read: number; cache_creation: number; output: number; }
```

```ts
// server/agents/agent-adapter.ts
interface AgentAdapter {
  // ── Identity & catalog ────────────────────────────────
  readonly id: string;            // 'claude' | 'antigravity'
  readonly label: string;         // 'Claude Code'
  readonly models: ModelOption[]; // entries this provider contributes to the model picker

  // ── Launch ────────────────────────────────────────────
  resolveBinary(): string;                                   // executable path (cached)
  buildStartArgs(ctx: SpawnContext): string[];               // full argv for a new session
  buildResumeArgs(sessionId: string, ctx: SpawnContext): string[];
  readonly promptStrategy:
    | { kind: 'idle'; idleMs: number }                       // wait for output to settle, then write
    | { kind: 'regex'; promptRegex: RegExp; idleMs: number } // detect prompt glyph (idle fallback)
    | { kind: 'flag' };                                       // prompt passed as a launch arg

  // ── Observe (hooks) ───────────────────────────────────
  installHooks(): Promise<void>;                             // wire this CLI to POST events to claude-deck
  uninstallHooks(): Promise<void>;
  hooksInstalled(): boolean;

  // ── Account (usage / analytics) ───────────────────────
  locateSessionLog(sessionId: string): string | null;       // find the transcript file
  parseUsage(logPath: string): RawUsage;
  listSessionLogs(sinceMs: number): string[];               // for aggregate analytics scans
  pricingFor(model: string): ModelPricing;
  contextWindowFor(model: string, currentTokens: number): number;
}
```

**Notes**
- **Claude is the reference implementation of all four groups.** `ClaudeAdapter` wraps the logic that exists
  today: `resolveClaudePath()`, the `--session-id/--permission-mode/--model/--mcp-config` arg building, the
  idle/regex prompt detection, `hook-installer-service.ts`, and `usage-service.ts` parsing/pricing/context-window.
- `models[]` feeds the picker, so "LLMs are just models" falls out: the dropdown is the union of enabled
  adapters' `models`.
- The interface is **provider-complete** — Antigravity (Spec B) implements these same methods with **no
  interface changes**.
- `RawUsage`, `ModelPricing`, `ModelOption`, `SpawnContext`, `McpServerDescriptor` become shared types lifted
  out of `usage-service.ts`.

**Refinement (approved):** `SpawnContext` carries a structured `mcpServer` descriptor instead of a
pre-serialized `mcpConfigPath` string, because each CLI serializes MCP config differently (Claude: inline JSON
via `--mcp-config`; Antigravity: a staged `mcp_config.json`). Each adapter serializes the descriptor in its own
format inside `buildStartArgs`/launch.

---

## 3. Provider registry & model→provider resolution  ✅ approved

The registry is the single place that knows which adapters exist and maps a model value back to its adapter.

```ts
// server/agents/registry.ts
const ADAPTERS: AgentAdapter[] = [
  new ClaudeAdapter(),
  // new AntigravityAdapter(),   ← added in Spec B
];

function allAdapters(): AgentAdapter[];
function getAdapter(id: string): AgentAdapter | undefined;
function adapterForModel(model: string, enabled: string[]): AgentAdapter; // honors enabled set
function enabledModelOptions(enabled: string[]): ModelOption[];           // union of enabled models[]
```

**Resolution rules**
- Model values are **provider-qualified by convention** so they can't collide: Claude keeps
  `default`/`opus`/`sonnet`/`haiku`; Antigravity will contribute `antigravity` (single entry — headless `agy`
  locks the model). Future Codex → `codex`, etc.
- `adapterForModel('opus', enabled)` → ClaudeAdapter; `adapterForModel('antigravity', enabled)` → Antigravity.
- **Fallbacks:** `default`, unknown, or legacy values → Claude (the always-on provider). A goal whose model's
  provider was later disabled resolves back to Claude with a logged warning rather than failing to spawn.
- `enabledModelOptions` drives every picker; disabled providers' entries simply don't appear.

**Client side:** the registry catalog (`id`, `label`, `models` — no server-only methods) is exposed via the
`/api/config` payload so the UI renders pickers without importing server code. This replaces the five
hardcoded `opus/sonnet/haiku` lists (`SettingsPage`, `NewGoalModal`, `GoalHeader`, `ScheduledTaskEditor`,
`KanbanCard`) with one shared, server-driven source.

---

## 4. AppConfig, persistence & Settings toggle  ✅ approved

### Schema change (`src/shared/schemas.ts` + `types.ts`) — one new field
```ts
AppConfigSchema = z.object({
  homeRoute: z.string(),
  dataDir: z.string(),
  hooksInstalled: z.boolean(),
  tracePruneDays: z.number().int().min(1),
  defaultModel: z.string(),
  defaultPermissionMode: PermissionModeSchema,
  enabledProviders: z.array(z.string()).default(['claude']),  // ← new; 'claude' always present
});
```
Invariant enforced on write: `'claude'` is always in `enabledProviders` (cannot be toggled off). The Zod
schema becomes the **single source of truth**, fixing the existing `tracePruneDays` vs `traceRetentionDays`
mismatch (`system.ts` currently returns the wrong name).

### Persistence (Approach A — JSON blob)
- New migration `014_app_config.sql` (next free number — `013_skill_tracking.sql` is taken by dw-32000):
  `app_config(id INTEGER PRIMARY KEY CHECK (id = 1), config_json TEXT NOT NULL, updated_at INTEGER)`.
- New `server/services/config-service.ts`:
  - `getConfig()` — read row → `JSON.parse` → `AppConfigSchema.parse` (applies defaults); seed defaults if absent.
  - `updateConfig(partial)` — merge → validate → enforce claude-always-on → write.
  - Modeled on `skill-directory-service.ts`.
- `server/routes/system.ts` GET/PUT `/api/config` replaced to call the service (wired in `index.ts` like
  `skillDirectoryService`). PUT finally **persists** instead of echoing `{updated: true}`.

### Settings UI (`src/pages/SettingsPage.tsx`)
New **"Agents" section**, one row per provider from the catalog:
- **Claude Code** — toggle shown but locked on (disabled), labeled "default".
- Other providers — toggle calling `updateConfig({ enabledProviders: [...] })`; when enabled, an inline auth
  hint (Antigravity: *"Run `agy` once to sign in, or set `ANTIGRAVITY_API_KEY`."*).
- Toggling live-updates which entries appear in every model picker.

**Decision (approved):** In the Foundation, keep the visible catalog **Claude-only** — the Settings toggle
correctness is proven with a `MockAdapter` in tests, and Antigravity becomes visible exactly when its adapter
lands in Spec B. This avoids shipping a user-facing toggle that spawns nothing.

---

## 5. Spawn wiring & Claude refactor  ✅ approved

### Adapter resolution at the call sites
`PtyManager` is constructed in `server/index.ts` at **lines 132 and 222** (new-spawn and restart paths,
post-merge). At both sites:
```ts
const config  = configService.getConfig();
const adapter = adapterForModel(goal.model ?? 'default', config.enabledProviders);
const ptyMgr  = new PtyManager(goal, adapter, { broadcast, onExit });
```
`PtyManager` gains an `adapter` constructor param (constructor at `pty-manager.ts:73-78`). It depends on the
`AgentAdapter` interface, **not** the registry — resolution happens at the call site.

### `pty-manager.ts` changes
- `start()` (line 80): replace `resolveClaudePath()` → `adapter.resolveBinary()`; replace inline arg building
  (lines 82-94) → `adapter.buildStartArgs(ctx)`; build `ctx` (goalId, model, cwd, permissionMode, mcpServer).
- `resume()` (line 203): `adapter.buildResumeArgs(sessionId, ctx)`.
- Prompt injection (lines 156-182): drive the existing idle/regex logic from `adapter.promptStrategy` via a
  small extracted helper `sendInitialPrompt(term, prompt, strategy)`. Claude keeps today's behavior
  (`{ kind: 'regex', promptRegex: /(?:>{1,2}|❯)\s*$/, idleMs: 5000 }`).
- `buildMcpConfig()` (lines 302-322): becomes a shared helper that produces the `McpServerDescriptor`; each
  adapter serializes it (Claude → inline JSON + `--mcp-config`).

### `ClaudeAdapter` (new `server/agents/claude-adapter.ts`)
Implements the full interface by **delegating to existing code** (no behavior change):
- Launch: today's path/args/prompt logic.
- Hooks: delegate `installHooks/uninstallHooks/hooksInstalled` to `hook-installer-service.ts`.
- Usage: delegate `locateSessionLog/parseUsage/listSessionLogs/pricingFor/contextWindowFor` to logic moved
  out of `usage-service.ts`.

### Analytics aggregation becomes provider-aware
`usage-service.ts`'s `getAllSessionUsageSummaries / getAggregateTotals / getDailyCosts` currently scan only
`~/.claude/...`. They become: for each enabled adapter, `listSessionLogs()` + `parseUsage()` + `pricingFor()`.
For Foundation (Claude only) output is **byte-for-byte identical**.

### Hard requirement
**Behavior-preserving.** After the refactor: Claude spawns with identical argv, identical prompt timing,
identical hook install, identical analytics numbers. Guarded by characterization tests (Section 6).

---

## 6. Testing strategy  ✅ approved

TDD per `superpowers:test-driven-development`. Write **characterization tests of current behavior first**,
then refactor behind the adapter keeping them green.

- **Characterization (write before refactor):** snapshot current Claude `start()`/`resume()` argv for
  representative goals; snapshot `usage-service` outputs against fixture JSONL. These must stay green through
  the refactor.
- **Registry unit tests:** `adapterForModel` resolution + fallback-to-Claude; `enabledModelOptions` union;
  claude-always-on invariant; disabled-provider goal falls back with warning.
- **config-service unit tests:** `getConfig` seeds defaults; `updateConfig` merges/validates/persists;
  claude cannot be removed; JSON round-trip; `tracePruneDays` field-name fix verified.
- **ClaudeAdapter tests:** `buildStartArgs`/`buildResumeArgs` equal the characterization snapshots;
  `parseUsage` equals legacy `usage-service` on the fixture; pricing/context-window parity.
- **MockAdapter fixture:** a fake second provider used to test multi-provider registry, picker union, and the
  Settings toggle without a real CLI.
- **Settings client test:** toggling a provider calls `updateConfig`; pickers reflect `enabledModelOptions`.
- **Regression:** existing `pty-manager` / `hook-ingest` / `usage` / schema tests remain green.

---

## 7. File-change summary

**New**
- `src/shared/agents/types.ts` — shared types (`AgentAdapter` DTO catalog, `ModelOption`, `SpawnContext`, `RawUsage`, `ModelPricing`, `McpServerDescriptor`).
- `server/agents/agent-adapter.ts` — the interface.
- `server/agents/claude-adapter.ts` — Claude reference implementation.
- `server/agents/registry.ts` — adapter list + resolution helpers.
- `server/services/config-service.ts` — persistence.
- `server/db/migrations/014_app_config.sql` — config table.
- `src/shared/agents/catalog.ts` (or expose via `/api/config`) — client-facing catalog.
- Tests for each of the above + a `MockAdapter` fixture.

**Modified**
- `src/shared/schemas.ts`, `src/shared/types.ts` — `enabledProviders`, field-name fix.
- `server/routes/system.ts` — real GET/PUT `/api/config` via config-service.
- `server/index.ts` — resolve adapter at PtyManager call sites (125, 216); wire config-service.
- `server/pty-manager.ts` — accept adapter; delegate binary/args/prompt/MCP.
- `server/services/usage-service.ts` — extract parsing/pricing/context-window into ClaudeAdapter; make
  aggregation provider-aware.
- `src/pages/SettingsPage.tsx` — Agents section.
- `src/components/{kanban/NewGoalModal,goal/GoalHeader,scheduled/ScheduledTaskEditor,kanban/KanbanCard}.tsx`
  — consume shared catalog instead of hardcoded model lists.

---

## 8. Estimated effort (Claude writing the code)

Active coding + test time; wall-clock depends on review cadence.

| Item | Hrs |
|---|---|
| Config persistence (migration 012 + config-service + system.ts + field-name fix) | 3–4 |
| `AgentProvider`/shared types + unify 5 model lists into shared catalog | 2–3 |
| `AgentAdapter` interface + `ClaudeAdapter` + registry + behavior-preserving refactor | 4–6 |
| Settings "Agents" toggle UI | 2–3 |
| Characterization + new tests | ~bundled above |
| **Total (Foundation)** | **~11–16** |

Spec B (Antigravity adapter) reuses all of this and is estimated separately (~14–23 hrs for full parity, per the spike).

---

## 9. Risks & mitigations
- **Refactor regresses Claude behavior** → characterization tests written first; behavior-preserving is a hard gate.
- **Analytics drift** after making aggregation provider-aware → fixture-based parity test vs. current output.
- **Config migration on existing installs** → `getConfig` seeds defaults when the row is absent; no destructive change to other tables.
- **Five scattered model lists** drift again → collapse to a single shared catalog as part of this work.
