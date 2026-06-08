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

---

## Self-Review (completed by plan author)

**Spec coverage:** §2 interface → Task 4/6; §3 registry → Task 7; §4 config+persistence+Settings → Tasks 2,3,8,10; §5 spawn wiring/Claude refactor → Tasks 6,8,9; §6 testing → tests in every task + MockAdapter (Task 7) + characterization (Tasks 6,9) + parity (Tasks 5,8); §0 baseline prerequisite → Task 0. All covered.

**Type consistency:** `AgentAdapter` (Task 4) is implemented identically by `ClaudeAdapter` (Task 6) and `MockAdapter` (Task 7); `RawUsage`/`ModelPricing`/`ModelOption`/`SpawnContext`/`McpServerDescriptor`/`AgentCatalogEntry` defined once (Task 1) and reused; `PersistedConfig` (Task 2) consumed by config-service (Task 3) and routes (Task 8); `adapterForModel`/`enabledModelOptions`/`buildCatalog` names consistent across Tasks 7/8/9/10.

**Known soft spots flagged in-line:** `getDailyCosts` date-grouping parity (Task 8 note — extend `RawUsage` with `firstMessageAt` if exact parity required); `dataDir` source (Task 8 note — wire to the real data dir if exported); the async `hooksInstalled()` refinement vs the spec's sync signature (documented, innocuous).
