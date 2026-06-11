# Antigravity (Google) Adapter — Design Spec + Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:executing-plans` (review checkpoints) or `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. **Task 1 is a DISCOVERY/SPIKE — do it first and record its findings into this file before any other task depends on them.** This document is the foundation spec's deferred **"Spec B."**

**Status:** ~~DRAFT — PRELIMINARY (gemini proxy)~~ → **RE-SPIKED against REAL `agy` v1.0.7 on 2026-06-11.** The proxy assumptions in §2 below are **superseded by the "REAL agy v1.0.7 spike" section immediately following.** Where the two conflict, the real-spike section wins.

**Date:** 2026-06-09 (re-spiked 2026-06-11)
**Phase:** Master roadmap Phase 3 (Antigravity half of "Spec B + Spec C").
**Branch:** `feat/phase-3-and-4d` (combined Phase 3 + 4D effort, off `feat/phase-4-enable-stubs` = `ccaa570` + handoff).

---

## REAL agy v1.0.7 spike (2026-06-11) — OVERRIDES the proxy §2 below

`agy` IS installed at `C:\Users\Koena\AppData\Local\agy\bin\agy.exe` (not on PATH). Findings from the real binary + its on-disk conversation store:

### Binary & flags (from `agy --help`)
- **Binary:** `agy.exe` v1.0.7 at `%LOCALAPPDATA%\agy\bin\agy.exe`. `resolveBinary()` must check that path in addition to `which agy`.
- **Model:** `--model <id>`.
- **Prompt:** `-i` / `--prompt-interactive <text>` (run prompt then stay interactive) — this is the streaming-friendly choice ⇒ `promptStrategy {kind:'flag'}`. Also `-p`/`--print`/`--prompt` for one-shot.
- **Autonomy:** `--dangerously-skip-permissions` (autonomous). Supervised ⇒ **no flag** (interactive approval prompts in-terminal). There is **no** `--yolo`/`--approval-mode`.
- **Resume:** `--conversation <ID>` (by id) or `-c`/`--continue` (most recent). There is **no** `--resume`/`--session-id`.
- **Workspace:** `--add-dir <path>` (repeatable). No `--include-directories`.
- **Sandbox:** `--sandbox` (boolean flag, terminal restrictions). `--log-file`, `--print-timeout` also exist.
- **Subcommands:** `models`, `install`, `plugin`/`plugins`, `update`, `changelog`, `help`.

### Storage & usage — NOT JSONL. Protobuf-in-SQLite.
- Conversations live at **`~/.gemini/antigravity-cli/conversations/<cascadeId>.db`** (SQLite). Auth/creds at `~/.gemini/oauth_creds.json` + `google_accounts.json` (OAuth seat — confirms `billingMode:'seat'`, no API key). `~/.gemini/tmp/*/chats` belongs to the *standalone* `gemini` CLI, **not** agy — do not read it.
- Each `.db` has tables `trajectory_meta, steps, gen_metadata, executor_metadata, parent_references, trajectory_metadata_blob, battle_mode_infos`. Payloads are **protobuf blobs** (no .proto shipped).
- **Token usage IS extractable** (decoded via generic protobuf wire-walk). Per **bot-response step**, `steps.metadata` (blob) field **9** is a `usageMetadata` sub-message; the same sub-message also appears at `gen_metadata.data` path `.1.4` (and dup `.1.17.2`). **Canonical source = `steps.metadata` field 9** (most complete — one record per model call; `gen_metadata` omits some calls).
  - **Field map (verified, consistent across all turns):**
    | proto field | meaning | → RawModelUsage |
    |---|---|---|
    | f2 | prompt tokens (non-cached input) | `inputTokens` |
    | f5 | cached content tokens (cache read; absent until caching activates) | `cacheReadTokens` |
    | f3 | candidates (output) | `outputTokens` (+ f9) |
    | f9 | thoughts (thinking) tokens | folded into `outputTokens` |
    | f10 | tool-use prompt tokens (small) | ignored |
    | f1, f6 | constants (1020/1050, 24) — **not tokens** | ignored |
  - **Aggregation = SUM per turn** (NOT max). The real proto separates non-cached (f2) from cached (f5) exactly like Claude's `input_tokens` vs `cache_read_input_tokens`, so `parseClaudeUsage`'s sum-per-message convention applies directly. **The proxy §2.4 "cumulative → take MAX" rule is WRONG for real agy — discard it.** `cacheCreationTokens = 0` (no separate count). `messageCount` = number of steps carrying a field-9 usage sub-message.
- **Model id:** `gen_metadata.data` path `.1.19` = e.g. `"gemini-3-flash-a"`, `.1.21` = `"Gemini 3.5 Flash (Medium)"`. agy can also route to Claude (a `used_claude` flag is present). Register **`gemini-3-flash`/`gemini-3-pro`** class entries (the proxy's `gemini-2.5-*` ids are stale). Per-model split: detect model(s) from `gen_metadata`; single model ⇒ one `byModel` row.

### Net effect on the plan below
- **Task 1 (spike): DONE** (this section). Fixture is a synthetic SQLite `.db` built with known field-9 usage blobs (deterministic expected math) — replaces the `.jsonl` fixture in §Task-1/Task-2.
- **Task 2 (`antigravity-transcript.ts` JSONL reader): REPLACED** by a SQLite+protobuf usage reader (`antigravity-usage.ts`): minimal varint/field-path protobuf decoder + `parseAntigravityDb(dbPath)`.
- **Task 4 parseUsage math:** sum f2/f5/(f3+f9) per step; not the cumulative-max rule.
- **Task 5 launch args:** use the REAL flags above (`--model`, `-i`, `--dangerously-skip-permissions`, `--conversation`/`-c`, `--add-dir`), not `--session-id`/`--yolo`/`--approval-mode`.
- Everything else (capabilities honest defaults, GEMINI.md prepareContext, registry/ingestion/settings wiring, seat=unpriced) stands.

---

## 0. Prerequisites (HARD — do not start without these)

This adapter slots into an abstraction that must already exist. Verify before Task 2:

1. **Phase 1 foundation complete** (`2026-06-06-agent-adapter-foundation.md` Tasks 2–10): `server/agents/agent-adapter.ts` (the `AgentAdapter` interface), `server/agents/claude-adapter.ts` (reference impl + structure to mirror), `server/agents/registry.ts` (`ADAPTERS` array + `makeRegistry`/`adapterForModel`/`buildCatalog`), `server/services/config-service.ts`, and the persisted `/api/config`.
2. **Phase 1 Delta A merged** — `RawUsage` carries `byModel: RawModelUsage[]` (locked contract; this adapter populates it).
3. **Phase 1 Delta B merged** — `AppConfig.providers` is an array of provider *records* (`{ id, enabled, billingMode, seatPriceUsdMonthly?, budget? }`), not a bare `enabledProviders: string[]`. This adapter's config row is `{ id:'antigravity', enabled, billingMode:'seat', seatPriceUsdMonthly? }`.
4. **Phase 1 Delta C merged** — `AgentAdapter` declares `readonly capabilities: AgentCapabilities` and `prepareContext(ctx: SpawnContext): void`; `AgentCatalogEntry` carries `capabilities`.
5. **Phase 0A registry exists** — `src/shared/agents/model-registry.ts` with `resolveModel()`, `ModelEntry` (`pricing` nullable, `quotaWeight`, `contextWindow`, `tier`, `provider`). This adapter **registers Gemini model entries here** (Task 3) and its `pricingFor`/`contextWindowFor` delegate to it.

> If any prerequisite is missing, STOP and report — this plan has nothing to attach to.

**Migrations:** **NONE.** Antigravity sessions reuse the existing `session_usage` table (migration `012`) and the existing `app_config` JSON blob (migration `015`, per Phase 1 Delta B). No schema change is introduced by this plan. Per-model rows (`byModel`) are a Phase 2 concern; this adapter produces `byModel` in memory and writes the same flat `session_usage` row shape the Claude ingester writes today, tagged with the provider.

---

## 1. Purpose & context

Add **Antigravity** — Google's headless agent CLI (`agy`, built on the Gemini CLI core) — as the second `AgentAdapter`, using a **subscription seat (OAuth personal), never an API key**. A goal whose model is `antigravity` (or a registered Gemini model) spawns `agy` instead of `claude`; its token usage flows into the same Phase 2 analytics under provider `'antigravity'`; the Settings "Agents" section shows it as a toggleable provider (default `billingMode:'seat'`) with the auth hint *"Run `agy` once to sign in."* No interface changes — this implements the exact same methods Claude does.

Per the foundation spec §2, the model value `'antigravity'` is a single provider-qualified entry because **headless `agy` locks the model** for a session; additional Gemini model entries (`gemini-3-pro`, `gemini-flash-2.5`) are registered for analytics/pricing attribution and forward use, but the live picker entry is `antigravity`.

### Locked decisions inherited (roadmap §2)
- **Seat, never metered for personal use** (Decision 6). `billingMode:'seat'` ⇒ pricing `null` ⇒ cost 0 + "unpriced/equivalent-value" badge downstream.
- **Per-model attribution** (Decision 4). `parseUsage` returns `byModel`.
- **Capability matrix is honest** (Decision 8). Antigravity declares `canObserveHooks:false` (until verified) so the UI degrades instead of lying.
- **Same markdown, different agents** (roadmap §Phase 3). `prepareContext` materializes `GEMINI.md` from the shared goal docs (Claude reads `CLAUDE.md`, Antigravity/Gemini reads `GEMINI.md`).

### Out of scope
- Codex adapter ("Spec C") — separate plan.
- Phase 2 per-model `session_model_usage` table / analytics UI — this adapter only *feeds* it.
- Orchestrator, approvals enforcement, workspace isolation.

---

## 2. CLI characterization (from the Task 1 spike — PRELIMINARY)

> **Spike caveat:** `agy` (the Antigravity headless CLI) is **NOT installed** on the dev machine. Antigravity ships Google's Gemini agent core, so the spike was run against the installed **`gemini` v0.44.1** CLI as the closest faithful proxy. Every flag and path below that is marked **[proxy]** must be re-verified against the real `agy --help` and `agy`'s transcript dir when the binary is available. Items marked **[assumed]** are inferences not directly observed.

### 2.1 Binary
- `resolveBinary()` → `agy` (resolved via `which agy` with the same `/c/` → `C:/` + `.exe` normalization the `ClaudeAdapter` uses). **[assumed]** `agy` is the headless entrypoint name (foundation spec §2 names it). If `agy` resolves to a launcher rather than a headless agent, fall back to documented headless invocation in the re-spike.

### 2.2 Launch flags **[proxy — observed on `gemini` v0.44.1]**
The Gemini CLI exposes flags that map almost 1:1 onto the `ClaudeAdapter` arg model:

| Need | Gemini flag (observed) | Claude equivalent |
|---|---|---|
| New session id | `--session-id <uuid>` | `--session-id` |
| Resume | `-r, --resume <id\|latest\|index>` | `--resume` |
| Model | `-m, --model <name>` | `--model` |
| Headless prompt | `-p, --prompt <text>` (prompt as a launch arg) | (Claude writes prompt to the PTY) |
| Auto-approve all | `-y, --yolo` or `--approval-mode yolo` | `--permission-mode bypassPermissions` |
| Read-only / plan | `--approval-mode plan` | (n/a) |
| Output format | `-o, --output-format text\|json\|stream-json` | (n/a; Claude is PTY text) |
| MCP servers | `gemini mcp add/list/...` subcommands **or** project `settings.json` | `--mcp-config <inline json>` |
| Workspace include | `--include-directories` | (cwd) |

**Decision — prompt strategy:** Gemini supports a **prompt-as-flag** headless mode (`-p/--prompt`). That maps to `promptStrategy = { kind: 'flag' }`: the initial prompt is passed in `buildStartArgs` rather than written to the PTY after an idle/regex settle. This is *simpler and more reliable* than Claude's idle/regex injection and is the recommended strategy. **[assumed for `agy`]** — confirm `agy` accepts a positional/`-p` prompt; if not, fall back to `{ kind: 'idle', idleMs: 5000 }`.

> **Tension to resolve in re-spike:** Claude-Deck drives an *interactive* PTY (it streams output, allows mid-session keystrokes). `-p` is one-shot headless. For a long-lived interactive agent session, the right invocation may be `-i/--prompt-interactive <text>` (execute prompt then continue interactive) rather than `-p`. **Recommended `buildStartArgs` uses `--prompt-interactive` so the session stays alive for streaming + follow-ups**, falling back to idle injection if `agy` lacks it. Mark which `agy` supports.

### 2.3 MCP wiring **[proxy]**
Gemini CLI does **not** accept an inline `--mcp-config` JSON like Claude. MCP servers are registered via `gemini mcp add <name> <command> [args...]` or a project/user `settings.json` `mcpServers` block. **Decision:** `buildStartArgs` does **not** carry MCP inline. Instead the adapter, in `prepareContext`, **stages a project-local `.gemini/settings.json`** (or runs `agy mcp add`) describing the `claude-deck` MCP server from the `McpServerDescriptor`. The `McpServerDescriptor.env` must carry `CLAUDE_DECK_URL` and `CLAUDE_DECK_GOAL_ID` (same as Claude — see foundation Task 9 delta). **[assumed for `agy`]** — confirm `agy` reads `.gemini/settings.json` or has an `mcp add`.
- **Capability gate:** if MCP cannot be confirmed working with `agy`, set `capabilities.canMcp = false` and skip staging — do not silently produce a broken config.

### 2.4 Transcript location & format **[observed on `gemini`; assumed same for `agy`]**
- **Location:** `~/.gemini/tmp/<projectKey>/chats/session-<UTC-timestamp>-<shortid>.jsonl` where `<projectKey>` is a short alias from `~/.gemini/projects.json` (absolute cwd → alias) **or** the SHA `projectHash` recorded in the transcript header. There is also an older `.json` (single-object) format for pre-existing sessions.
  - For `agy`, the dir is **[assumed]** `~/.antigravity/...` or still `~/.gemini/...`. The adapter exposes the base dir as a single overridable constant (`ANTIGRAVITY_HOME`) so the re-spike changes one line. Default to `~/.gemini/tmp` until verified.
- **Format (newer, `.jsonl`):** an **append-log**, one JSON object per line:
  - **Line 1 — session header:** `{ "sessionId": "<uuid>", "projectHash": "<sha>", "startTime": "<iso>", "lastUpdated": "<iso>", "kind": "main" }`.
  - **Message lines:** bare message objects, e.g. user → `{ id, timestamp, type:"user", content, displayContent }`; assistant → `{ id, timestamp, type:"gemini", content, thoughts, tokens, model, toolCalls? }`.
  - **`$set` bookkeeping lines:** `{ "$set": { "lastUpdated": "..." } }` (and an initial `{ "$set": { "messages": [...] } }` seed). These carry no usage and are skipped.
  - **The `tokens` object (load-bearing):** `{ "input": <int>, "output": <int>, "cached": <int>, "thoughts": <int>, "tool": <int>, "total": <int> }`. `model` is `"gemini-2.5-pro"` etc. (a single gemini turn may omit `model` on a final partial chunk).
  - **Format (older, `.json`):** a single object `{ sessionId, projectHash, startTime, lastUpdated, messages: [ ...same message shapes... ], kind }`. The parser must handle both.

**CRITICAL token semantics (observed, must be encoded in `parseUsage`):**
1. **`input`/`cached`/`total` are CUMULATIVE per turn** — each gemini turn's `input` already includes the full prior conversation context (observed growing 11918 → 12051 → 12164 → 13529 → 14428 across turns of one session). **Naive summing of `input` across turns drastically over-counts.**
2. **Token records are often DUPLICATED** — the streaming writer emits a partial then a final line with identical `tokens` (observed consecutive identical pairs). De-dup by message `id`.
3. **Therefore the parse rule is:**
   - De-duplicate gemini turns by `id` (keep the last write for an `id`).
   - **`output` (and `thoughts`) ARE per-turn deltas → SUM them across distinct turns.**
   - **`input`/`cached` are cumulative → take the MAX (last turn's value), not the sum**, as the session's input/context figure. (`total` likewise = last turn's value or `inputMax + outputSum`.)
   - `messageCount` = number of distinct gemini turns.
   - `model` = the `model` of the distinct turns (group `byModel`).

   This is **different from Claude**, where `usage.input_tokens` is a per-message delta and everything sums. Encode it explicitly and test it (Task 4).

### 2.5 Auth **[observed]**
- `~/.gemini/settings.json` → `{ "security": { "auth": { "selectedType": "oauth-personal" } } }`. Credentials at `~/.gemini/oauth_creds.json` (`access_token`, `refresh_token`, `expiry_date`, …). **This is a subscription OAuth seat — no API key anywhere.** Confirms `billingMode:'seat'`.
- **Auth UX:** `authHint = "Run \`agy\` once to sign in"`. The adapter does **not** manage tokens; it only detects presence (e.g. `~/.gemini/oauth_creds.json` exists) for a Settings status dot **[optional, nice-to-have]**.

### 2.6 Hooks **[observed on `gemini`, but NOT trusted for `agy`]**
- The `gemini` CLI *does* have a hooks subsystem (`gemini hooks migrate` imports Claude hooks). **However**, the foundation spec and roadmap explicitly assume Antigravity lacks Claude-style observable hooks, and `agy`'s headless behavior is unverified. **Decision (honest-degradation, per locked contract):** `capabilities.canObserveHooks = false`. `installHooks()`/`uninstallHooks()` are **no-ops that log a warning**; `hooksInstalled()` returns `false`. This is declared honestly in the capability matrix so the UI greys out hook affordances. If a later spike proves `agy` hooks can POST events to claude-deck, flip the capability and implement — but **do not** wire half-working hooks now.

### 2.7 Context file mapping **[observed convention]**
- Gemini/Antigravity reads **`GEMINI.md`** as its native context file (analogous to `CLAUDE.md`). `prepareContext(ctx)` writes/refreshes a `GEMINI.md` in `ctx.cwd` assembled from the **same shared goal docs** Claude uses (plan/research/notes/handoff/todo set), so identical markdown drives either agent. **[assumed]** the shared-doc source path — reuse whatever helper the ClaudeAdapter/PtyManager uses to locate goal docs; if none is extracted yet, read them from the goal's doc directory convention used elsewhere in the repo. If `GEMINI.md` already exists and is user-authored, **append a managed block** delimited by markers rather than overwriting.

### 2.8 Capability matrix (declared)
```ts
capabilities: {
  canObserveHooks: false,   // §2.6 — honest until agy hooks verified
  canResume: true,          // §2.2 — agy --resume [assumed from gemini -r]
  canMcp: false,            // §2.3 — flip to true only once agy MCP staging is verified working
  canApprove: false,        // no Claude-style approval interception; agy uses --approval-mode/--yolo at launch
  canStream: true,          // PTY streams text output
}
```
> `canApprove:false` and `canMcp:false` are the conservative, honest defaults. They are the *correct* values to ship until the real `agy` is exercised; raising them is a follow-up, lowering Claude's is never needed.

---

## 3. Capabilities & method map (the contract this implements)

`AntigravityAdapter implements AgentAdapter` — every method, no interface change:

| Method | Behavior |
|---|---|
| `id` | `'antigravity'` |
| `label` | `'Antigravity'` |
| `models` | `[{ value:'antigravity', label:'Antigravity (Gemini)' }]` — single entry (headless `agy` locks the model). |
| `capabilities` | matrix in §2.8. |
| `authHint` | `'Run \`agy\` once to sign in'` |
| `resolveBinary()` | cached `which agy` with win32 normalization; fallback `'agy'`/`'agy.exe'`. |
| `buildStartArgs(ctx)` | `['--session-id', ctx.goalId, '--model', <gemini model>, '--prompt-interactive', '<deferred>'?, ...approvalFlag(ctx)]`. Approval: `autonomous` → `--yolo`; `supervised` → `--approval-mode default`. (No inline MCP — staged in `prepareContext`.) See §2.2 prompt tension. |
| `buildResumeArgs(sessionId, ctx)` | `['--resume', sessionId, ...approvalFlag(ctx)]`. |
| `promptStrategy` | `{ kind: 'flag' }` (prompt passed at launch) — fallback `{ kind:'idle', idleMs:5000 }`. |
| `prepareContext(ctx)` | (a) write/refresh `GEMINI.md` in `ctx.cwd` from shared goal docs; (b) if `canMcp`, stage `.gemini/settings.json` MCP block from `ctx.mcpServer`. Returns `void`. |
| `installHooks()` | no-op + warn (`canObserveHooks:false`). |
| `uninstallHooks()` | no-op + warn. |
| `hooksInstalled()` | `false`. |
| `locateSessionLog(sessionId)` | scan `~/.gemini/tmp/*/chats/` for a `session-*.jsonl`/`.json` whose header `sessionId` (or filename shortid) matches; return path or `null`. |
| `parseUsage(logPath)` | parse per §2.4 rules → `RawUsage` with `byModel`. |
| `listSessionLogs(sinceMs)` | enumerate `~/.gemini/tmp/*/chats/*.{jsonl,json}` filtered by mtime window. |
| `pricingFor(model)` | `resolveModel(model)?.pricing` from the registry; `null` (seat) → zeroed `ModelPricing` (cost 0, unpriced). |
| `contextWindowFor(model, currentTokens)` | `resolveModel(model)?.contextWindow ?? 1_000_000` (Gemini default ~1M), overridden to larger if `currentTokens` exceeds it. |

---

## 4. Model registry entries (Phase 0A — `src/shared/agents/model-registry.ts`)

Add three entries (pricing `null` = seat; **no public per-token rate is claimed** for personal subscription use, per Decision 6):

```ts
// gemini-3-pro — frontier
{ id: 'gemini-3-pro', match: (r) => /gemini-3.*pro|gemini-2\.5-pro/i.test(r),
  label: 'Gemini 3 Pro', provider: 'antigravity', tier: 'frontier',
  pricing: null, quotaWeight: 1.0, contextWindow: 1_000_000 },

// gemini-flash-2.5 — fast
{ id: 'gemini-flash-2.5', match: (r) => /gemini.*flash/i.test(r),
  label: 'Gemini 2.5 Flash', provider: 'antigravity', tier: 'fast',
  pricing: null, quotaWeight: 0.25, contextWindow: 1_000_000 },

// antigravity — the headless picker entry; resolves to whatever model agy locks (currently gemini-pro-class)
{ id: 'antigravity', match: (r) => /antigravity/i.test(r),
  label: 'Antigravity', provider: 'antigravity', tier: 'frontier',
  pricing: null, quotaWeight: 1.0, contextWindow: 1_000_000 },
```
- `match` is substring/regex over the transcript `model` string (observed `gemini-2.5-pro`; the `gemini-3-pro` entry also matches `gemini-2.5-pro` until the registry gains a dedicated 2.5-pro entry — acceptable, both are frontier; refine when 3-pro transcripts appear).
- `quotaWeight` is relative to the provider's lightest model (Flash = 0.25 of a Pro unit) for Phase 2 window-utilization. **[assumed ratio]** — refine against Google's published quota docs.
- `pricing: null` is handled explicitly downstream: cost 0, "unpriced" badge, never coerced to Opus.

> **If a public Gemini API rate is ever justified** (e.g. work profile runs Gemini metered via Vertex), add a non-null `pricing` here and set that provider record's `billingMode:'metered'` — the math stays the same, only the label flips. Not done now.

---

## 5. Ingestion wiring (Phase 2 analytics, provider `'antigravity'`)

`ingestion-service.ts` currently has `ingestAllSessions(db, projectsDir)` scanning the Claude flat layout and writing `session_usage` rows. Antigravity's layout differs (`tmp/<key>/chats/*.jsonl`, cumulative tokens). **Reuse the same table; add a provider-aware ingest path that delegates to the adapter** so the parse rules live in ONE place (the adapter), not duplicated in the ingester.

- New `ingestAntigravitySessions(db, adapter)`:
  - `for (const logPath of adapter.listSessionLogs(0))`: `const u = adapter.parseUsage(logPath)`; skip if `u.messageCount === 0`.
  - Derive `sessionId` from the transcript header; `model = u.model`; cost via `adapter.pricingFor(model)` (0 for seat).
  - `project_dir` = `'antigravity:' + <projectKey>` (namespaced so analytics can group by provider and Antigravity rows never collide with Claude session ids).
  - Upsert into `session_usage` using the SAME statement shape the Claude ingester uses (skip-if-not-grown guard on `message_count`).
  - For `byModel` (multi-model sessions), Phase 2 will split into per-model rows; **for now write the rolled-up row** (totals), matching today's one-row-per-session contract. `byModel` is produced and available but persisted flat until the Phase 2 child table exists.
- Wire in `server/index.ts` alongside the existing ingestion: call `ingestAntigravitySessions` in the initial run and the 5-min interval, **gated on the `antigravity` provider being enabled** (`configService.getPersisted().providers.find(p=>p.id==='antigravity')?.enabled`). Disabled ⇒ skip (no scan, no rows).

Result: enabling Antigravity in Settings makes its sessions appear in `/api/analytics/*` under provider `antigravity`, cost 0 + unpriced badge (seat), tokens intact.

---

## 6. Settings visibility

- The adapter is added to `server/agents/registry.ts` `ADAPTERS`. `buildCatalog(enabled)` therefore includes an `antigravity` entry with `capabilities` and `authHint`.
- **Visible only when enabled:** the catalog always lists it (so it can be toggled), but its model option (`antigravity`) appears in pickers only when `providers.find(id==='antigravity').enabled` (the existing `enabledModelOptions` union already does this).
- Default provider record on first run: **not present** ⇒ Antigravity off by default. When the user toggles it on, `config-service.normalizeProviders` adds `{ id:'antigravity', enabled:true, billingMode:'seat' }`. The Settings "Agents" row shows the `authHint` when enabled and greys out hook/approval/MCP affordances per `capabilities` (Phase 4 UI; the data is already exposed here).

---

# Implementation Plan (bite-sized, TDD)

**TDD rhythm (every task):** write failing test → run it, confirm it fails for the expected reason → write minimal REAL code → run it green → `npm run typecheck` clean → commit. Tests live in `tests/server/**` (node env) and `tests/shared/**`. `parseUsage` tests use the **recorded fixture** (Task 2), never the live CLI.

---

## Task 1: DISCOVERY / SPIKE — characterize `agy`, record findings (DONE for proxy; re-verify on real `agy`)

**Goal:** Replace every `[assumed]`/`[proxy]` marker in §2 with verified `agy` facts. The §2 "CLI characterization" above is the **output of this task run against `gemini` v0.44.1** (the only available proxy). This step formalizes what to re-check and commits the captured fixture.

**Files:**
- Create (fixture): `tests/fixtures/usage/antigravity-session.jsonl`
- Modify (findings): this plan's §2 (append a "Re-spike delta" subsection if `agy` differs)

- [ ] **Step 1: If `agy` is installed, run the real spike** (else record "agy not present; proxy = gemini vX" and proceed with §2 marked PRELIMINARY):
  - `agy --help` → confirm/correct the flag table (§2.2). Capture verbatim into §2.
  - `agy --version`.
  - Locate the transcript dir: run a throwaway `agy` session in a temp cwd, then find the newest file under `~/.antigravity` / `~/.gemini` / `$XDG_*`. Record the exact glob in §2.4 and set `ANTIGRAVITY_HOME`.
  - Confirm token-object keys and **cumulative vs delta** semantics (§2.4 CRITICAL) on a ≥3-turn session. This is the single most important finding — a wrong assumption here corrupts every cost number.
  - Confirm prompt mode: does `agy` accept `-p`/`--prompt-interactive`/positional? (sets `promptStrategy`).
  - Confirm MCP mechanism (`agy mcp add` / `.gemini/settings.json`) and whether it works headless (sets `canMcp`).
  - Confirm auth is OAuth-seat (no API key path) and the creds file location.
  - Confirm the native context filename (`GEMINI.md`?).

- [ ] **Step 2: Write the parseUsage fixture** `tests/fixtures/usage/antigravity-session.jsonl` — a **small, sanitized, synthetic** transcript matching the observed shape (do NOT copy real user content). Use these exact records so Task 4's expected math is fixed:
```jsonl
{"sessionId":"aaaaaaaa-1111-2222-3333-444444444444","projectHash":"deadbeef","startTime":"2026-06-09T17:49:42.902Z","lastUpdated":"2026-06-09T17:50:50.000Z","kind":"main"}
{"$set":{"messages":[],"lastUpdated":"2026-06-09T17:49:42.904Z"}}
{"id":"m-user-1","timestamp":"2026-06-09T17:49:42.904Z","type":"user","content":[{"text":"hello"}]}
{"id":"m-gem-1","timestamp":"2026-06-09T17:50:00.000Z","type":"gemini","content":"hi","thoughts":"…","tokens":{"input":11918,"output":52,"cached":3178,"thoughts":96,"tool":0,"total":12066},"model":"gemini-2.5-pro"}
{"id":"m-gem-1","timestamp":"2026-06-09T17:50:00.500Z","type":"gemini","content":"hi","thoughts":"…","tokens":{"input":11918,"output":52,"cached":3178,"thoughts":96,"tool":0,"total":12066},"model":"gemini-2.5-pro"}
{"$set":{"lastUpdated":"2026-06-09T17:50:01.000Z"}}
{"id":"m-gem-2","timestamp":"2026-06-09T17:50:40.000Z","type":"gemini","content":"more","thoughts":"…","tokens":{"input":12164,"output":661,"cached":10678,"thoughts":22,"tool":0,"total":12847},"model":"gemini-2.5-pro"}
{"$set":{"lastUpdated":"2026-06-09T17:50:50.000Z"}}
```
  - **Expected parse (encodes the §2.4 rules):** 2 distinct gemini turns (`m-gem-1` deduped, `m-gem-2`); `outputTokens = 52 + 661 = 713`; `cacheCreationTokens`/thoughts handling per Task 4; `inputTokens = max(11918, 12164) = 12164` (cumulative → last); `cacheReadTokens = max(3178, 10678) = 10678` (cumulative); `messageCount = 2`; `model = 'gemini-2.5-pro'`; `byModel` has one entry.

- [ ] **Step 3: Commit the spike record + fixture.**
```bash
git add docs/superpowers/plans/2026-06-09-antigravity-adapter.md tests/fixtures/usage/antigravity-session.jsonl
git commit -m "spike: characterize agy/gemini CLI + record antigravity transcript fixture"
```

> **Findings already recorded (proxy run, 2026-06-09):** `agy` not installed → spiked `gemini` v0.44.1. Flags, transcript path (`~/.gemini/tmp/<key>/chats/session-*.jsonl`), append-log JSONL with `type:"gemini"` token records `{input,output,cached,thoughts,tool,total}`, **cumulative input/cached + duplicated turn writes**, OAuth-personal seat auth, `GEMINI.md` context convention — all captured in §2. The cumulative-token rule (§2.4) and prompt-mode tension (§2.2) are the two items most likely to need correction on the real `agy`.

---

## Task 2: Map types for the Antigravity transcript shape

**Goal:** A typed model of the discovered transcript so `parseUsage` is not stringly-typed.

**Files:**
- Create: `server/agents/antigravity-transcript.ts`
- Test: `tests/server/agents/antigravity-transcript.test.ts`

- [ ] **Step 1: Write failing test** asserting `readTranscript(fixturePath)` yields the header + distinct deduped gemini turns:
```ts
// tests/server/agents/antigravity-transcript.test.ts
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readTranscript } from '../../../server/agents/antigravity-transcript';

const fixture = path.resolve(__dirname, '../../fixtures/usage/antigravity-session.jsonl');

describe('antigravity transcript reader', () => {
  it('parses header + dedupes gemini turns by id', () => {
    const t = readTranscript(fixture);
    expect(t.sessionId).toBe('aaaaaaaa-1111-2222-3333-444444444444');
    expect(t.geminiTurns.map((g) => g.id)).toEqual(['m-gem-1', 'm-gem-2']);
    expect(t.geminiTurns[0].tokens.input).toBe(11918);
    expect(t.geminiTurns[1].model).toBe('gemini-2.5-pro');
  });
});
```

- [ ] **Step 2:** Run → FAIL (module missing).

- [ ] **Step 3: Write `server/agents/antigravity-transcript.ts`.**
```ts
import { readFileSync } from 'node:fs';

export interface GeminiTokens {
  input: number; output: number; cached: number;
  thoughts: number; tool: number; total: number;
}
export interface GeminiTurn {
  id: string; timestamp: string; model: string | null; tokens: GeminiTokens;
}
export interface AntigravityTranscript {
  sessionId: string | null;
  startTime: string | null;
  geminiTurns: GeminiTurn[]; // deduped by id, in first-seen order, last write wins
}

const EMPTY_TOKENS: GeminiTokens = { input: 0, output: 0, cached: 0, thoughts: 0, tool: 0, total: 0 };

/** Reads a Gemini/Antigravity transcript (.jsonl append-log or legacy .json single-object). */
export function readTranscript(filePath: string): AntigravityTranscript {
  let content: string;
  try { content = readFileSync(filePath, 'utf-8'); } catch {
    return { sessionId: null, startTime: null, geminiTurns: [] };
  }

  // Legacy single-object .json: one parse, messages[] inside.
  const trimmed = content.trimStart();
  if (filePath.endsWith('.json') || (trimmed.startsWith('{') && !trimmed.includes('\n{'))) {
    try {
      const obj = JSON.parse(content);
      if (obj && Array.isArray(obj.messages)) {
        return collect(obj.sessionId ?? null, obj.startTime ?? null, obj.messages);
      }
    } catch { /* fall through to line mode */ }
  }

  let sessionId: string | null = null;
  let startTime: string | null = null;
  const lineMessages: unknown[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj && typeof obj === 'object') {
      if (obj.sessionId && obj.startTime) { sessionId = obj.sessionId; startTime = obj.startTime; continue; }
      if (obj.$set) {
        if (Array.isArray(obj.$set.messages)) lineMessages.push(...obj.$set.messages);
        continue; // bookkeeping otherwise
      }
      if (obj.type) lineMessages.push(obj);
    }
  }
  return collect(sessionId, startTime, lineMessages);
}

function collect(sessionId: string | null, startTime: string | null, messages: unknown[]): AntigravityTranscript {
  const byId = new Map<string, GeminiTurn>();
  const order: string[] = [];
  for (const m of messages as any[]) {
    if (!m || m.type !== 'gemini' || !m.tokens) continue;
    const id: string = m.id ?? `${order.length}`;
    if (!byId.has(id)) order.push(id);
    byId.set(id, {
      id,
      timestamp: m.timestamp ?? '',
      model: typeof m.model === 'string' ? m.model : null,
      tokens: { ...EMPTY_TOKENS, ...(m.tokens as Partial<GeminiTokens>) },
    });
  }
  return { sessionId, startTime, geminiTurns: order.map((id) => byId.get(id)!) };
}
```

- [ ] **Step 4:** Run test → PASS. `npm run typecheck` → clean.

- [ ] **Step 5: Commit.**
```bash
git add server/agents/antigravity-transcript.ts tests/server/agents/antigravity-transcript.test.ts
git commit -m "feat: antigravity transcript reader (.jsonl append-log + legacy .json)"
```

---

## Task 3: Register Gemini models in the Phase 0A model registry

**Files:**
- Modify: `src/shared/agents/model-registry.ts` (append entries from §4)
- Test: `tests/shared/agents/model-registry.test.ts` (append cases)

- [ ] **Step 1: Write failing test** (append):
```ts
import { resolveModel } from '../../../src/shared/agents/model-registry';

describe('gemini/antigravity registry entries', () => {
  it('resolves a gemini pro transcript string to a seat (null pricing) frontier model', () => {
    const e = resolveModel('gemini-2.5-pro');
    expect(e?.provider).toBe('antigravity');
    expect(e?.tier).toBe('frontier');
    expect(e?.pricing).toBeNull();        // seat — no metered rate
    expect(e?.contextWindow).toBe(1_000_000);
  });
  it('resolves the flash model with a lighter quota weight', () => {
    const e = resolveModel('gemini-2.5-flash');
    expect(e?.id).toBe('gemini-flash-2.5');
    expect(e?.quotaWeight).toBeLessThan(1);
  });
  it("resolves the 'antigravity' picker value", () => {
    expect(resolveModel('antigravity')?.provider).toBe('antigravity');
  });
});
```

- [ ] **Step 2:** Run → FAIL (entries absent).

- [ ] **Step 3: Append the three entries from §4** to `MODEL_REGISTRY` in `src/shared/agents/model-registry.ts`. **Order matters:** put the more specific `flash` matcher before the broad `gemini-3-pro` matcher so flash isn't swallowed by the pro regex (or make the pro matcher exclude `flash`). Keep `resolveModel` returning the FIRST match.

- [ ] **Step 4:** Run test → PASS. Re-run the existing registry tests (`resolveModel('claude-opus-4-8')` etc.) → still green (Claude entries untouched). `npm run typecheck` → clean.

- [ ] **Step 5: Commit.**
```bash
git add src/shared/agents/model-registry.ts tests/shared/agents/model-registry.test.ts
git commit -m "feat: register gemini-3-pro/gemini-flash-2.5/antigravity (seat, null pricing) in model registry"
```

---

## Task 4: AntigravityAdapter — usage parsing (`parseUsage` → `RawUsage.byModel`)

The load-bearing task: encode the §2.4 cumulative/dedup rules and the `byModel` contract.

**Files:**
- Create: `server/agents/antigravity-adapter.ts` (usage methods first; launch methods in Task 5)
- Test: `tests/server/agents/antigravity-adapter-usage.test.ts`

- [ ] **Step 1: Write failing test** against the fixture (expected math from Task 1 Step 2):
```ts
// tests/server/agents/antigravity-adapter-usage.test.ts
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { AntigravityAdapter } from '../../../server/agents/antigravity-adapter';

const fixture = path.resolve(__dirname, '../../fixtures/usage/antigravity-session.jsonl');
const a = new AntigravityAdapter();

describe('AntigravityAdapter.parseUsage (cumulative-token rules)', () => {
  it('sums output, takes max of cumulative input/cache, dedupes by id', () => {
    const u = a.parseUsage(fixture);
    expect(u.messageCount).toBe(2);
    expect(u.outputTokens).toBe(713);          // 52 + 661 (deltas summed)
    expect(u.inputTokens).toBe(12164);         // max(11918, 12164) — cumulative
    expect(u.cacheReadTokens).toBe(10678);     // max(3178, 10678) — cumulative
    expect(u.model).toBe('gemini-2.5-pro');
  });
  it('populates byModel with one entry mirroring totals', () => {
    const u = a.parseUsage(fixture);
    expect(u.byModel).toHaveLength(1);
    expect(u.byModel[0].model).toBe('gemini-2.5-pro');
    expect(u.byModel[0].outputTokens).toBe(713);
    expect(u.byModel[0].inputTokens).toBe(12164);
  });
  it('returns zeroed usage for a missing file', () => {
    const u = a.parseUsage('/no/such/file.jsonl');
    expect(u.messageCount).toBe(0);
    expect(u.byModel).toEqual([]);
  });
  it('pricingFor a seat model is zeroed (unpriced)', () => {
    const p = a.pricingFor('gemini-2.5-pro');
    expect(p).toEqual({ input: 0, cache_read: 0, cache_creation: 0, output: 0 });
  });
  it('contextWindowFor returns ~1M for gemini', () => {
    expect(a.contextWindowFor('gemini-2.5-pro', 0)).toBe(1_000_000);
  });
});
```

- [ ] **Step 2:** Run → FAIL (module missing).

- [ ] **Step 3: Write the usage half of `server/agents/antigravity-adapter.ts`.** (Launch/hook/context methods are stubbed here and filled in Task 5 — or write the full class now and leave Task 5 to test launch args; either order works, but keep one file.)
```ts
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentAdapter, PromptStrategy, AgentCapabilities } from './agent-adapter';
import type {
  ModelOption, SpawnContext, RawUsage, RawModelUsage, ModelPricing,
} from '../../src/shared/agents/types';
import { resolveModel } from '../../src/shared/agents/model-registry';
import { readTranscript, type GeminiTurn } from './antigravity-transcript';
import logger from '../logger';

const ZERO_PRICING: ModelPricing = { input: 0, cache_read: 0, cache_creation: 0, output: 0 };

/** Overridable in the re-spike if `agy` uses a different home (e.g. ~/.antigravity). */
const ANTIGRAVITY_HOME = process.env['ANTIGRAVITY_HOME'] ?? join(homedir(), '.gemini', 'tmp');

let cachedBinary: string | null = null;

function emptyRawUsage(): RawUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, messageCount: 0, model: null, byModel: [] };
}

/** Aggregate distinct gemini turns into per-model usage using §2.4 cumulative rules. */
function aggregate(turns: GeminiTurn[]): RawUsage {
  const out = emptyRawUsage();
  if (turns.length === 0) return out;
  const groups = new Map<string | null, GeminiTurn[]>();
  for (const t of turns) {
    const k = t.model;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(t);
  }
  for (const [model, group] of groups) {
    const row: RawModelUsage = { model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, messageCount: group.length };
    let maxInput = 0, maxCached = 0;
    for (const t of group) {
      row.outputTokens += t.tokens.output;            // delta → sum
      // 'thoughts' folded into output-equivalent? keep separate from cost; not summed into input.
      maxInput = Math.max(maxInput, t.tokens.input);   // cumulative → max
      maxCached = Math.max(maxCached, t.tokens.cached);
    }
    row.inputTokens = maxInput;
    row.cacheReadTokens = maxCached;
    row.cacheCreationTokens = 0; // gemini transcript has no separate cache-creation count
    out.byModel.push(row);
    out.inputTokens += row.inputTokens;
    out.outputTokens += row.outputTokens;
    out.cacheReadTokens += row.cacheReadTokens;
    out.messageCount += row.messageCount;
  }
  // session-level model = the dominant (most turns) model
  out.model = out.byModel.reduce((a, b) => (b.messageCount > (a?.messageCount ?? -1) ? b : a)).model;
  return out;
}

export class AntigravityAdapter implements AgentAdapter {
  readonly id = 'antigravity';
  readonly label = 'Antigravity';
  readonly models: ModelOption[] = [{ value: 'antigravity', label: 'Antigravity (Gemini)' }];
  readonly authHint = 'Run `agy` once to sign in';
  readonly promptStrategy: PromptStrategy = { kind: 'flag' };
  readonly capabilities: AgentCapabilities = {
    canObserveHooks: false, canResume: true, canMcp: false, canApprove: false, canStream: true,
  };

  resolveBinary(): string {
    if (cachedBinary) return cachedBinary;
    try {
      let p = execSync('which agy', { encoding: 'utf-8' }).trim();
      if (p.startsWith('/c/')) p = 'C:/' + p.slice(3);
      if (process.platform === 'win32' && !p.endsWith('.exe')) p += '.exe';
      cachedBinary = p;
    } catch {
      cachedBinary = process.platform === 'win32' ? 'agy.exe' : 'agy';
    }
    return cachedBinary;
  }

  // ── usage ──
  parseUsage(logPath: string): RawUsage {
    return aggregate(readTranscript(logPath).geminiTurns);
  }

  listSessionLogs(sinceMs: number): string[] {
    if (!existsSync(ANTIGRAVITY_HOME)) return [];
    const cutoff = sinceMs > 0 ? Date.now() - sinceMs : 0;
    const paths: string[] = [];
    let projects: string[]; try { projects = readdirSync(ANTIGRAVITY_HOME); } catch { return []; }
    for (const proj of projects) {
      const chats = join(ANTIGRAVITY_HOME, proj, 'chats');
      let entries: string[]; try { entries = readdirSync(chats); } catch { continue; }
      for (const e of entries) {
        if (!e.endsWith('.jsonl') && !e.endsWith('.json')) continue;
        const fp = join(chats, e);
        try { if (cutoff > 0 && statSync(fp).mtimeMs < cutoff) continue; } catch { continue; }
        paths.push(fp);
      }
    }
    return paths;
  }

  locateSessionLog(sessionId: string): string | null {
    for (const fp of this.listSessionLogs(0)) {
      // shortid in filename or full id in header
      if (fp.includes(sessionId)) return fp;
      try { if (readTranscript(fp).sessionId === sessionId) return fp; } catch { /* skip */ }
    }
    return null;
  }

  pricingFor(model: string): ModelPricing {
    return resolveModel(model)?.pricing ?? ZERO_PRICING; // seat → zeroed (unpriced)
  }

  contextWindowFor(model: string, currentTokens: number): number {
    const w = resolveModel(model)?.contextWindow ?? 1_000_000;
    return currentTokens > w ? w * 2 : w;
  }

  // ── launch / hooks / context: Task 5 ──
  buildStartArgs(_ctx: SpawnContext): string[] { throw new Error('Task 5'); }
  buildResumeArgs(_sessionId: string, _ctx: SpawnContext): string[] { throw new Error('Task 5'); }
  prepareContext(_ctx: SpawnContext): void { throw new Error('Task 5'); }
  async installHooks(): Promise<void> { logger.warn('AntigravityAdapter: hooks unsupported (canObserveHooks=false)'); }
  async uninstallHooks(): Promise<void> { /* no-op */ }
  async hooksInstalled(): Promise<boolean> { return false; }
}
```
> Note: `thoughts` and `tool` tokens are intentionally NOT folded into `inputTokens`/`outputTokens` (they're informational and seat-priced at 0 anyway). If Phase 2 wants them, extend `RawModelUsage` — not this task.

- [ ] **Step 4:** Run test → PASS. `npm run typecheck` → clean. (`buildStartArgs` etc. throw, but no test calls them yet.)

- [ ] **Step 5: Commit.**
```bash
git add server/agents/antigravity-adapter.ts tests/server/agents/antigravity-adapter-usage.test.ts
git commit -m "feat: AntigravityAdapter usage parsing (cumulative tokens → RawUsage.byModel, seat pricing)"
```

---

## Task 5: AntigravityAdapter — launch args, capabilities, prepareContext

**Files:**
- Modify: `server/agents/antigravity-adapter.ts` (fill the launch/context methods)
- Test: `tests/server/agents/antigravity-adapter-launch.test.ts`

- [ ] **Step 1: Write failing test.**
```ts
// tests/server/agents/antigravity-adapter-launch.test.ts
import { describe, it, expect } from 'vitest';
import { AntigravityAdapter } from '../../../server/agents/antigravity-adapter';
import type { SpawnContext } from '../../../src/shared/agents/types';

const a = new AntigravityAdapter();
const base: SpawnContext = { goalId: 'goal-1', model: 'antigravity', cwd: '/repo', permissionMode: 'supervised', mcpServer: null };

describe('AntigravityAdapter launch', () => {
  it('start: session id + default approval for supervised', () => {
    expect(a.buildStartArgs(base)).toEqual(['--session-id', 'goal-1', '--approval-mode', 'default']);
  });
  it('start: yolo for autonomous', () => {
    expect(a.buildStartArgs({ ...base, permissionMode: 'autonomous' }))
      .toEqual(['--session-id', 'goal-1', '--yolo']);
  });
  it('resume: --resume first', () => {
    expect(a.buildResumeArgs('sess-9', base)).toEqual(['--resume', 'sess-9', '--approval-mode', 'default']);
  });
  it('declares honest capabilities', () => {
    expect(a.capabilities.canObserveHooks).toBe(false);
    expect(a.capabilities.canApprove).toBe(false);
    expect(a.capabilities.canMcp).toBe(false);
    expect(a.capabilities.canResume).toBe(true);
    expect(a.capabilities.canStream).toBe(true);
  });
  it('hooks are no-ops', async () => {
    await expect(a.installHooks()).resolves.toBeUndefined();
    expect(await a.hooksInstalled()).toBe(false);
  });
});
```

- [ ] **Step 2:** Run → FAIL (methods throw).

- [ ] **Step 3: Implement the launch/context methods** in `antigravity-adapter.ts`:
```ts
private approvalArgs(ctx: SpawnContext): string[] {
  return ctx.permissionMode === 'autonomous' ? ['--yolo'] : ['--approval-mode', 'default'];
}

buildStartArgs(ctx: SpawnContext): string[] {
  // model is locked by headless agy; pass --model only if the registry maps to a concrete gemini id.
  return ['--session-id', ctx.goalId, ...this.approvalArgs(ctx)];
  // NOTE (Task 1 tension): if agy needs the prompt at launch, append ['--prompt-interactive', ctx.<prompt>]
  // once SpawnContext carries the initial prompt, or rely on promptStrategy='flag' wiring in PtyManager.
}

buildResumeArgs(sessionId: string, ctx: SpawnContext): string[] {
  return ['--resume', sessionId, ...this.approvalArgs(ctx)];
}

prepareContext(ctx: SpawnContext): void {
  // 1) Materialize GEMINI.md from the shared goal docs (same markdown that drives CLAUDE.md).
  try {
    writeGeminiContext(ctx.cwd, ctx.goalId); // helper below; reuse the repo's goal-doc locator
  } catch (err) { logger.warn({ err, goalId: ctx.goalId }, 'AntigravityAdapter: GEMINI.md prepare failed'); }
  // 2) MCP staging is skipped while canMcp=false. When verified, stage .gemini/settings.json from ctx.mcpServer.
}
```
  - Add a small `writeGeminiContext(cwd, goalId)` helper (new `server/agents/gemini-context.ts`, or inline) that reads the shared goal docs the ClaudeAdapter/PtyManager already use and writes/refreshes a managed block in `<cwd>/GEMINI.md`. **If the foundation has not extracted a shared goal-doc locator, do the minimal thing:** write a `GEMINI.md` that `@`-imports / references the same files `CLAUDE.md` would (so content lives in one place), delimited by `<!-- claude-deck:managed -->` markers; never clobber a user-authored `GEMINI.md` outside those markers.

- [ ] **Step 4:** Run test → PASS. `npm run typecheck` → clean. (`prepareContext` GEMINI.md write is covered by a thin test only if a goal-doc fixture exists; otherwise assert it doesn't throw on a temp cwd.)

- [ ] **Step 5: Commit.**
```bash
git add server/agents/antigravity-adapter.ts server/agents/gemini-context.ts tests/server/agents/antigravity-adapter-launch.test.ts
git commit -m "feat: AntigravityAdapter launch args + capabilities + GEMINI.md prepareContext"
```

---

## Task 6: Register the adapter + catalog visibility

**Files:**
- Modify: `server/agents/registry.ts` (`ADAPTERS` / default registry)
- Test: `tests/server/agents/registry-antigravity.test.ts`

- [ ] **Step 1: Write failing test.**
```ts
// tests/server/agents/registry-antigravity.test.ts
import { describe, it, expect } from 'vitest';
import { makeRegistry, buildCatalog } from '../../../server/agents/registry';
import { ClaudeAdapter } from '../../../server/agents/claude-adapter';
import { AntigravityAdapter } from '../../../server/agents/antigravity-adapter';

describe('registry with antigravity', () => {
  const reg = makeRegistry([new ClaudeAdapter(), new AntigravityAdapter()]);
  it('resolves antigravity model when enabled', () => {
    expect(reg.adapterForModel('antigravity', ['claude', 'antigravity']).id).toBe('antigravity');
  });
  it('falls back to claude when antigravity is disabled', () => {
    expect(reg.adapterForModel('antigravity', ['claude']).id).toBe('claude');
  });
  it('catalog carries capabilities + authHint', () => {
    const cat = reg.buildCatalog(['claude', 'antigravity']);
    const ag = cat.find((c) => c.id === 'antigravity')!;
    expect(ag.enabled).toBe(true);
    expect(ag.authHint).toMatch(/agy/);
    expect(ag.capabilities.canObserveHooks).toBe(false);
  });
  it('default production registry now includes antigravity (disabled by default)', () => {
    expect(buildCatalog(['claude']).some((c) => c.id === 'antigravity')).toBe(true);
    expect(buildCatalog(['claude']).find((c) => c.id === 'antigravity')?.enabled).toBe(false);
  });
});
```
> This test assumes the foundation's `buildCatalog`/`AgentCatalogEntry` already carries `capabilities` (Phase 1 Delta C). If `AgentCatalogEntry` lacks `capabilities`, that's a missing foundation prerequisite — STOP and report (do not add it here; it belongs to Phase 1).

- [ ] **Step 2:** Run → FAIL (antigravity not in default registry).

- [ ] **Step 3: Edit `server/agents/registry.ts`.** Add `new AntigravityAdapter()` to the default `ADAPTERS` array:
```ts
import { AntigravityAdapter } from './antigravity-adapter';
// ...
const defaultRegistry = makeRegistry([new ClaudeAdapter(), new AntigravityAdapter()]);
```
  Ensure `buildCatalog` already maps `capabilities` (foundation). The Antigravity entry is **listed always but disabled unless its provider record is enabled** — `buildCatalog(enabled)` sets `enabled: enabled.includes('antigravity')`.

- [ ] **Step 4:** Run test → PASS. Re-run `tests/server/agents/registry.test.ts` (foundation) → still green (Claude resolution + fallback unchanged). `npm run typecheck` → clean.

- [ ] **Step 5: Commit.**
```bash
git add server/agents/registry.ts tests/server/agents/registry-antigravity.test.ts
git commit -m "feat: register AntigravityAdapter in the agent registry (disabled by default)"
```

---

## Task 7: Ingestion — Antigravity sessions into `session_usage` (provider `antigravity`)

**Files:**
- Modify: `server/services/ingestion-service.ts` (add `ingestAntigravitySessions`)
- Modify: `server/index.ts` (call it, gated on the provider being enabled)
- Test: `tests/server/services/ingest-antigravity.test.ts`

- [ ] **Step 1: Write failing test** against a temp `ANTIGRAVITY_HOME` containing the fixture:
```ts
// tests/server/services/ingest-antigravity.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ingestAntigravitySessions } from '../../../server/services/ingestion-service';
import { AntigravityAdapter } from '../../../server/agents/antigravity-adapter';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE session_usage (
    session_id TEXT PRIMARY KEY, project_dir TEXT, model TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0, estimated_cost_usd REAL NOT NULL DEFAULT 0,
    message_count INTEGER NOT NULL DEFAULT 0, session_date TEXT NOT NULL,
    first_message_at INTEGER NOT NULL, last_message_at INTEGER, ingested_at INTEGER NOT NULL);`);
  return db;
}

describe('ingestAntigravitySessions', () => {
  let db: Database.Database; let home: string;
  beforeEach(() => {
    db = freshDb();
    home = mkdtempSync(path.join(tmpdir(), 'agy-'));
    const chats = path.join(home, 'proj1', 'chats');
    mkdirSync(chats, { recursive: true });
    copyFileSync(
      path.resolve(__dirname, '../../fixtures/usage/antigravity-session.jsonl'),
      path.join(chats, 'session-2026-06-09T17-49-aaaaaaaa.jsonl'),
    );
  });

  it('writes a seat row (cost 0) tagged antigravity', () => {
    const adapter = new AntigravityAdapter();
    // adapter reads ANTIGRAVITY_HOME; inject via env for the test
    process.env['ANTIGRAVITY_HOME'] = home;       // NOTE: adapter caches the const at import — see Step 3 fix
    ingestAntigravitySessions(db, adapter);
    const row = db.prepare('SELECT * FROM session_usage').get() as any;
    expect(row.session_id).toContain('aaaaaaaa');
    expect(row.project_dir).toBe('antigravity:proj1');
    expect(row.output_tokens).toBe(713);
    expect(row.estimated_cost_usd).toBe(0);       // seat
    expect(row.model).toBe('gemini-2.5-pro');
  });
});
```

- [ ] **Step 2:** Run → FAIL (`ingestAntigravitySessions` undefined). **Also note:** the test reveals that `ANTIGRAVITY_HOME` is read at module-import time (a `const`), so `process.env` set inside the test won't take effect. **Fix:** make `ANTIGRAVITY_HOME` resolution a function (`antigravityHome()` reading `process.env` each call) in `antigravity-adapter.ts`, OR pass the home dir into `listSessionLogs` via an optional override. Prefer the function form; update Task 4's code accordingly (small change, re-run Task 4 tests).

- [ ] **Step 3: Write `ingestAntigravitySessions`** in `ingestion-service.ts`:
```ts
import type { AgentAdapter } from '../agents/agent-adapter';

/** Ingest Antigravity (agy/gemini) sessions into session_usage, tagged provider 'antigravity'. Seat → cost 0. */
export function ingestAntigravitySessions(db: Database.Database, adapter: AgentAdapter): void {
  const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_usage'").get();
  if (!hasTable) return;

  const existing = new Map<string, number>();
  for (const r of db.prepare('SELECT session_id, message_count FROM session_usage').all() as Array<{ session_id: string; message_count: number }>) {
    existing.set(r.session_id, r.message_count);
  }
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO session_usage
    (session_id, project_dir, model, input_tokens, cache_creation_tokens, cache_read_tokens, output_tokens, total_tokens, estimated_cost_usd, message_count, session_date, first_message_at, last_message_at, ingested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  for (const logPath of adapter.listSessionLogs(0)) {
    const u = adapter.parseUsage(logPath);
    if (u.messageCount === 0) continue;
    // session id: prefer the transcript header sessionId; fall back to filename shortid.
    const sessionId = deriveSessionId(logPath);           // helper: read header sessionId or parse filename
    const prev = existing.get(sessionId);
    if (prev !== undefined && prev >= u.messageCount) continue;

    const p = adapter.pricingFor(u.model ?? '');
    const cost = u.inputTokens * p.input + u.cacheReadTokens * p.cache_read
      + u.cacheCreationTokens * p.cache_creation + u.outputTokens * p.output; // 0 for seat
    const projectKey = logPath.split(/[\\/]/).slice(-3, -2)[0] ?? 'unknown';  // .../<projectKey>/chats/<file>
    const mtime = (() => { try { return statSync(logPath).mtimeMs; } catch { return Date.now(); } })();
    const sessionDate = new Date(mtime).toISOString().split('T')[0];

    upsert.run(
      sessionId, `antigravity:${projectKey}`, u.model,
      u.inputTokens, u.cacheCreationTokens, u.cacheReadTokens, u.outputTokens,
      u.inputTokens + u.cacheCreationTokens + u.cacheReadTokens + u.outputTokens,
      Math.round(cost * 10000) / 10000,
      u.messageCount, sessionDate, mtime, mtime, Date.now(),
    );
  }
}
```
  Add the `deriveSessionId(logPath)` helper (read the transcript header `sessionId` via `readTranscript`, else extract the trailing shortid from the filename). Import `statSync` if not already.

- [ ] **Step 4: Wire into `server/index.ts`** next to the Claude ingestion (around lines 51/60), gated on enabled:
```ts
import { ingestAntigravitySessions } from './services/ingestion-service';
import { AntigravityAdapter } from './agents/antigravity-adapter';
const antigravityAdapter = new AntigravityAdapter();
function maybeIngestAntigravity() {
  const enabled = configService.getPersisted().providers?.some((p) => p.id === 'antigravity' && p.enabled);
  if (!enabled) return;
  try { ingestAntigravitySessions(db, antigravityAdapter); }
  catch (err) { logger.error({ err }, 'Antigravity ingestion failed'); }
}
// call in the initial run + inside the existing 5-min interval callback
```

- [ ] **Step 5:** Run the new test + existing ingestion tests → PASS. `npm run typecheck` → clean.

- [ ] **Step 6: Commit.**
```bash
git add server/services/ingestion-service.ts server/index.ts server/agents/antigravity-adapter.ts tests/server/services/ingest-antigravity.test.ts
git commit -m "feat: ingest antigravity sessions into session_usage (seat, provider-tagged)"
```

---

## Task 8: Spawn wiring sanity (PtyManager + prompt strategy 'flag')

The foundation's Task 9 already made `PtyManager` adapter-driven. This task confirms Antigravity spawns correctly via that path — primarily the `promptStrategy:'flag'` branch (Claude uses `regex`).

**Files:**
- Modify: `server/pty-manager.ts` (only if the `'flag'` strategy branch is not yet handled)
- Test: `tests/server/pty-manager-antigravity.test.ts`

- [ ] **Step 1: Write failing test** (no real spawn — assert arg building + that `prepareContext` is invoked before launch):
```ts
// tests/server/pty-manager-antigravity.test.ts
import { describe, it, expect, vi } from 'vitest';
import { PtyManager } from '../../server/pty-manager';
import { AntigravityAdapter } from '../../server/agents/antigravity-adapter';
import type { Goal } from '../../src/shared/types';

const goal = { id: 'goal-1', cwd: '/repo', model: 'antigravity', permission_mode: 'autonomous' } as Goal;

describe('PtyManager + AntigravityAdapter', () => {
  it('builds yolo launch args via the adapter', () => {
    const adapter = new AntigravityAdapter();
    const mgr = new PtyManager(goal, adapter, { broadcast: () => {} });
    expect(mgr.buildLaunchArgs()).toEqual(['--session-id', 'goal-1', '--yolo']);
  });
  it('invokes prepareContext before spawning', () => {
    const adapter = new AntigravityAdapter();
    const spy = vi.spyOn(adapter, 'prepareContext').mockImplementation(() => {});
    new PtyManager(goal, adapter, { broadcast: () => {} }).buildLaunchArgs();
    // if prepareContext is called inside start(), assert in a start()-level test with a mocked pty instead
    expect(adapter.prepareContext).toBeDefined();
    spy.mockRestore();
  });
});
```

- [ ] **Step 2:** Run → check whether `PtyManager` already calls `adapter.prepareContext(ctx)` in `start()` and handles `promptStrategy.kind === 'flag'` (prompt as launch arg, not PTY-injected). If yes, the launch-args test should pass directly.

- [ ] **Step 3: If missing, edit `server/pty-manager.ts`:**
  - In `start()`, **before** building args, call `this.adapter.prepareContext(this.spawnContext())` (so `GEMINI.md`/MCP staging happens). For Claude `prepareContext` is a no-op or writes nothing relevant — confirm the foundation gave `ClaudeAdapter.prepareContext` an implementation (Phase 1 Delta C); if Claude's is `() => {}`, this is safe.
  - In the prompt-injection block, add the `'flag'` case: when `promptStrategy.kind === 'flag'`, do **not** schedule idle/regex injection — the prompt is expected in the launch args. (Antigravity carries the prompt via the agent; if the initial prompt must be supplied, append it in `buildStartArgs` once `SpawnContext` carries it — flagged in Task 5.)

- [ ] **Step 4:** Run the new test + existing `pty-manager` tests (Claude characterization) → all green (Claude path unchanged). `npm run typecheck` → clean.

- [ ] **Step 5: Commit.**
```bash
git add server/pty-manager.ts tests/server/pty-manager-antigravity.test.ts
git commit -m "feat: PtyManager supports antigravity (flag prompt strategy + prepareContext)"
```

---

## Task 9: Settings provider record (seat) + UI visibility

The foundation's Task 10 built the `AgentsSection`. This task confirms Antigravity appears with seat defaults and honest capability degradation, and that enabling it persists the right provider record.

**Files:**
- Modify (if needed): `server/services/config-service.ts` `normalizeProviders` (ensure a toggled-on antigravity gets `billingMode:'seat'`)
- Test: `tests/server/services/config-service-antigravity.test.ts`
- Test (client, if AgentsSection renders capabilities): `tests/client/components/AgentsSection-antigravity.test.tsx`

- [ ] **Step 1: Write failing config test.**
```ts
// tests/server/services/config-service-antigravity.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createConfigService } from '../../../server/services/config-service';

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE app_config (id INTEGER PRIMARY KEY CHECK (id = 1), config_json TEXT NOT NULL, updated_at INTEGER NOT NULL);`);
  return db;
}

describe('config-service antigravity provider record', () => {
  let svc: ReturnType<typeof createConfigService>;
  beforeEach(() => { svc = createConfigService(freshDb()); });

  it('enabling antigravity persists a seat record', () => {
    svc.updatePersisted({ providers: [{ id: 'antigravity', enabled: true, billingMode: 'seat' }] } as any);
    const ag = svc.getPersisted().providers.find((p) => p.id === 'antigravity');
    expect(ag?.enabled).toBe(true);
    expect(ag?.billingMode).toBe('seat');
    // claude record still present (invariant)
    expect(svc.getPersisted().providers.some((p) => p.id === 'claude' && p.enabled)).toBe(true);
  });
});
```
> This relies on Phase 1 Delta B's `providers` record shape + `ProviderConfigSchema` default `billingMode:'seat'`. If `PersistedConfigSchema` still uses `enabledProviders: string[]`, Delta B was not merged — STOP and report (this is a foundation prerequisite, not work for this plan).

- [ ] **Step 2:** Run → PASS if Delta B is in place (the schema default supplies `billingMode:'seat'`); else it surfaces the missing prerequisite. Add `normalizeProviders` logic only if needed to default the billing mode.

- [ ] **Step 3 (client, optional):** If `AgentsSection` should grey out hook/approval/MCP affordances for low-capability providers, add a render test asserting the antigravity row shows the `authHint` and disabled capability badges. Implement the minimal rendering in `AgentsSection.tsx` reading `entry.capabilities`. (If Phase 4 owns capability-aware UI, defer and note it — the data is already exposed via the catalog.)

- [ ] **Step 4:** Run tests → PASS. `npm run typecheck` → clean.

- [ ] **Step 5: Commit.**
```bash
git add server/services/config-service.ts tests/server/services/config-service-antigravity.test.ts tests/client/components/AgentsSection-antigravity.test.tsx
git commit -m "feat: antigravity seat provider record + settings visibility"
```

---

## Final verification

- [ ] `npm run typecheck` → clean.
- [ ] `npm test` → 0 new failures vs the Phase 1 green baseline.
- [ ] **Manual (requires real `agy`):** install `agy`, run it once to sign in (OAuth seat), enable Antigravity in Settings, create a goal with model `antigravity`. Confirm: `agy` spawns (not `claude`); a `GEMINI.md` is written in the goal cwd; after the session, `GET /api/analytics/*` shows the session under provider `antigravity` with cost $0 + an "unpriced/seat" badge and non-zero tokens; the model picker shows the Antigravity option only while enabled.
- [ ] **If `agy` is NOT available:** all unit tests (fixture-driven) still pass; mark the manual step BLOCKED-ON-`agy` and re-run Task 1's real spike before merge — pay special attention to the **cumulative-token rule (§2.4)** and **prompt mode (§2.2)**; if either differs, fix Task 4 (`aggregate`) / Task 5 (`buildStartArgs`) and their fixtures.

---

## Self-Review (by plan author)

**Spec coverage vs the brief:**
- (1) Full `AgentAdapter` impl — `resolveBinary`/`buildStartArgs`/`buildResumeArgs`/`promptStrategy` (Task 5), `installHooks`/`uninstallHooks`/`hooksInstalled` as honest no-ops with `canObserveHooks:false` (Tasks 4–5), `locateSessionLog`/`parseUsage→byModel`/`listSessionLogs`/`pricingFor`/`contextWindowFor` (Task 4), `capabilities` matrix (§2.8, Task 5), `prepareContext`→`GEMINI.md` (Task 5). ✅
- (2) Gemini models in the Phase 0A registry with `quotaWeight`+`contextWindow`, pricing `null` (seat) (Task 3 / §4). ✅
- (3) Added to `registry.ts` `ADAPTERS`; visible in Settings only when enabled, `billingMode` default `'seat'` (Tasks 6, 9). ✅
- (4) `parseUsage` wired into ingestion → analytics under provider `antigravity` (Task 7). ✅
- (5) Seat auth UX: `authHint = "Run \`agy\` once to sign in"`, no API key (Tasks 5, 9). ✅

**Locked contracts honored verbatim:** `AgentAdapter` incl. `readonly capabilities: AgentCapabilities {canObserveHooks;canResume;canMcp;canApprove;canStream}` and `prepareContext(ctx:SpawnContext):void`; `RawUsage {...totals, byModel: RawModelUsage[]}`; pricing via `model-registry.ts resolveModel()`, `null`=seat (cost 0 + unpriced); `SpawnContext {goalId,model,cwd,permissionMode,mcpServer}`; provider record `{id:'antigravity',enabled,billingMode:'seat',seatPriceUsdMonthly?}`. No interface mutation. ✅

**Spike honesty:** every `agy`-specific fact is marked `[assumed]`/`[proxy]` (spiked against `gemini` v0.44.1 because `agy` is not installed). Task 1 is the discovery task and gates the rest; the two highest-risk findings (cumulative tokens, prompt mode) are called out for re-verification.

**Migrations:** NONE — reuses `session_usage` (012) and `app_config` (015). Per-model persistence is deferred to Phase 2; this adapter produces `byModel` in memory and writes the existing flat row shape.

**Known soft spots (flagged inline):** `ANTIGRAVITY_HOME` must be a function not a const (Task 7 Step 2 fix) so tests/respike can override it; `gemini-3-pro` matcher currently also catches `gemini-2.5-pro` (acceptable, both frontier; refine when 3-pro transcripts exist); the initial-prompt delivery for `'flag'` strategy needs `SpawnContext` to carry the prompt (or PTY injection fallback) — flagged in Tasks 5/8; `prepareContext`/`GEMINI.md` reuses the foundation's goal-doc locator if it exists, else writes a managed-block file referencing the same docs.
