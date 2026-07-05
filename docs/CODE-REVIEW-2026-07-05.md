# Claude Deck — Full Codebase Review (2026-07-05)

Requested by Jerry. Covers: simplification, dead code, test completeness, test failures,
Vertex-vs-OAuth auth mode, all-LLM analytics, logging/retention, and misc findings.
Each section ends with a recommended action; the consolidated implementation plan is at the bottom.

---

## 1. Simplification opportunities (no functionality loss)

Ranked by impact. LOC total reviewed: ~28.5k across `server/` + `src/`.

### 1.1 Frontend bypasses its own typed API helper — HIGH impact, LOW risk
`src/lib/api.ts:60-108` provides `apiGet/apiPost/apiPatch/apiDelete` with centralized
error handling and Zod validation, but only 4 files use it. **23 files** hand-roll
`fetch('/api/...')` with copy-pasted error/JSON ceremony (`AnalyticsPage.tsx`,
`SettingsPage.tsx`, `SkillsPage.tsx`, `GoalDetailPage.tsx`, `Sidebar.tsx`, most of
`components/goal/*` and `components/settings/*`).
**Action:** migrate all call sites to the helpers; add `apiGetSafe(path, fallback)` for
fail-open analytics reads. Mechanical, verifiable per-call-site.

### 1.2 `server/routes/system.ts` (1094 lines) is a junk drawer — HIGH impact, LOW risk
31 routes across unrelated domains (12+ analytics endpoints, config, hooks, skills,
agents, documents, skill-directories). ~12 analytics handlers repeat the identical
`db-guard + days-parse + try/catch + fail-open-empty` block (`system.ts:82-118,
176-198, 457-546, 701-778`).
**Action:** split into `routes/analytics.ts`, `routes/config.ts`, `routes/documents.ts`,
`routes/skill-directories.ts`; add one `analyticsHandler(empty, fn)` wrapper. Removes
~250 lines, response shapes unchanged.

### 1.3 Three near-identical model services — MEDIUM impact, LOW risk
`claude-models-service.ts` (174), `codex-models-service.ts` (81),
`antigravity-models-service.ts` (188) each reimplement cache/TTL/inflight-coalescing/
fallback-warn plumbing; only the fetch source differs.
**Action:** extract `createCachedModelSource({ fetch, staleness })`. Careful: antigravity
refreshes in background, codex keys on file mtime — parameterize the staleness strategy.

### 1.4 `pty-manager.ts` `start()`/`resume()` duplicate ~90 lines — MEDIUM impact, MEDIUM risk
`server/pty-manager.ts:186-262` vs `:264-354`: identical execPath swap, ready-detection
state machine, onData/onExit wiring. Only difference: start's ready path writes the
initial prompt.
**Action:** extract `wireTerminal(onReady)` + `spawnPty(path,args,env)`. Do this
*after* adding the missing PTY lifecycle tests (see §3) — it's timing-sensitive code.

### 1.5 `AnalyticsPage.tsx` (846 lines) god component with two fetch styles — MEDIUM-HIGH impact, MEDIUM risk
18 `useState` hooks; ~8 raw inline fetches (`:144-201`) coexist with the typed
`analytics-api.ts` helpers (`:203-212`) that already wrap the same logic.
**Action:** move inline fetches into `analytics-api.ts`; collapse state into a
`useAnalyticsData(timeRange)` hook; split per-chart subcomponents. Pairs naturally with
review item #6 (all-LLM analytics) — do them together.

### 1.6 Minor
- `useGoalsStore.upsertGoal` / `useSessionsStore.upsertSession` — same findIndex-replace
  pattern; extract `upsertById()`.
- 4th bespoke TTL cache at `system.ts:860-872`; consolidate into a `ttlCache` util when 1.2/1.3 land.
- Explicitly **not** over-engineered (leave alone): the agent-adapter strategy pattern
  (3 real implementers), and the two config stores (server config vs UI prefs — distinct concerns).

---

## 2. Dead code

Every item was cross-grepped to confirm zero references.

### HIGH confidence — delete now
| Item | What |
|---|---|
| `debug-result-event.json` (repo root) | Stray debug dump |
| `src/components/global/TopBar.tsx` | Orphan component, no importer |
| `src/components/goal/GoalConversation.tsx` | Orphan component, no importer |
| `src/components/sessions/index.ts` | Unused barrel; consumers import files directly |
| `src/lib/notifications.ts` | Whole module unreferenced (browser Notification wrapper); also drop the `MockNotification` polyfill vestige in `tests/setup-dom.ts` |
| `apiDelete` in `src/lib/api.ts:98` | Never called |
| `getTranscript`, `formatTranscriptForTerminal` in `server/services/transcript-service.ts:48,257` | Exported, unreferenced |

### MEDIUM confidence — production-dead, only their own test references them (delete module + test together)
| Item | Superseded by |
|---|---|
| `server/resume-context.ts` | `resume-driver.ts` + `restartSession()` |
| `server/services/trace-service.ts` (`TraceService` class) | `routes/trace.ts` uses tar-utils + sqlite directly |
| `src/lib/tab-badge.ts` | Feature dropped |
| `src/stores/useSessionHealthStore.ts` | `ContextHealth.tsx` doesn't use it |
| npm deps `react-window` + `@types/react-window` | No imports remain |

### LOW confidence — test seams, keep unless intentionally pruning
Factory exports (`createXModelsService`), `parseAgyModels`, `parseStreamLine`,
`makePortReclaimer`/`buildHeadroomCommand`/`portFromBaseUrl`, `isPathAllowedAgainst`,
`UNKNOWN_PRICING_FALLBACK`. These exist to be unit-tested; leave them.

### Verified NOT dead
All 14 mounted routers, all MCP tools (imported with `.js` extensions), all 18 DB tables,
all other npm deps, schema/type exports composed into unions.

---

## 3. Test suite completeness

**162 test files** (114 server, 35 client, 9 shared, 2 mcp, 1 hooks, 1 scripts).
Server coverage is strong; client is thin. Two structural problems:

1. **Orphaned suites never run:** `tests/hooks/client.test.ts` and
   `tests/scripts/install-hooks.test.ts` match no vitest project glob in
   `vite.config.ts` — they are green in the tree but excluded from `npm test`.
   `mcp/tests/*` only run via a separate `cd mcp && npm test`.
2. **No coverage instrumentation at all** — no `@vitest/coverage` provider configured,
   so completeness is unmeasured.

### Top gaps by risk
1. `src/lib/ws-manager.ts` (199 lines) — client WS lifecycle/reconnect/backoff: **zero tests** (server WS half is tested).
2. `server/pty-manager.ts` (416 lines) — only happy-path argv/cwd/trace tests; kill/resize/write, crash/exit codes, restart paths untested. Highest-consequence subsystem.
3. `server/services/usage-service.ts` — only pure primitives tested; the money-math aggregation body is not.
4. `inter-goal-message-service.ts` (210 lines) — zero tests; failures silently drop cross-goal instructions.
5. `transcript-service.ts` (284), `skill-analysis-service.ts` (255), `conversation-logger.ts` (94) — zero tests.
6. Client stores `useConnectionStore`, `useMessagesStore`, `useConfigStore` — untested, compounding gap 1.
7. Untested pages: `SessionDetailPage`, `SessionsListPage`, `ClaudeMdPage`; nearly all of `components/global|goal|sessions|settings|scheduled|orchestrator`.

### Possibly-redundant suites (audit, don't blindly keep)
`analytics-phase2/phase3/regression` + `routes/analytics-overhaul` server tests and the
three `AnalyticsPage*.test.tsx` variants layer historical phases; the pre-overhaul ones
may assert superseded behavior.

---

## 4. Test failures (current: 2 of 1492)

Both are **test bugs, not app bugs** — verified by isolated re-run:

1. **`tests/client/pages/AnalyticsPage.test.tsx:709` — deterministic fail.**
   `expect(screen.getByText(/6/))` — the unanchored regex `/6/` matches multiple nodes
   (e.g. "4.1K" token cells). Fix: query the specific summary element (`getByText('6')`
   scoped to the summary container, or a testid).
2. **`tests/server/agents/codex-adapter.test.ts:316` — flaky (passes in isolation).**
   `listSessionLogs` hits the real `~/.codex` path and the 5s default timeout only
   under full-suite parallel load. Fix: inject a temp root (the sibling tests already
   do) so the test never touches the real home dir, which also makes it deterministic
   across machines.

---

## 5. Vertex vs OAuth auth mode (multi-PC)

**Current state:** there is no auth-mode concept. The deck inherits its *entire launch
shell environment* into every spawned session (`pty-manager.ts:95-103`). The single
detection point is `isVertex()` (`server/headroom-env.ts:14-17`), a truthy check on
`CLAUDE_CODE_USE_VERTEX` **in the deck server's own process.env** — used only to pick
which base-URL var the Headroom proxy rewrites and which upstream flags the proxy gets
(`headroom-service.ts:142-168`).

**Consequences on multi-PC:**
- Whatever shell launched `npm run dev` determines auth for every session. A Vertex box
  launched from a shell without the env vars silently misroutes the proxy; a stale
  exported var on an OAuth box does the inverse. The code comments in
  `headroom-env.ts:56-98` show this bug class was already hit for *region* and patched
  by reading `~/.claude/settings.json` — but `isVertex()` itself has no such fallback.
- Vertex-only machines also get a degraded model picker: `claude-models-service.ts`
  fetches live models with the OAuth token from `~/.claude/.credentials.json`; absent
  that it falls back to the static registry list. Non-breaking but inconsistent.

**Design (recommended): both native detection and a setting.**
Add persisted `authMode: 'auto' | 'vertex' | 'oauth'` (default `auto`).
- `auto` = improved native detection: `CLAUDE_CODE_USE_VERTEX` from process.env, then
  `~/.claude/settings.json` env block (mirroring `regionFromClaudeSettings()`), then
  presence of `.credentials.json` → oauth.
- Explicit `vertex`/`oauth` wins over ambient env, and the deck **writes/clears**
  `CLAUDE_CODE_USE_VERTEX` (+ `ANTHROPIC_VERTEX_PROJECT_ID`, `CLOUD_ML_REGION`
  overrides) on the child env so the CLI itself honors the chosen mode.
Because the config DB lives in each machine's `DATA_DIR`, the setting is naturally
per-machine — exactly the multi-PC behavior needed.

Touch points (all identified): `src/shared/schemas.ts:346-366` (schema),
`headroom-env.ts:14-17` (`isVertex(authMode?)`), `pty-manager.ts:95-103` (env write),
`headroom-service.ts:142-168` (proxy flags), `index.ts:200-219,519,540-543`
(fail-closed gate, config resync, brain env), `SettingsPage.tsx` (selector UI),
plus optional Vertex project/region override fields.

---

## 6. Analytics: token usage for all LLMs

**Current state:** ingestion is Claude-only. `ingestAllSessions()` reads only
`~/.claude/projects/*.jsonl` into `session_model_usage` (`ingestion-service.ts`,
wired at `index.ts:85,94`, refreshed every 5 min). Pricing lives in the single
registry `src/shared/agents/model-registry.ts` — Claude tiers priced; codex (GPT-5.x)
and antigravity (Gemini) entries exist but are `pricing: null` → always $0/"unpriced".

**The good news:** the plumbing is already provider-generic and ~80% built:
- `session_model_usage` has a `provider` column; the value/utilization queries group by provider.
- `codex-adapter.ts` has `parseCodexUsage()` + `listCodexRollouts()` for
  `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`; `antigravity-adapter.ts` has
  `parseAntigravityUsage()` for `~/.gemini/...`. **Neither is called by ingestion** —
  they're scaffolding that never got wired in.

**Plan:** add a provider sweep to `ingestion-service.ts` that walks each registered
adapter's `listSessionLogs()`/`parseUsage()` → `buildModelUsageRow` → upsert. Then:
- Verify the codex parser against real rollout files (it carries `ASSUMED` log-shape
  comments at `codex-adapter.ts:158`) — note `~/.codex` on this machine currently has
  no `sessions/` dir, so verification needs a machine with Codex usage.
- Decide pricing display for seat-billed providers: token counts + quota weight
  (current design) vs. adding metered per-token rates to the registry.
- Surface provider breakdown in the Analytics UI (the Model Breakdown table already
  renders provider rows when present).

**Out of reach without new capture:** LLM usage that leaves no local transcript
(e.g., ad-hoc API scripts). Only realistic route is fronting those with a logging
proxy (Headroom currently proxies Claude traffic only). Scope question for Jerry below.

---

## 7. Logging: retention + verbosity

**Current state:**
- Single pino logger (`server/logger.ts`), level from `LOG_LEVEL` env var read once at
  import — **stdout only, no files, no rotation, no retention, not changeable at runtime,
  not in the UI**. 342 logger calls across 56 server files (good discipline; zero
  stray `console.*` on the server).
- The only retention mechanism in the app is trace pruning: `tracePruneDays`
  (default 90) already user-configurable in Settings, enforced by a daily 03:00 cron
  (`trace-prune-job.ts`) that hot-reloads the setting. **This is the exact template to
  copy.**
- Nothing retains/prunes `hook_events` or `session_usage` DB rows.
- Client side: no error boundary, no `window.onerror`/`unhandledrejection` capture;
  two raw `console.error` in `TerminalPanel.tsx`.

**Plan:**
1. `logger.ts`: add a file transport writing NDJSON to `<dataDir>/logs/` alongside the
   pretty stdout stream (pino multistream or `pino-roll` for size/date rotation).
2. New persisted settings `logLevel` (trace…fatal, default info) and
   `logRetentionDays` (default 30): schema → `config-service` DEFAULTS → Settings UI
   section (mirror the Trace Retention block at `SettingsPage.tsx:436-457`).
3. Live verbosity: in the existing `onConfigUpdated` hook (`system.ts:363` /
   `index.ts:519`), set `logger.level = config.logLevel` — pino supports runtime level
   changes; no restart needed.
4. Log-file pruner cron mirroring `trace-prune-job.ts`, reading `logRetentionDays`
   fresh each fire.
5. Optional (recommended): DB-row retention for `hook_events` (same pruner), and a
   client error boundary + `window.onerror` handler POSTing to a `/api/client-errors`
   endpoint that logs through pino — closes the "frontend errors vanish" hole.

---

## 8. Other findings

1. **Vitest config bugs (do first — they change what "passing" means):** add
   `tests/hooks` + `tests/scripts` to a project glob; consider a root script that also
   runs `mcp/` tests; add `@vitest/coverage-v8` with thresholds.
2. **Model picker on Vertex machines** degrades to the static alias list
   (`claude-models-service.ts:48-61`). Acceptable if documented; fixable later with a
   Vertex-aware model source.
3. **Doc hygiene:** `docs/PLAN-session-observer-fixes.md` and dated one-off plan files
   under `docs/superpowers/plans/` are stale; archive or delete.
4. **`isVertex()` env-drift bug class** (§5) is the likely root cause of past
   "worked on one PC, broke on the other" symptoms — the auth-mode setting fixes it
   structurally.
5. **Codex parser assumptions** (`codex-adapter.ts:158` `ASSUMED` comments) should be
   validated against real rollouts before analytics trusts the numbers.

---

## Consolidated implementation plan

Phased so each lands independently with tests green.

### Phase 0 — Hygiene (small, immediate)
- Fix the 2 failing tests (ambiguous `getByText(/6/)` query; inject temp root in codex-adapter test).
- Fix vitest project globs so `tests/hooks` + `tests/scripts` actually run; add coverage provider.
- Delete HIGH-confidence dead code; MEDIUM-confidence pending Jerry's confirmation.
- Delete `debug-result-event.json`; archive stale plan docs.

### Phase 1 — Auth mode (multi-PC correctness)
- `authMode` setting (`auto`/`vertex`/`oauth`) + improved auto-detection + child-env
  write-through + proxy flag plumbing + Settings UI selector. Tests mirroring
  `headroom-env.test.ts` / `headroom-service.test.ts` patterns.

### Phase 2 — Logging
- File transport + rotation under `<dataDir>/logs/`; `logLevel` + `logRetentionDays`
  settings with live apply; log pruner cron; Settings UI "Logging" section.
- Optional: client error capture endpoint; `hook_events` retention.

### Phase 3 — All-LLM analytics
- Wire codex + antigravity adapters into `ingestion-service.ts`; validate codex parser
  against real rollouts; provider breakdown surfaced in UI; pricing decision per Jerry.

### Phase 4 — Simplification refactors
- Frontend → `api.ts` helpers everywhere; split `system.ts`; unify model-service
  caching; then (with new tests first) dedupe `pty-manager` start/resume; decompose
  `AnalyticsPage` (fold into Phase 3 work where overlapping).

### Phase 5 — Test debt
- ws-manager client tests, pty-manager lifecycle tests, usage-service aggregation
  tests, inter-goal-message-service tests; audit the layered analytics-phase suites
  for redundancy.
