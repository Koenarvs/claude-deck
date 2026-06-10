# OpenAI Codex Adapter ("Spec C") — Design Spec + Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` (or `superpowers:subagent-driven-development`) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. The lead section is the **design spec**; the numbered Tasks are the bite-sized TDD plan. **Task 1 is a mandatory discovery spike** — every later task's exact flags/paths depend on its recorded Findings.

**Status:** Design + plan drafted 2026-06-09. Spike partially pre-run against ground truth on this machine (see §1 Findings, marked ✅ verified / ⚠️ assumed). Re-confirm Task 1 against the user's actual installed `codex` CLI before Task 4.

**Phase:** Master roadmap **Phase 3 — Codex adapter ("Spec C")**. Sibling of "Spec B" (Antigravity).

**Prerequisites (HARD — do not start until both are green):**
- **Phase 0A** — `src/shared/agents/model-registry.ts` exists with `resolveModel()` and the `ModelEntry` shape (tier/quotaWeight/contextWindow/pricing|null). Codex models are *registered into* that file.
- **Phase 1** — the AgentAdapter foundation (Tasks 2–10 of `2026-06-06-agent-adapter-foundation.md`) is merged **with deltas A/B/C**: `RawUsage.byModel: RawModelUsage[]`, provider **records** (`{id, enabled, billingMode, seatPriceUsdMonthly?}`), the `capabilities: AgentCapabilities` field on the interface, `server/agents/claude-adapter.ts` + `server/agents/registry.ts` present, `prepareContext(ctx): void` on the interface.

> ⚠️ **Reality check (2026-06-09):** on the current working branch `server/agents/` does **not exist yet** and `src/shared/agents/` contains only `types.ts`. The `ClaudeAdapter`, registry, `model-registry.ts`, `config-service`, capability matrix, `RawUsage.byModel`, and `prepareContext` named above are **Phase 0A + Phase 1 deliverables that have not landed**. This plan assumes they are merged first; its first executable code task (Task 4) imports them. If they are absent when execution begins, STOP and finish Phase 0A + Phase 1 — do not stub them inside this plan.

---

## SPEC

### Purpose

Add a third provider — the **OpenAI Codex CLI** — as a full `AgentAdapter` (`'codex'`), so a goal whose model is a Codex model (`gpt-5.5`, …) spawns `codex` headlessly, its token usage flows into Phase 2 analytics under provider `'codex'`, and the UI degrades honestly where Codex lacks Claude-style affordances. Authentication uses the user's **ChatGPT subscription seat** (`codex login` → ChatGPT OAuth). **No OpenAI API key, ever** — `billingMode` defaults to `'seat'`, registry pricing is `null` (no metered rate), and analytics labels the dollars "API-equivalent value," not "cost."

### CLI characterization (what `codex` is and how we drive it)

Headless invocation is `codex exec`. The prompt is a **positional argument** ⇒ `promptStrategy { kind: 'flag' }` (no idle/regex prompt-glyph detection — Codex runs to completion and exits, it is not an interactive REPL we type into). Structured output via `--json` (newline-delimited JSON events on stdout). Session transcripts ("rollout" files) persist as JSONL under `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`.

| Concern | Claude (reference) | Codex (this spec) |
|---|---|---|
| Headless entry | `claude` (interactive PTY REPL) | `codex exec "<prompt>"` (runs to completion) |
| Prompt delivery | typed into REPL after idle/regex ready | **positional arg** ⇒ `promptStrategy {kind:'flag'}` |
| Model select | `--model <m>` | `--model <m>` / `-m` (e.g. `gpt-5.5`) |
| Cwd | PTY `cwd` option | `--cd <path>` / `-C` **and** PTY `cwd` option (belt+suspenders) |
| Autonomy | `--permission-mode bypassPermissions` | `--sandbox` + `--ask-for-approval` (autonomous → `--sandbox workspace-write --ask-for-approval never`; supervised → `--sandbox read-only --ask-for-approval on-request`) |
| Resume | `--resume <sessionId>` | `codex exec resume <SESSION_ID> "<prompt>"` (subcommand, not a flag) |
| JSONL events | stdout `--json` is separate from transcript | stdout `--json` events; **and** persisted rollout JSONL |
| Usage shape | `message.usage.{input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens}` | `turn.completed.usage.{input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens}` |
| Session-log dir | `~/.claude/projects/**/<id>.jsonl` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| Auth | Claude subscription / Vertex | **ChatGPT seat** (`codex login`, `auth_mode:"chatgpt"`, no API key) |
| Hooks | full SessionStart/PreToolUse/… hook system | **none** (no Claude-style settings.json hooks) |
| MCP | `--mcp-config <inlineJSON>` | MCP via `config.toml` `[mcp_servers.*]` (⚠️ confirm in spike) |
| Context file | `CLAUDE.md` | **`AGENTS.md`** ("same markdown for different agents") |

### Capabilities matrix (Codex — honest declaration)

```ts
capabilities: {
  canObserveHooks: false, // no Claude-style hook system; we cannot stream PreToolUse/Stop events
  canResume:       true,  // codex exec resume <id>
  canMcp:          true,  // ⚠️ via config.toml [mcp_servers]; downgrade to false in Task 1 if unconfirmed
  canApprove:      false, // headless exec has no interactive approval round-trip claude-deck can intercept
  canStream:       true,  // --json yields a live JSONL event stream
}
```

These flags drive the UI to grey out the approval toggle, the hook-install affordance, and (if `canMcp` ends up false) the orchestration controls for Codex goals — instead of silently lying.

### Key decisions (locked here, traceable to roadmap §2)

1. **Seat-only, no API key** (Decision 6). `resolveBinary` never reads `OPENAI_API_KEY`; auth is whatever `codex login` left in `~/.codex/auth.json` (`auth_mode:"chatgpt"`). Provider record `billingMode:'seat'`, registry pricing `null`.
2. **Dollars always computed, labeled "equivalent value"** (Decision 2/3). Because Codex pricing is `null` in the registry (no public per-token seat rate), Codex usage rows are stored with `estimated_cost_usd = 0` + an **unpriced** flag and full token counts retained — exactly the Phase 0A "loud unknown" path. When/if a public per-token reference rate is added to the registry, the equivalent-value number lights up with no schema change.
3. **Per-model attribution** (Decision 4). `parseUsage` returns `RawUsage.byModel`; a Codex session that mid-run switches `gpt-5.5`→`gpt-5.4-mini` produces two `byModel` rows. Codex JSONL carries the model on `thread.started`/turn metadata; rolled-up totals also returned for back-compat.
4. **`promptStrategy {kind:'flag'}`** — prompt is a launch arg; PtyManager's idle/regex machinery is bypassed for Codex (the foundation's Task 9 already parameterizes this off `adapter.promptStrategy`).
5. **`prepareContext` writes `AGENTS.md`** from the shared goal-doc set so the same markdown drives a Claude goal (`CLAUDE.md`) and a Codex goal (`AGENTS.md`).
6. **Hooks are honest no-ops.** `installHooks`/`uninstallHooks` resolve without touching anything; `hooksInstalled()` returns `false`. We **cannot** observe Codex tool-use through the hook pipeline — analytics for Codex come from the rollout JSONL (post-hoc ingestion), not live hook events.

### Capabilities → analytics consequence (called out so it isn't a silent gap)

Claude analytics has two feeds: **live hook events** (real-time board/trace) and **post-hoc JSONL ingestion** (cost/tokens). Codex has only the second. So a running Codex goal shows tokens/value **after** ingestion catches its rollout file, not live. This is acceptable for Phase 3 (analytics parity on cost/value) and is the reason `canObserveHooks:false`. Live Codex telemetry would require parsing the `--json` stdout stream in PtyManager — explicitly **out of scope** here (candidate for a later phase).

### Out of scope

- Live (real-time) Codex event streaming into the board/trace (`--json` stdout parsing in PtyManager).
- Antigravity (Spec B), any non-Codex OpenAI surface, the Codex *desktop/Electron* app's SQLite store (`~/.codex/sqlite/codex-dev.db` — that is the GUI product, **not** the CLI transcript format; do not parse it).
- Metered/API-key billing for Codex (forbidden by Decision 6).
- New analytics endpoints/UI (Phase 2 owns those; this spec only makes Codex rows *appear* in them).

### Migrations

**None.** `GoalModelSchema = z.string()` (arbitrary strings) and migration `005_relax_model_check.sql` already dropped the `goals.model` CHECK constraint, so a `gpt-5.5` model value persists with no DB change. Provider records (`billingMode:'seat'`) ride the Phase 1 `app_config` JSON blob (migration `014`/`015` already exist). Codex usage reuses the existing `session_usage` table; per-model granularity is Phase 2's concern. **No new migration number is consumed by this plan.**

### File-change summary

**New**
- `server/agents/codex-adapter.ts` — the adapter.
- `server/services/codex-usage-service.ts` — locate/parse/list Codex rollout JSONL → `RawUsage` (mirrors `usage-service` primitives).
- `tests/server/agents/codex-adapter.test.ts`, `tests/server/services/codex-usage-service.test.ts`.
- `tests/fixtures/codex/rollout-sample.jsonl` — recorded transcript fixture.
- `tests/fixtures/codex/sessions/2026/06/09/rollout-sample.jsonl` — for the `listSessionLogs` dir-walk test.

**Modified**
- `src/shared/agents/model-registry.ts` — register `gpt-5.5` (+ `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`) entries; pricing `null`, provider `'codex'`.
- `server/agents/registry.ts` — add `new CodexAdapter()` to `ADAPTERS` (catalog visible only when enabled).
- `server/services/ingestion-service.ts` — provider-aware ingest so Codex rollout files populate `session_usage` under provider `'codex'`.
- `server/index.ts` — schedule Codex ingestion alongside Claude (`~/.codex/sessions`).
- (Phase 1 Settings already renders the catalog; Codex appears with its `authHint` + capability greying — no new UI code unless Task 8 finds a gap.)

---

## PLAN

**TDD rhythm (every code task):** write failing test → run, confirm it fails for the expected reason → minimal real code → run, confirm pass → `npm run typecheck` → commit. Tests live in `tests/server/**` under the **node** Vitest project (Phase 0 split). Branch: `feat/codex-adapter` (branch off the merged Phase 1 base; do not work on `main`).

---

## Task 1 — DISCOVERY SPIKE (no production code; record Findings) 🔬

**This task gates every later task.** Run the real `codex` CLI, capture a real rollout transcript, and record the exact flags/paths/usage-shape below. The fields marked ✅ were pre-verified on this machine on 2026-06-09; **re-confirm** them against the user's installed CLI version (CLIs drift). Mark anything you cannot verify as ⚠️ ASSUMED and pick the conservative branch.

- [ ] **Step 1: Locate the binary & confirm it's the CLI (not the GUI).**
  ```bash
  codex --version
  command -v codex            # POSIX;  `where codex` on Windows
  codex --help
  codex exec --help
  ```
  > ⚠️ On this machine `codex` was **not on PATH**, yet `~/.codex/` exists and belongs to the **Codex desktop/Electron app** (`~/.codex/sqlite/codex-dev.db`, `.codex-global-state.json`, `electron-*` keys). The CLI may not be installed. **If `codex` is absent**, record "CLI not installed" and either (a) `npm i -g @openai/codex` (or the documented installer) to run the spike, or (b) proceed on the documented contract below and mark the whole Findings block ⚠️ ASSUMED pending a real run. **Never invent verified-looking flags.**

- [ ] **Step 2: Confirm auth is a ChatGPT seat (no API key).**
  ```bash
  codex login status
  ```
  Inspect `~/.codex/auth.json` **keys only** (never print token values).
  > ✅ **Verified 2026-06-09:** `auth.json` has `auth_mode: "chatgpt"`, `OPENAI_API_KEY` empty/false, and `tokens.id_token` claims include `chatgpt_plan_type: "plus"` + a `chatgpt_account_id`. This is the seat model the spec requires. Record the `auth_mode` string the adapter will check.

- [ ] **Step 3: Capture a real headless run + its JSONL events.**
  ```bash
  codex exec --json "say hello and stop" -C /tmp/spike 2>&1 | tee /tmp/codex-stdout.jsonl
  ```
  Record: did the prompt-as-positional-arg work? Did it exit on its own (confirming `promptStrategy {kind:'flag'}`)? Copy a sanitized few lines (esp. a `turn.completed` with `usage`) into the fixture (Step 6).

- [ ] **Step 4: Find the persisted rollout transcript + its format.**
  ```bash
  ls -R ~/.codex/sessions | head        # or  $CODEX_HOME/sessions
  ```
  Record the **exact** path template and a rollout filename. Confirm each line is a JSON object and capture the model-bearing line and the usage-bearing line(s).
  > ✅ **Documented layout:** `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`; `$CODEX_HOME` defaults to `~/.codex`. ⚠️ Confirm `rollout-*` glob + that usage lives in `turn.completed` (vs only on stdout `--json`). If persisted rollout files **omit** usage (usage only on stdout), record that — then `parseUsage` must read the same `turn.completed.usage` shape from whichever file actually contains it, and ingestion locates rollout files by the dir walk regardless.

- [ ] **Step 5: Confirm resume + MCP + sandbox/approval flags.**
  ```bash
  codex exec resume --last "continue"        # resume semantics
  codex exec --help | grep -iE 'sandbox|approval|mcp|model|cd|json|ephemeral|output'
  ```
  Record: exact resume syntax (`codex exec resume <ID> "<prompt>"` is a **subcommand**, not `--resume`); the sandbox values (`read-only|workspace-write|danger-full-access`), approval values (`untrusted|on-request|never`), and **whether MCP servers are configured via `config.toml` `[mcp_servers.<name>]`** (the documented mechanism — there is no `--mcp-config` flag like Claude). **If MCP cannot be confirmed configurable for a headless `exec` run, set `capabilities.canMcp=false`** and document the orchestration limitation (a Codex goal then cannot call the claude-deck MCP server to orchestrate siblings).

- [ ] **Step 6: Save the recorded transcript fixture.** Write the captured, **sanitized** rollout lines to `tests/fixtures/codex/rollout-sample.jsonl` (and a copy under `tests/fixtures/codex/sessions/2026/06/09/rollout-sample.jsonl` for the dir-walk test). It MUST contain ≥2 `turn.completed` events with `usage`, a model identifier, and ideally a mid-session model switch so the `byModel` test is meaningful. If the real shape differs from the assumed shape below, **the fixture is the source of truth** — update Tasks 2/3 to match it.

- [ ] **Step 7: Record Findings in this file** (fill every blank; replace ⚠️ with ✅ once run):
  ```
  ### Task 1 Findings (recorded <date>, codex <version>)
  - binary on PATH:            <path | NOT INSTALLED>
  - auth mode:                 auth_mode="chatgpt", api key absent      [✅/⚠️]
  - headless cmd:              codex exec "<prompt>"                     [✅/⚠️]
  - prompt delivery:           positional arg  ⇒ promptStrategy {kind:'flag'}  [✅/⚠️]
  - exits on completion:       <yes/no>                                  [ ]
  - model flag:                -m/--model <id>                           [✅/⚠️]
  - cwd flag:                  -C/--cd <path>                            [✅/⚠️]
  - autonomous flags:          --sandbox workspace-write --ask-for-approval never   [⚠️]
  - supervised flags:          --sandbox read-only --ask-for-approval on-request    [⚠️]
  - resume:                    codex exec resume <ID> "<prompt>"         [✅/⚠️]
  - json stream:               --json (NDJSON on stdout)                 [✅/⚠️]
  - rollout dir:               ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl  [⚠️]
  - usage event:               turn.completed.usage                      [⚠️]
  - usage fields:              input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens  [✅ from docs/⚠️ from real file]
  - model id source:           <thread.started? turn metadata? session_meta line?>  [ ]
  - models exposed by seat:    gpt-5.5(default), gpt-5.4, gpt-5.4-mini, gpt-5.3-codex  [✅ from ~/.codex/models_cache.json]
  - MCP for headless exec:     config.toml [mcp_servers.<name>] ⇒ canMcp=<true/false>  [⚠️ CONFIRM]
  - hooks:                     none ⇒ canObserveHooks=false              [✅ by design]
  - context file:              AGENTS.md                                 [✅ documented]
  ```

- [ ] **Step 8: Commit the spike artifacts** (fixture + Findings; no production code yet).
  ```bash
  git add docs/superpowers/plans/2026-06-09-codex-adapter.md tests/fixtures/codex/
  git commit -m "spike: codex CLI discovery — flags, rollout JSONL format, seat auth, usage shape"
  ```

> **Assumed-shape reference** for the fixture/tests below, from the public Codex docs + this machine's `~/.codex` (use only until Task 1 replaces with real lines):
> ```jsonl
> {"type":"thread.started","thread_id":"th_abc","model":"gpt-5.5"}
> {"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122,"reasoning_output_tokens":0}}
> {"type":"turn.completed","usage":{"input_tokens":300,"cached_input_tokens":10,"output_tokens":80,"reasoning_output_tokens":20}}
> ```
> Field mapping to `RawModelUsage`: `inputTokens = input_tokens`; `cacheReadTokens = cached_input_tokens`; `cacheCreationTokens = 0` (Codex has no separate cache-creation count — keep 0, do **not** fabricate); `outputTokens = output_tokens + reasoning_output_tokens` (reasoning tokens are billed output; record the decision in Findings and keep it consistent with whatever Phase 2 expects). `messageCount` = number of `turn.completed` events.

---

## Task 2 — Register Codex models in the model registry

**Depends on:** Phase 0A `model-registry.ts`. **Files:**
- Modify: `src/shared/agents/model-registry.ts`
- Test: `tests/shared/agents/model-registry-codex.test.ts`

- [ ] **Step 1: Write failing test.**
  ```ts
  // tests/shared/agents/model-registry-codex.test.ts
  import { describe, it, expect } from 'vitest';
  import { resolveModel } from '../../../src/shared/agents/model-registry';

  describe('codex models in registry', () => {
    it('resolves gpt-5.5 to a codex, seat-priced (null), frontier entry', () => {
      const m = resolveModel('gpt-5.5');
      expect(m).not.toBeNull();
      expect(m!.provider).toBe('codex');
      expect(m!.pricing).toBeNull();          // seat — no metered rate
      expect(m!.tier).toBe('frontier');
      expect(m!.contextWindow).toBeGreaterThanOrEqual(200_000);
    });
    it('resolves the mini variant to the fast tier', () => {
      expect(resolveModel('gpt-5.4-mini')!.tier).toBe('fast');
    });
    it('matches a transcript model string containing the id', () => {
      expect(resolveModel('openai/gpt-5.5')!.provider).toBe('codex');
    });
    it('unknown openai model stays null (no opus default)', () => {
      expect(resolveModel('gpt-9-imaginary')).toBeNull();
    });
  });
  ```

- [ ] **Step 2:** Run → FAIL (no codex entries). 

- [ ] **Step 3: Add entries to `MODEL_REGISTRY`.** Append codex `ModelEntry` records. `quotaWeight` is relative to the provider's lightest model (`gpt-5.4-mini` = 1). Use the real ids from `~/.codex/models_cache.json` (✅ `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`); set `contextWindow` from Task 1 Findings (default `200_000` if unknown — do **not** guess `400_000`; mark it ⚠️ in a comment).
  ```ts
  // codex / ChatGPT seat — pricing null (Decision 6: no metered rate); confirm contextWindow in spike.
  { id: 'gpt-5.5',      match: (r) => r.toLowerCase().includes('gpt-5.5'),      label: 'GPT-5.5',      provider: 'codex', tier: 'frontier', pricing: null, quotaWeight: 4, contextWindow: 200_000 },
  { id: 'gpt-5.4',      match: (r) => /gpt-5\.4(?!-mini)/i.test(r),             label: 'GPT-5.4',      provider: 'codex', tier: 'balanced', pricing: null, quotaWeight: 3, contextWindow: 200_000 },
  { id: 'gpt-5.4-mini', match: (r) => r.toLowerCase().includes('gpt-5.4-mini'), label: 'GPT-5.4 mini', provider: 'codex', tier: 'fast',     pricing: null, quotaWeight: 1, contextWindow: 200_000 },
  { id: 'gpt-5.3-codex',match: (r) => r.toLowerCase().includes('gpt-5.3-codex'),label: 'GPT-5.3 Codex',provider: 'codex', tier: 'balanced', pricing: null, quotaWeight: 3, contextWindow: 200_000 },
  ```
  > Ordering: `resolveModel` matches in array order — place the **`-mini` and `-codex` specific matchers BEFORE** the broad `gpt-5.4`/`gpt-5.5` matchers, or have the broad ones exclude the specific suffixes (the `(?!-mini)` negative lookahead above does this). Verify with the "mini → fast" test.

- [ ] **Step 4:** Run new test + existing `model-registry.test.ts` → PASS (Claude entries byte-identical; only additions). `npm run typecheck` → clean.

- [ ] **Step 5: Commit.**
  ```bash
  git add src/shared/agents/model-registry.ts tests/shared/agents/model-registry-codex.test.ts
  git commit -m "feat: register codex (gpt-5.x) models in the model registry — seat pricing null"
  ```

---

## Task 3 — Codex usage primitives (locate / parse / list rollout JSONL)

Mirror the Claude `usage-service` primitives but for the Codex rollout format. Returns the shared `RawUsage` **with `byModel`** (Phase 1 Delta A).

**Files:**
- Create: `server/services/codex-usage-service.ts`
- Test: `tests/server/services/codex-usage-service.test.ts`
- Fixtures: `tests/fixtures/codex/rollout-sample.jsonl`, `tests/fixtures/codex/sessions/2026/06/09/rollout-sample.jsonl` (from Task 1; if Task 1 produced real lines, use those — adjust expected numbers to match)

- [ ] **Step 1: Ensure the fixture exists** (recorded in Task 1). If using the assumed shape, the two `turn.completed` events above total: input `25063`, cached `24458`, output `222` (`122+0` + `80+20` reasoning folded into output), messageCount `2`, model `gpt-5.5`.

- [ ] **Step 2: Write failing test.**
  ```ts
  // tests/server/services/codex-usage-service.test.ts
  import { describe, it, expect } from 'vitest';
  import path from 'node:path';
  import { parseCodexUsage, listCodexRollouts, locateCodexRollout } from '../../../server/services/codex-usage-service';

  const fixture = path.resolve(__dirname, '../../fixtures/codex/rollout-sample.jsonl');
  const sessionsRoot = path.resolve(__dirname, '../../fixtures/codex/sessions');

  describe('codex usage primitives', () => {
    it('parseCodexUsage sums turn.completed usage and rolls up totals', () => {
      const u = parseCodexUsage(fixture);
      expect(u.inputTokens).toBe(25063);
      expect(u.cacheReadTokens).toBe(24458);     // cached_input_tokens
      expect(u.cacheCreationTokens).toBe(0);     // codex has no cache-creation count
      expect(u.outputTokens).toBe(222);          // output + reasoning_output
      expect(u.messageCount).toBe(2);
      expect(u.model).toBe('gpt-5.5');
    });
    it('parseCodexUsage groups per model in byModel', () => {
      const u = parseCodexUsage(fixture);
      expect(u.byModel.length).toBeGreaterThanOrEqual(1);
      expect(u.byModel[0].model).toBe('gpt-5.5');
      expect(u.byModel.reduce((s, m) => s + m.outputTokens, 0)).toBe(u.outputTokens);
    });
    it('listCodexRollouts walks YYYY/MM/DD and finds rollout files', () => {
      const paths = listCodexRollouts(0, sessionsRoot);
      expect(paths.some((p) => p.endsWith('rollout-sample.jsonl'))).toBe(true);
    });
    it('returns an empty zero-usage shape for a missing file', () => {
      const u = parseCodexUsage('/no/such/file.jsonl');
      expect(u.messageCount).toBe(0);
      expect(u.byModel).toEqual([]);
    });
  });
  ```

- [ ] **Step 3:** Run → FAIL (module missing).

- [ ] **Step 4: Write `server/services/codex-usage-service.ts`.** Parameterize the sessions root so tests can inject a fixture dir (default `~/.codex/sessions`). Read field names per Task 1 Findings.
  ```ts
  import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
  import { join } from 'node:path';
  import { homedir } from 'node:os';
  import type { RawUsage, RawModelUsage } from '../../src/shared/agents/types';

  const CODEX_SESSIONS_DIR = join(process.env['CODEX_HOME'] ?? join(homedir(), '.codex'), 'sessions');

  function emptyModelRow(model: string | null): RawModelUsage {
    return { model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, messageCount: 0 };
  }

  /** Parse one Codex rollout JSONL → per-model + rolled-up RawUsage. */
  export function parseCodexUsage(filePath: string): RawUsage {
    const rows = new Map<string | null, RawModelUsage>();
    let currentModel: string | null = null;
    let firstModel: string | null = null;
    let content: string;
    try { content = readFileSync(filePath, 'utf-8'); } catch {
      return { ...emptyModelRow(null), byModel: [] };
    }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let ev: any;
      try { ev = JSON.parse(line); } catch { continue; }
      // model id may appear on thread.started / session_meta / turn metadata — adjust per Task 1 Findings
      const m = ev?.model ?? ev?.thread?.model ?? ev?.turn?.model ?? ev?.payload?.model;
      if (typeof m === 'string') { currentModel = m; if (!firstModel) firstModel = m; }
      const usage = ev?.usage ?? (ev?.type === 'turn.completed' ? ev?.usage : undefined);
      if (!usage) continue;
      const row = rows.get(currentModel) ?? emptyModelRow(currentModel);
      row.inputTokens       += (usage.input_tokens as number) ?? 0;
      row.cacheReadTokens   += (usage.cached_input_tokens as number) ?? 0;
      // Codex has no cache_creation_input_tokens — leave at 0 (do not fabricate).
      row.outputTokens      += ((usage.output_tokens as number) ?? 0) + ((usage.reasoning_output_tokens as number) ?? 0);
      row.messageCount++;
      rows.set(currentModel, row);
    }
    const byModel = [...rows.values()];
    const totals = byModel.reduce<RawModelUsage>((acc, r) => ({
      model: acc.model ?? r.model,
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + r.cacheReadTokens,
      cacheCreationTokens: acc.cacheCreationTokens + r.cacheCreationTokens,
      messageCount: acc.messageCount + r.messageCount,
    }), emptyModelRow(firstModel));
    return { ...totals, model: firstModel, byModel };
  }

  /** Find a rollout file whose name contains the session id. */
  export function locateCodexRollout(sessionId: string, root = CODEX_SESSIONS_DIR): string | null {
    for (const p of listCodexRollouts(0, root)) {
      if (p.includes(sessionId)) return p;
    }
    return null;
  }

  /** Walk sessions/YYYY/MM/DD and return rollout JSONL paths modified within the window. */
  export function listCodexRollouts(sinceMs = 0, root = CODEX_SESSIONS_DIR): string[] {
    if (!existsSync(root)) return [];
    const cutoff = sinceMs > 0 ? Date.now() - sinceMs : 0;
    const out: string[] = [];
    const walk = (dir: string) => {
      let entries: string[]; try { entries = readdirSync(dir); } catch { return; }
      for (const name of entries) {
        const fp = join(dir, name);
        let st; try { st = statSync(fp); } catch { continue; }
        if (st.isDirectory()) { walk(fp); continue; }
        if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
        if (cutoff > 0 && st.mtimeMs < cutoff) continue;
        out.push(fp);
      }
    };
    walk(root);
    return out;
  }
  ```
  > `any` is used for the per-line JSON deliberately (untyped external transcript); if the repo lints `no-explicit-any`, type as `Record<string, unknown>` and narrow. Keep the field reads aligned with the Task 1 fixture.

- [ ] **Step 5:** Run test → PASS. `npm run typecheck` → clean.

- [ ] **Step 6: Commit.**
  ```bash
  git add server/services/codex-usage-service.ts tests/server/services/codex-usage-service.test.ts tests/fixtures/codex/
  git commit -m "feat: codex rollout JSONL usage primitives (RawUsage.byModel)"
  ```

---

## Task 4 — CodexAdapter (full AgentAdapter)

**Depends on:** Tasks 2–3, Phase 1 interface (with `capabilities` + `prepareContext`). **Files:**
- Create: `server/agents/codex-adapter.ts`
- Test: `tests/server/agents/codex-adapter.test.ts`

- [ ] **Step 1: Write failing test (characterizes the Codex argv — exact, per Task 1 Findings).**
  ```ts
  // tests/server/agents/codex-adapter.test.ts
  import { describe, it, expect } from 'vitest';
  import { CodexAdapter } from '../../../server/agents/codex-adapter';
  import type { SpawnContext } from '../../../src/shared/agents/types';

  const base: SpawnContext = { goalId: 'g1', model: 'gpt-5.5', cwd: '/repo', permissionMode: 'supervised', mcpServer: null };
  const a = new CodexAdapter();

  describe('CodexAdapter', () => {
    it('promptStrategy is flag (prompt passed as launch arg)', () => {
      expect(a.promptStrategy).toEqual({ kind: 'flag' });
    });
    it('capabilities: no hooks/approve, yes resume/stream', () => {
      expect(a.capabilities.canObserveHooks).toBe(false);
      expect(a.capabilities.canApprove).toBe(false);
      expect(a.capabilities.canResume).toBe(true);
      expect(a.capabilities.canStream).toBe(true);
    });
    it('catalog exposes gpt-5.5 default + variants and a seat authHint', () => {
      expect(a.id).toBe('codex');
      expect(a.models.map((m) => m.value)).toContain('gpt-5.5');
      expect(a.authHint).toMatch(/ChatGPT/i);
    });
    it('start args: exec + json + model + cwd + supervised sandbox; prompt is appended last', () => {
      const args = a.buildStartArgs({ ...base });
      expect(args[0]).toBe('exec');
      expect(args).toContain('--json');
      expect(args).toEqual(expect.arrayContaining(['--model', 'gpt-5.5']));
      expect(args).toEqual(expect.arrayContaining(['-C', '/repo']));
      expect(args).toEqual(expect.arrayContaining(['--sandbox', 'read-only']));
      expect(args).toEqual(expect.arrayContaining(['--ask-for-approval', 'on-request']));
    });
    it('autonomous → workspace-write + never-approval', () => {
      const args = a.buildStartArgs({ ...base, permissionMode: 'autonomous' });
      expect(args).toEqual(expect.arrayContaining(['--sandbox', 'workspace-write']));
      expect(args).toEqual(expect.arrayContaining(['--ask-for-approval', 'never']));
    });
    it('resume uses the exec resume subcommand', () => {
      const args = a.buildResumeArgs('sess-9', base);
      expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'sess-9']);
    });
    it('hooks are honest no-ops', async () => {
      await expect(a.installHooks()).resolves.toBeUndefined();
      await expect(a.hooksInstalled()).resolves.toBe(false);
    });
  });
  ```
  > The prompt: with `promptStrategy {kind:'flag'}`, the prompt is appended to argv by PtyManager (Task 7), not by `buildStartArgs`. So `buildStartArgs` returns everything **except** the prompt; Task 7 appends `ctx`-carried prompt last. If the foundation instead threads the prompt into `SpawnContext`, append it in `buildStartArgs` and adjust this test — match whatever the merged Phase 1 PtyManager expects (record in Task 7).

- [ ] **Step 2:** Run → FAIL (module missing).

- [ ] **Step 3: Write `server/agents/codex-adapter.ts`.**
  ```ts
  import { execSync } from 'node:child_process';
  import { writeFileSync } from 'node:fs';
  import { join } from 'node:path';
  import type { AgentAdapter, PromptStrategy, AgentCapabilities } from './agent-adapter';
  import type { ModelOption, SpawnContext, RawUsage, ModelPricing } from '../../src/shared/agents/types';
  import { resolveModel } from '../../src/shared/agents/model-registry';
  import { parseCodexUsage, locateCodexRollout, listCodexRollouts } from '../services/codex-usage-service';
  import logger from '../logger';

  let cachedPath: string | null = null;

  export class CodexAdapter implements AgentAdapter {
    readonly id = 'codex';
    readonly label = 'OpenAI Codex';
    readonly authHint = 'Sign in to Codex with your ChatGPT account (run `codex login`). No API key required.';
    readonly models: ModelOption[] = [
      { value: 'gpt-5.5', label: 'GPT-5.5' },
      { value: 'gpt-5.4', label: 'GPT-5.4' },
      { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
      { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
    ];
    readonly promptStrategy: PromptStrategy = { kind: 'flag' };
    readonly capabilities: AgentCapabilities = {
      canObserveHooks: false,   // no Claude-style hook system
      canResume: true,
      canMcp: true,             // ⚠️ Task 1: set false if headless MCP unconfirmed
      canApprove: false,        // headless exec has no interceptable approval round-trip
      canStream: true,          // --json
    };

    resolveBinary(): string {
      if (cachedPath) return cachedPath;
      try {
        let p = execSync(process.platform === 'win32' ? 'where codex' : 'which codex', { encoding: 'utf-8' })
          .trim().split(/\r?\n/)[0].trim();
        if (p.startsWith('/c/')) p = 'C:/' + p.slice(3);
        if (process.platform === 'win32' && !p.endsWith('.exe') && !p.endsWith('.cmd')) p += '.exe';
        cachedPath = p;
      } catch {
        cachedPath = process.platform === 'win32' ? 'codex.exe' : 'codex';
      }
      return cachedPath;
    }

    private sandboxArgs(mode: SpawnContext['permissionMode']): string[] {
      return mode === 'autonomous'
        ? ['--sandbox', 'workspace-write', '--ask-for-approval', 'never']
        : ['--sandbox', 'read-only', '--ask-for-approval', 'on-request'];
    }

    buildStartArgs(ctx: SpawnContext): string[] {
      const args = ['exec', '--json'];
      if (ctx.model && ctx.model !== 'default') args.push('--model', ctx.model);
      args.push('-C', ctx.cwd);
      args.push(...this.sandboxArgs(ctx.permissionMode));
      // MCP: configured via ~/.codex/config.toml [mcp_servers.*], NOT a flag (Task 1). If canMcp,
      // prepareContext() (or a config-merge helper) must have written it before spawn. No argv change.
      // Prompt is appended by PtyManager because promptStrategy.kind === 'flag'.
      return args;
    }

    buildResumeArgs(sessionId: string, ctx: SpawnContext): string[] {
      const args = ['exec', 'resume', sessionId, '--json'];
      args.push(...this.sandboxArgs(ctx.permissionMode));
      return args;
    }

    // No hook system — honest no-ops.
    async installHooks(): Promise<void> { /* codex has no hook system */ }
    async uninstallHooks(): Promise<void> { /* codex has no hook system */ }
    async hooksInstalled(): Promise<boolean> { return false; }

    locateSessionLog(sessionId: string): string | null { return locateCodexRollout(sessionId); }
    parseUsage(logPath: string): RawUsage { return parseCodexUsage(logPath); }
    listSessionLogs(sinceMs: number): string[] { return listCodexRollouts(sinceMs); }

    pricingFor(model: string): ModelPricing {
      const entry = resolveModel(model);
      if (!entry || entry.pricing === null) {
        // seat — no metered rate. Zero pricing ⇒ equivalent value 0 until a reference rate is added.
        return { input: 0, cache_read: 0, cache_creation: 0, output: 0 };
      }
      return entry.pricing;
    }

    contextWindowFor(model: string, currentTokens: number): number {
      const entry = resolveModel(model);
      const base = entry?.contextWindow ?? 200_000;
      return currentTokens > base ? currentTokens : base;
    }

    /** Generate AGENTS.md from the shared goal docs so the same markdown drives a Codex goal. */
    prepareContext(ctx: SpawnContext): void {
      try {
        // Mirror the shared goal-doc set the ClaudeAdapter points CLAUDE.md at.
        // Implementation note: reuse the foundation's shared context-doc builder if one exists;
        // otherwise write the goal's plan/handoff/notes into <cwd>/AGENTS.md. Idempotent.
        const target = join(ctx.cwd, 'AGENTS.md');
        const body = buildSharedContextMarkdown(ctx); // ← shared helper from Phase 1; see Task 6
        writeFileSync(target, body, 'utf-8');
      } catch (err) {
        logger.warn({ err, goalId: ctx.goalId }, 'CodexAdapter: failed to write AGENTS.md');
      }
    }
  }

  // Placeholder import target — replace with the real shared builder in Task 6.
  declare function buildSharedContextMarkdown(ctx: SpawnContext): string;
  ```
  > The `declare function` placeholder is a **plan marker** — Task 6 wires `prepareContext` to the real shared context-doc builder. If Phase 1 shipped no such builder, Task 6 creates a minimal one and both adapters use it. Do not ship the `declare` stub.

- [ ] **Step 4:** Run test → PASS. `npm run typecheck` → clean.

- [ ] **Step 5: Commit.**
  ```bash
  git add server/agents/codex-adapter.ts tests/server/agents/codex-adapter.test.ts
  git commit -m "feat: CodexAdapter — full AgentAdapter (seat auth, flag prompt, honest capabilities)"
  ```

---

## Task 5 — Register CodexAdapter in the registry

**Files:**
- Modify: `server/agents/registry.ts`
- Test: `tests/server/agents/registry-codex.test.ts`

- [ ] **Step 1: Write failing test.**
  ```ts
  // tests/server/agents/registry-codex.test.ts
  import { describe, it, expect } from 'vitest';
  import { adapterForModel, enabledModelOptions, buildCatalog, getAdapter } from '../../../server/agents/registry';

  describe('registry knows codex', () => {
    it('getAdapter("codex") exists', () => {
      expect(getAdapter('codex')?.id).toBe('codex');
    });
    it('resolves gpt-5.5 to codex when enabled', () => {
      expect(adapterForModel('gpt-5.5', ['claude', 'codex']).id).toBe('codex');
    });
    it('falls back to claude when codex disabled', () => {
      expect(adapterForModel('gpt-5.5', ['claude']).id).toBe('claude');
    });
    it('catalog includes codex (enabled flag honored)', () => {
      const cat = buildCatalog(['claude']);
      const codex = cat.find((c) => c.id === 'codex');
      expect(codex?.enabled).toBe(false);
      expect(codex?.capabilities.canObserveHooks).toBe(false);
    });
    it('enabled codex contributes its models to the picker union', () => {
      expect(enabledModelOptions(['claude', 'codex']).some((m) => m.value === 'gpt-5.5')).toBe(true);
    });
  });
  ```
  > `buildCatalog` entries must carry `capabilities` (Phase 1 Delta C added it to `AgentCatalogEntry`). If the Phase 1 `buildCatalog` does not yet copy `a.capabilities`, that is a Phase 1 gap — fix it there, not here. Test asserts it so the gap surfaces.

- [ ] **Step 2:** Run → FAIL (codex not in default registry).

- [ ] **Step 3: Edit `server/agents/registry.ts`.** Import and add `new CodexAdapter()` to the default `ADAPTERS` list:
  ```ts
  import { CodexAdapter } from './codex-adapter';
  // ...
  const defaultRegistry = makeRegistry([new ClaudeAdapter(), new CodexAdapter()]);
  ```
  The catalog is union-of-all-adapters but `enabled` is driven by config, so Codex only *appears active* when the user toggles it on in Settings (Phase 1 already renders `authHint` + capabilities). Claude-always-on invariant is untouched.

- [ ] **Step 4:** Run new + existing registry tests → PASS. `npm run typecheck` → clean.

- [ ] **Step 5: Commit.**
  ```bash
  git add server/agents/registry.ts tests/server/agents/registry-codex.test.ts
  git commit -m "feat: register CodexAdapter in the agent registry"
  ```

---

## Task 6 — Shared context-doc builder + AGENTS.md (`prepareContext`)

Realize "same markdown for different agents": one builder produces the body, `ClaudeAdapter.prepareContext` writes `CLAUDE.md`, `CodexAdapter.prepareContext` writes `AGENTS.md`.

**Files:**
- Create (or reuse Phase 1's): `server/agents/shared-context.ts` (`buildSharedContextMarkdown(ctx)`)
- Modify: `server/agents/codex-adapter.ts` (replace the `declare` placeholder with the real import)
- Modify: `server/agents/claude-adapter.ts` (only if it lacks `prepareContext` — point it at the same builder writing `CLAUDE.md`)
- Test: `tests/server/agents/prepare-context.test.ts`

- [ ] **Step 1: Write failing test (uses a temp cwd; asserts file lands + reuses shared body).**
  ```ts
  // tests/server/agents/prepare-context.test.ts
  import { describe, it, expect, beforeEach, afterEach } from 'vitest';
  import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';
  import { CodexAdapter } from '../../../server/agents/codex-adapter';
  import type { SpawnContext } from '../../../src/shared/agents/types';

  let cwd: string;
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'codex-ctx-')); });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it('CodexAdapter.prepareContext writes AGENTS.md into cwd', () => {
    const ctx: SpawnContext = { goalId: 'g1', model: 'gpt-5.5', cwd, permissionMode: 'supervised', mcpServer: null };
    new CodexAdapter().prepareContext(ctx);
    expect(existsSync(join(cwd, 'AGENTS.md'))).toBe(true);
    expect(readFileSync(join(cwd, 'AGENTS.md'), 'utf-8').length).toBeGreaterThan(0);
  });
  ```

- [ ] **Step 2:** Run → FAIL (`buildSharedContextMarkdown` unresolved / `declare` placeholder).

- [ ] **Step 3: Write `server/agents/shared-context.ts`.** If Phase 1 already has a shared goal-doc set (plan/research/notes/handoff/todo), read those for `ctx.goalId` and render; otherwise emit a minimal honest header.
  ```ts
  import type { SpawnContext } from '../../src/shared/agents/types';

  /** Provider-agnostic context body. Each adapter writes it to its CLI's native file
   *  (Claude → CLAUDE.md, Codex → AGENTS.md, Gemini/Antigravity → GEMINI.md). */
  export function buildSharedContextMarkdown(ctx: SpawnContext): string {
    // Reuse the foundation's goal-doc loader if present (plan/handoff/notes for ctx.goalId).
    // Minimal baseline so the file is never empty:
    return [
      `# Agent Context (goal ${ctx.goalId})`,
      '',
      'This file is generated by claude-deck so any agent CLI reads the same project context.',
      '',
      '<!-- shared goal docs (plan / research / notes / handoff / todo) are injected here -->',
      '',
    ].join('\n');
  }
  ```

- [ ] **Step 4: Wire `CodexAdapter.prepareContext`** to import from `./shared-context` (delete the `declare function` placeholder). Ensure `ClaudeAdapter.prepareContext` writes `CLAUDE.md` from the **same** builder (if Phase 1's ClaudeAdapter already implements `prepareContext`, leave it and just confirm it uses the shared builder; if not, add it).

- [ ] **Step 5:** Run test → PASS. `npm run typecheck` → clean. Confirm the existing ClaudeAdapter test (if any asserts `prepareContext`) stays green.

- [ ] **Step 6: Commit.**
  ```bash
  git add server/agents/shared-context.ts server/agents/codex-adapter.ts server/agents/claude-adapter.ts tests/server/agents/prepare-context.test.ts
  git commit -m "feat: shared context-doc builder — Codex prepareContext writes AGENTS.md"
  ```

---

## Task 7 — PtyManager spawns Codex (flag prompt + cwd) — wiring check

Verify the foundation's adapter-driven PtyManager already handles a `{kind:'flag'}` adapter; add the one missing piece if not (appending the prompt to argv).

**Files:**
- Modify (only if needed): `server/pty-manager.ts`
- Test: `tests/server/pty-manager-codex.test.ts`

- [ ] **Step 1: Write failing test (no real spawn — assert argv built via CodexAdapter, prompt appended).**
  ```ts
  // tests/server/pty-manager-codex.test.ts
  import { describe, it, expect } from 'vitest';
  import { PtyManager } from '../../server/pty-manager';
  import { CodexAdapter } from '../../server/agents/codex-adapter';
  import type { Goal } from '../../src/shared/types';

  const goal = { id: 'g1', cwd: '/repo', model: 'gpt-5.5', permission_mode: 'autonomous' } as Goal;

  describe('PtyManager + CodexAdapter', () => {
    it('builds codex exec argv and appends the prompt last (flag strategy)', () => {
      const mgr = new PtyManager(goal, new CodexAdapter(), { broadcast: () => {} });
      const args = mgr.buildLaunchArgs('do the thing'); // foundation exposes buildLaunchArgs(prompt?)
      expect(args[0]).toBe('exec');
      expect(args).toEqual(expect.arrayContaining(['--model', 'gpt-5.5', '--sandbox', 'workspace-write']));
      expect(args[args.length - 1]).toBe('do the thing'); // appended because promptStrategy.kind==='flag'
    });
  });
  ```
  > Foundation Task 9 added a pure `buildLaunchArgs()`. **Delta for flag strategy:** when `adapter.promptStrategy.kind === 'flag'`, `buildLaunchArgs(prompt)` appends the prompt to the adapter's args (and PtyManager must NOT later try to type it into the PTY). When kind is `idle`/`regex` (Claude), prompt is typed post-ready as today. Adjust `buildLaunchArgs` signature to accept the optional prompt; default-empty keeps Claude tests green.

- [ ] **Step 2:** Run → FAIL (prompt not appended for flag strategy, or `buildLaunchArgs` arity).

- [ ] **Step 3: Edit `server/pty-manager.ts`.**
  1. In `start(initialPrompt?)`: branch on `this.adapter.promptStrategy.kind`:
     - `'flag'`: `const args = this.buildLaunchArgs(initialPrompt);` (prompt in argv) and **skip** the idle/regex prompt-typing block entirely; still fire `onReady` after spawn (Codex runs to completion — `onExit` is the real "done" signal).
     - `'idle'`/`'regex'`: unchanged (today's typing-after-ready path).
  2. `buildLaunchArgs(prompt?: string)`: for flag strategy, return `[...adapter.buildStartArgs(ctx), ...(prompt ? [prompt] : [])]`; otherwise `adapter.buildStartArgs(ctx)`.
  3. Call `this.adapter.prepareContext(this.spawnContext())` just before `pty.spawn` so AGENTS.md/CLAUDE.md is written first.
  4. MCP: PtyManager builds `McpServerDescriptor` (goalId in env) as today; the adapter decides serialization. Codex needs the descriptor merged into `~/.codex/config.toml` (if `canMcp`) — do that in a small helper called from `prepareContext` or `start()` **only when `adapter.capabilities.canMcp`**. If Task 1 set `canMcp=false`, skip and log once that Codex goals can't orchestrate via MCP.

- [ ] **Step 4:** Run new + existing pty-manager tests → PASS (Claude argv/timing unchanged — flag branch only triggers for Codex). `npm run typecheck` → clean.

- [ ] **Step 5: Commit.**
  ```bash
  git add server/pty-manager.ts tests/server/pty-manager-codex.test.ts
  git commit -m "feat: PtyManager flag-prompt strategy + prepareContext (codex spawns headless)"
  ```

---

## Task 8 — Codex usage flows into ingestion + Phase 2 analytics

Make Codex rollout files populate `session_usage` so Codex sessions appear in analytics under provider `'codex'`.

**Files:**
- Modify: `server/services/ingestion-service.ts` (provider-aware)
- Modify: `server/index.ts` (schedule Codex ingestion)
- Test: `tests/server/services/codex-ingestion.test.ts`

- [ ] **Step 1: Write failing test.** Build a temp `sessions/2026/06/09/rollout-x.jsonl` from the fixture, run the (new) `ingestCodexSessions(db, root)`, assert a `session_usage` row exists with the Codex token counts, `model='gpt-5.5'`, and `estimated_cost_usd = 0` (seat/unpriced — full tokens retained).
  ```ts
  // tests/server/services/codex-ingestion.test.ts (sketch)
  // - freshDb() with the session_usage schema (copy from analytics-ingestion.test.ts helper)
  // - copy tests/fixtures/codex/rollout-sample.jsonl into tmp/sessions/2026/06/09/
  // - await ingestCodexSessions(db, tmpSessionsRoot)
  // - row = db.prepare('SELECT * FROM session_usage').get()
  // - expect(row.model).toBe('gpt-5.5'); expect(row.input_tokens).toBe(25063);
  //   expect(row.estimated_cost_usd).toBe(0); expect(row.output_tokens).toBe(222);
  ```

- [ ] **Step 2:** Run → FAIL (`ingestCodexSessions` missing).

- [ ] **Step 3: Add `ingestCodexSessions(db, sessionsRoot)` to `ingestion-service.ts`.** Reuse `listCodexRollouts` + `parseCodexUsage` (Task 3) and `resolveModel` from the registry for pricing (which is `null` ⇒ store cost 0 with full tokens; do **not** opus-default — this is the Phase 0A "loud unknown"/seat path). Derive `session_id` from the rollout filename; `project_dir = 'codex'` (or the rollout's source cwd if the transcript records it — record in Task 1). Keep the existing `ingestAllSessions` (Claude) untouched.
  > Per-model rows: Phase 2 owns the `session_model_usage` child table. For Phase 3, write the **rolled-up** session row (so Codex appears in totals) and stash `byModel` only if Phase 2's schema is already merged. If not, a follow-up in Phase 2 backfills per-model — note this so it isn't forgotten.

- [ ] **Step 4: Schedule it in `server/index.ts`.** Next to the Claude `ingestAllSessions` call/interval, add a Codex pass over `~/.codex/sessions` (guard with `existsSync`): 
  ```ts
  const CODEX_SESSIONS_DIR = join(process.env['CODEX_HOME'] ?? join(homedir(), '.codex'), 'sessions');
  // initial + setInterval, mirroring the Claude ingestion cadence; only if the dir exists.
  ```
  > Honest gate: only ingest Codex if provider `'codex'` is enabled in config OR the dir exists — avoid surprising the user. Prefer: ingest if the rollout dir exists (cheap, read-only) so historical Codex usage shows up; analytics filtering by enabled-provider is Phase 2's call.

- [ ] **Step 5:** Run new + existing ingestion/analytics tests → PASS (Claude numbers unchanged). `npm run typecheck` → clean.

- [ ] **Step 6: Commit.**
  ```bash
  git add server/services/ingestion-service.ts server/index.ts tests/server/services/codex-ingestion.test.ts
  git commit -m "feat: ingest codex rollout usage into session_usage (provider codex, seat-unpriced)"
  ```

---

## Task 9 — Settings visibility + seat auth UX (verify; patch only if gapped)

Phase 1's Settings "Agents" section already renders every catalog entry with its toggle, `authHint`, and (Delta C) capability-driven greying. This task **verifies** Codex renders correctly and patches only if a gap exists.

**Files:**
- Possibly modify: `src/components/settings/AgentsSection.tsx` / `src/pages/SettingsPage.tsx` (only if Codex doesn't render or capabilities aren't honored)
- Test: `tests/client/components/AgentsSection-codex.test.tsx`

- [ ] **Step 1: Write test (client/jsdom project).** Render `AgentsSection` with a Codex catalog entry (`enabled:false`, `authHint:'Sign in to Codex with your ChatGPT account…'`, `capabilities.canApprove:false`). Assert: a Codex toggle renders and is **not** disabled (it's optional, unlike Claude); toggling it calls `onToggle(['claude','codex'])`; the ChatGPT authHint text shows when enabled; no API-key field appears anywhere.
  ```tsx
  it('renders codex with ChatGPT seat hint and no api-key field', () => { /* ... */ });
  it('toggling codex on calls onToggle including claude', () => { /* expect onToggle(['claude','codex']) */ });
  ```

- [ ] **Step 2:** Run → if Phase 1's component already satisfies these, it PASSES with no code change (record that). If it FAILS (e.g. capabilities not surfaced, or authHint hidden), make the minimal patch.

- [ ] **Step 3 (only if patched):** add capability-aware greying / authHint display. Keep Claude-locked-on behavior intact.

- [ ] **Step 4:** Run client tests → PASS. `npm run typecheck` → clean.

- [ ] **Step 5: Commit** (skip if no change needed; otherwise):
  ```bash
  git add src/components/settings/AgentsSection.tsx tests/client/components/AgentsSection-codex.test.tsx
  git commit -m "test: Settings renders Codex provider with ChatGPT seat auth hint (no api key)"
  ```

---

## Final verification

- [ ] `npm run typecheck` → clean.
- [ ] `npm test` → 0 new failures vs the Phase 1 baseline (Claude characterization tests still green — Codex is purely additive).
- [ ] If `codex` CLI is installed: `npm run dev`, create a goal with model **gpt-5.5**, confirm it spawns `codex exec --json --model gpt-5.5 -C <cwd> --sandbox … "<prompt>"`, writes `AGENTS.md`, runs to completion, and (after ingestion) the session shows tokens + equivalent-value under provider **codex** in Analytics. If the CLI is absent, confirm the unit/fixture path fully and note "live e2e pending CLI install."
- [ ] Settings shows **OpenAI Codex** as a toggleable provider with the ChatGPT-seat authHint, no API-key field, and approval/hook affordances greyed for Codex goals.
- [ ] Grep confirms **no** `OPENAI_API_KEY` read anywhere in the Codex path (Decision 6).

---

## Self-Review (by plan author)

**Scope coverage (vs the 6-point SCOPE):** (1) full CodexAdapter — Task 4 (resolveBinary/buildStart/Resume/promptStrategy{flag}/hook no-ops/locate/parseUsage→byModel/list/pricing/contextWindow/capabilities/prepareContext). (2) registry model entries — Task 2 (gpt-5.5 + variants, pricing null, tier/quotaWeight/contextWindow). (3) registry + Settings + billingMode 'seat' — Task 5 (registry) + Task 9 (Settings) + spec §Decisions (seat default via Phase 1 provider record). (4) parseUsage → ingestion → Phase 2 analytics under provider 'codex' — Task 8. (5) seat auth UX, no API key — authHint (Task 4), Task 9, final grep. (6) MCP honesty — `canMcp` confirmed in Task 1 spike; config.toml mapping in Task 7 when true, `canMcp=false` + documented limitation when false. All six mapped.

**Locked contracts honored:** `AgentCapabilities {canObserveHooks,canResume,canMcp,canApprove,canStream}` + `prepareContext(ctx):void` — implemented (Task 4); `promptStrategy {kind:'flag'}` — Task 4; `RawUsage {…totals, byModel: RawModelUsage[]}` — Task 3; pricing via `resolveModel()`, null=seat — Tasks 2/4; `SpawnContext {goalId,model,cwd,permissionMode,mcpServer}` — consumed unchanged; provider record `{id:'codex', enabled, billingMode:'seat', seatPriceUsdMonthly?}` — spec §Decisions, set in Phase 1 config (this plan adds no new config schema). Prerequisite "Phase 1 + Phase 0A first" — stated up front as a hard gate.

**Spike-honesty:** Task 1 is discovery-first; every exact flag is either ✅-verified on this machine (auth_mode=chatgpt seat, model ids, `--json`/`exec`/resume/sandbox from OpenAI docs) or explicitly ⚠️ ASSUMED with a conservative fallback (contextWindow 200k not guessed higher; MCP downgrades to `canMcp=false` if unconfirmed; usage field mapping driven by the recorded fixture, not invented). The local `~/.codex` is correctly identified as the **GUI/Electron** product (SQLite store) and excluded — the CLI rollout JSONL is the real target.

**Migrations:** none (`GoalModelSchema=z.string()`; migration 005 already removed the model CHECK; provider records ride the existing app_config blob; usage reuses `session_usage`).

**Known soft spots flagged inline:** real CLI may be absent on the dev box (Task 1 Step 1 fallback); persisted-rollout-vs-stdout usage location (Task 1 Step 4); per-model `session_model_usage` table is Phase 2's (Task 8 writes rolled-up now, notes the backfill); `reasoning_output_tokens` folded into output (Task 1/3, must match Phase 2); `buildLaunchArgs` prompt-append signature depends on the merged Phase 1 PtyManager (Task 7 reconciles); `prepareContext` reuses Phase 1's goal-doc builder if it exists, else a minimal one (Task 6).
