# Multi-LLM, Analytics & Orchestrator — Master Roadmap

> **For agentic workers:** This is a **roadmap of plans**, not a single bite-sized task list. The scope spans ~8 independent subsystems; per `superpowers:writing-plans` Scope Check, each subsystem gets its own implementation plan. This document sequences them, records the cross-cutting decisions locked in the 2026-06-09 design conversation, and specifies the immediately-actionable work (Phase 0 + the Phase 1 deltas) in enough detail to execute. Larger new subsystems get a one-paragraph brief + exit criteria here and a full bite-sized plan written when their phase starts.

**Goal:** Turn Claude Deck from a Claude-only cockpit into a multi-LLM control plane with billing-aware analytics, the designed-but-unbuilt features (provider adapters, orchestrator), the stubbed features enabled (trace, approvals, interrupt, markdown edit), and the robustness features surfaced in review (workspace isolation, project registry, verification gate, session survivability, budget/quota guardrails).

**Architecture:** Everything rides the `AgentAdapter` abstraction (foundation, in flight). Provider differences live behind adapters; install-specific economics (metered vs subscription seat) live in per-provider **config**, not the adapter. Analytics always computes USD from token counts × a single maintained pricing registry; `billingMode` decides whether that number is labeled *cost* or *API-equivalent value*. The orchestrator is the capstone that ties goals/sessions/approvals/scheduler together behind an event-driven dispatcher.

**Tech Stack:** TypeScript 5.5 (strict), Express v5, better-sqlite3 (WAL), Zod, node-cron, Pino, React 19, Vitest. Node 24.

---

## 0. How to read this

Each phase below states: **scope**, **depends on**, **existing plan/spec** (or "NEEDS PLAN"), **key deltas/decisions**, **exit criteria**. Phases are ordered by dependency; within a phase, work is independent unless noted. Phase 0 and the Phase 1 deltas are specified concretely. Phases 2–6 are briefs — write their bite-sized plan (via `superpowers:writing-plans`) at the start of that phase, when the preceding phase's reality is known.

**Branch reality (verify before starting):**
- `feat/multi-agent-foundation` (working) — has foundation **Task 1** (`src/shared/agents/types.ts`) uncommitted.
- `feat/multi-agent-impl` (sibling worktree) — already built migration `015_app_config.sql`, `config-service.ts`, its test, and `PersistedConfigSchema` (`enabledProviders: string[]`). **These must be reconciled onto the working branch** before Phase 1 config work, or Phase 1 duplicates them.
- The April-era `ORCHESTRATION-STATUS.md` in git status is stale F0 history — **do not** let it sweep into a commit; delete it.

---

## 1. Existing design assets (reuse, don't rewrite)

| Asset | File | Status |
|---|---|---|
| Agent adapter foundation — spec | `docs/superpowers/specs/2026-06-06-agent-adapter-foundation-design.md` | Approved |
| Agent adapter foundation — plan (11 tasks) | `docs/superpowers/plans/2026-06-06-agent-adapter-foundation.md` | Task 1 done; 2–10 pending |
| Orchestrator — design spec | `docs/superpowers/specs/2026-06-08-orchestrator-design.md` | Approved |
| Orchestrator core (backend) — plan | `docs/superpowers/plans/2026-06-08-orchestrator-core.md` | Pending; has foundation-fallback seam |
| Settings persistence — design | `docs/superpowers/specs/2026-06-08-settings-persistence-design.md` | Approved; converges with foundation Task 8 |
| Markdown view+edit — design | `docs/superpowers/specs/2026-06-08-markdown-view-edit-design.md` | Approved; blocked on settings persistence |

**NEEDS PLAN/SPEC (not yet written):** Phase 0 fix, analytics overhaul (Phase 2), Antigravity adapter "Spec B" (Phase 3), Codex adapter "Spec C" (Phase 3), capability-matrix delta, robustness features (Phase 5), orchestrator "Faces" Plan 2 (Phase 6).

---

## 2. Cross-cutting decisions (locked 2026-06-09 — bind all phases)

1. **Billing mode is install/provider config, not adapter.** Same `ClaudeAdapter` serves work (Claude via Vertex = metered) and personal (Claude subscription = seat). So `AppConfig` carries per-provider records, not a bare `enabledProviders: string[]`.
2. **Dollars are always computed; `billingMode` only changes the label.** Metered → "cost" (+ budget caps + alerts). Seat → "API-equivalent value" (judge subscription worth — the user observed ~$6k Claude value in 60 days vs $200/mo).
3. **Seat analytics add two things on top of equivalent value:** (a) **value multiplier** = equivalent value ÷ `seatPriceUsdMonthly` (keep/cancel signal per subscription), with a UI tooltip noting it's *replacement* value and overstates somewhat at zero marginal cost; (b) **quota-weighted window utilization** (model-weighted units against each plan's rolling window) for "which model can I afford right now." Window utilization is an **estimate** (no vendor quota API) and must be labeled so.
4. **Per-model granularity is required.** A session can mix models (subagents, mid-session switch). Attribute tokens/cost by the per-message model, not the goal's `model` field. This forces `RawUsage` to carry a per-model breakdown (Phase 1 delta A) and the `session_usage` store to gain per-model rows (Phase 2).
5. **Efficiency is a first-class metric.** "Always use the top model" is the anti-goal. Surface **top-tier token share** over time and **equivalent-$-per-completed-goal** trend so the user can see themselves getting more efficient.
6. **No metered API for personal use, ever.** Personal providers are subscription seats (Claude, Gemini/Antigravity, ChatGPT/Codex). Work policy = Claude-only; `enabledProviders`/provider records are the enforcement, and the provider list should be **lockable** (env/config) so a Settings click can't violate work policy.
7. **Right model for the job** is realized as a **model scorecard** (Phase 2): outcome per model (duration, turns, quota weight, equivalent $, and — once the verification gate lands — pass/fail), sliceable by goal tag.
8. **Capability matrix on the adapter** (Phase 1 delta C): adapters declare what they can do (`canObserveHooks`, `canResume`, `canMcp`, `canApprove`, …) so the UI degrades honestly for non-Claude providers instead of silently lying (the existing cosmetic-approval failure mode, multiplied by 3 providers).

---

## Phase 0 — Immediate fixes (independent; do first)

Two unrelated fast wins that don't depend on the foundation. **Each gets a short bite-sized plan; both are small enough to specify here.**

### 0A. Model & pricing registry (fixes "Fable 5 shows no cost")

**Problem.** Pricing is hardcoded in **two** copies — `server/services/usage-service.ts:44` and `server/services/ingestion-service.ts:12` — each a 3-entry `Record` (`opus`/`sonnet`/`haiku`) with substring matching and a **silent fallback to opus** for anything unrecognized (`ingestion-service.ts:24`, `usage-service.ts:71`). Consequences: (1) a `claude-fable-5[1m]` session, and any future GPT-5.5 / Gemini session, is mispriced as Opus — silently wrong, which **corrupts the efficiency analytics this whole effort is about**; (2) there is no single place to add a model or update a rate; (3) unknown models are invisible rather than flagged.

> Note: the *symptom* the user sees (zero tokens/cost for the current Fable 5 session) may be ingestion timing or transcript-shape, not only pricing — the silent opus-fallback would mis-*price*, not zero-out. The fix below makes unknown models **loud** (logged + surfaced in the UI), which turns whatever the real cause is into something visible instead of guessed.

**Files:**
- Create: `src/shared/agents/model-registry.ts` — the single source of truth.
- Modify: `server/services/usage-service.ts` (delete local `MODEL_PRICING`/`getPricing`/`getContextWindow`; import from registry).
- Modify: `server/services/ingestion-service.ts` (same; delete local `MODEL_PRICING`/`getPricing`).
- Test: `tests/shared/agents/model-registry.test.ts`.

- [ ] **Step 1: Write `src/shared/agents/model-registry.ts`.** One entry per known model with id-substring matchers, per-token pricing, display label, provider, tier (for top-tier-share + quota weight), and context window. Include current models: Claude `opus`/`sonnet`/`haiku` + **`fable`** (Fable 5), and stubs for `gpt-5.5` / `gemini-3-pro` / `gemini-flash-2.5` (pricing `null` until their adapters land — `null` means "seat, no public per-token rate yet," handled explicitly downstream, never coerced to Opus).
```ts
export type ModelTier = 'frontier' | 'balanced' | 'fast' | 'unknown';
export interface ModelEntry {
  id: string;                  // canonical key, e.g. 'fable-5'
  match: (raw: string) => boolean;   // matches a transcript model string
  label: string;               // 'Fable 5'
  provider: string;            // 'claude' | 'antigravity' | 'codex'
  tier: ModelTier;
  /** per-token USD; null = no public metered rate (subscription-only) */
  pricing: { input: number; cache_read: number; cache_creation: number; output: number } | null;
  /** quota weight vs the provider's lightest model (for seat window utilization) */
  quotaWeight: number;
  contextWindow: number;       // e.g. 200_000, or 1_000_000 for [1m]
}
export const MODEL_REGISTRY: ModelEntry[] = [ /* ... */ ];
export function resolveModel(raw: string | null): ModelEntry | null; // null = unknown (do NOT default to opus)
export const UNKNOWN_PRICING_FALLBACK = null;
```
- [ ] **Step 2: Test** `resolveModel('claude-fable-5[1m]')` → the Fable entry with `contextWindow: 1_000_000`; `resolveModel('claude-opus-4-8')` → opus; `resolveModel('totally-made-up')` → `null`. Run → FAIL, then implement → PASS.
- [ ] **Step 3:** Replace both local pricing copies with registry calls. Where a model is unknown: log `logger.warn({ model }, 'unknown model — usage uncosted')`, store the row with `estimated_cost_usd = 0` **and a non-null `model` string**, and (Phase 2) render it in the UI as an "unpriced model" badge rather than hiding it. Keep token counts intact regardless of model.
- [ ] **Step 4:** Run `npm test` (usage + ingestion + analytics tests) → green; existing Claude numbers unchanged (opus/sonnet/haiku entries are byte-identical rates). Commit.

> This file becomes the seam `ModelPricing`/`contextWindowFor` in the foundation's `ClaudeAdapter` (Task 5/6) delegate to, and the table the Phase 2 analytics weights consume. Build it once here.

### 0B. Security prerequisite — localhost bind + shared-secret auth

Not in the original feature ask, but the 2026-06-09 review found unauthenticated LAN RCE (`server/index.ts` binds `0.0.0.0`; `POST /api/goals` with `permission_mode: autonomous` spawns `claude --permission-mode bypassPermissions` in an attacker-chosen `cwd`; WS lets any client inject keystrokes; `GET /api/skill-content?path=` reads any `.md`). Every phase below increases the value of that open endpoint (Codex/Antigravity sessions, a Discord-reachable orchestrator, git write access). **Gate: bind `127.0.0.1` by default + token on `/api` and the WS upgrade + `cwd`/`path` containment before Phase 5/6.** Gets its own short plan; sequence it before workspace isolation and the orchestrator. (The `cwd` allow-list it needs is the Project Registry from Phase 5 — build that allow-list here as the minimum.)

**Exit criteria (Phase 0):** Fable 5 (and any unknown model) is visibly handled, not silently Opus-priced; one registry file owns models/pricing/tiers/windows; server refuses unauthenticated non-localhost callers.

---

## Phase 1 — Complete the adapter foundation, with 3 deltas

**Scope:** Execute foundation plan Tasks 2–10 (`2026-06-06-agent-adapter-foundation.md`), reconciling the sibling `feat/multi-agent-impl` config artifacts, and fold in three forward-looking deltas so Phase 2/3 don't require a second migration of the same tables.

**Depends on:** Phase 0A (registry is what Tasks 5/6 delegate to). **Existing plan:** yes (Tasks 2–10).

### Delta A — `RawUsage` carries a per-model breakdown
Decision 4 needs per-model attribution. Amend the foundation's `RawUsage` (`src/shared/agents/types.ts`, the file in flight) **before it's consumed by Task 5**:
```ts
export interface RawModelUsage {
  model: string | null;
  inputTokens: number; outputTokens: number;
  cacheReadTokens: number; cacheCreationTokens: number;
  messageCount: number;
}
export interface RawUsage extends RawModelUsage {  // top-level = session totals (back-compat)
  byModel: RawModelUsage[];                        // per-model rows within the session
}
```
`parseUsage()` (Task 5) aggregates per-model into `byModel` and also returns the rolled-up totals. Adapters with one model per session return a single-element `byModel`. **This is a 1-line-shaped change now and a 3-adapter breaking change later — do it before committing Task 1.**

### Delta B — `AppConfig` providers are records, not a string list
Decisions 1–3, 6. Evolve `enabledProviders: string[]` → a `providers` array. Because the sibling branch already shipped `enabledProviders: string[]` in migration 015, handle it one of two ways:
- **If 015 is not yet merged onto the working branch:** define the richer shape directly in `PersistedConfigSchema` (foundation Task 2), keeping a derived `enabledProviders` getter for any existing reader.
- **If 015 is already merged:** add migration `016_provider_config.sql` that rewrites `config_json` from `{enabledProviders:[...]}` to `{providers:[...]}`, defaulting each to `billingMode:'seat'`, no budget, no seat price.
```ts
const ProviderConfigSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
  billingMode: z.enum(['metered', 'seat']).default('seat'),
  seatPriceUsdMonthly: z.number().nonnegative().optional(),     // seat mode → value multiplier
  budget: z.object({ dailyUsd: z.number(), monthlyUsd: z.number(), perGoalUsd: z.number() })
            .partial().optional(),                              // metered mode → caps/alerts
});
// invariant preserved: a 'claude' record always present & enabled
providers: z.array(ProviderConfigSchema).default([{ id: 'claude', enabled: true, billingMode: 'seat' }]),
```
`config-service.normalizeProviders()` enforces the claude-always-present invariant on the record array. The registry's `adapterForModel(model, enabledIds)` keeps taking ids — derive `enabledIds = providers.filter(p=>p.enabled).map(p=>p.id)`.

### Delta C — capability matrix on the interface
Decision 8. Add to the `AgentAdapter` interface (foundation Task 4) and `AgentCatalogEntry` (Task 1):
```ts
export interface AgentCapabilities {
  canObserveHooks: boolean; canResume: boolean; canMcp: boolean;
  canApprove: boolean; canStream: boolean;
}
// AgentAdapter: readonly capabilities: AgentCapabilities;
// AgentCatalogEntry: capabilities: AgentCapabilities;  (so the UI can grey out unsupported affordances)
```
`ClaudeAdapter` sets all `true` (Task 6). The UI (Task 10 + Phase 4) reads `catalog[].capabilities` to disable approval/resume/hook toggles for providers that lack them.

**Settings persistence convergence:** foundation Task 8 already replaces the no-op `GET/PUT /api/config` with the real `ConfigService`. The standalone `2026-06-08-settings-persistence-design.md` is the **same wiring** plus the Settings scrollbar fix and field-name (`tracePruneDays`) guarantee — fold its scrollbar + round-trip tests into Task 8/10 rather than running it separately.

**Exit criteria (Phase 1):** Claude behavior byte-identical (characterization tests green); `/api/config` persists per-provider records across restart; Settings shows the Agents section (Claude locked-on); model pickers are catalog-driven; `parseUsage` returns `byModel`; adapters declare capabilities. **Test baseline:** 0 new failures vs the Phase 0 green baseline.

---

## Phase 2 — Analytics overhaul (the core ask) — NEEDS PLAN

**Scope:** Make the Analytics page billing-aware and per-model. **Depends on:** Phase 1 (provider records, `RawUsage.byModel`, registry tiers/weights). **Existing plan:** none — write one at phase start.

**Data layer:**
- Add per-model granularity to the usage store: either a `session_model_usage` child table (`session_id, model, tokens…, estimated_cost_usd`) or a `by_model_json` column on `session_usage`. Ingestion (`ingestion-service.ts`) writes the `byModel` rows; cost per row = registry pricing (or 0 + unpriced flag when `pricing === null`).
- Cost is **always** computed. A per-provider `billingMode` (from config) decorates the response with `label: 'cost' | 'equivalent_value'`.

**New/changed endpoints (under `/api/analytics`):**
- `model-breakdown?days=N` → per model: tokens (in/out/cache), equivalent $, effective rate, share of total, tier. Drives a **breakdown table**.
- `model-mix?days=N&bucket=day` → stacked model token share over time + a **top-tier-share** series (Decision 5).
- `value?days=N` → per provider: equivalent $ over period, `seatPriceUsdMonthly`, **value multiplier**, billing label. (Metered providers show budget vs spend instead.)
- `window-utilization` (seat only) → quota-weighted consumption vs each provider's rolling-window estimate, labeled "estimate."
- `cost-per-goal?days=N` → equivalent-$-per-completed-goal trend (needs goal↔session linkage already in the DB).

**UI (`src/pages/AnalyticsPage.tsx`):** new sections — Model Breakdown table, Model Mix chart (with top-tier-share callout), Subscription Value cards (multiplier per seat, tooltip caveat), Window Utilization gauges (personal), Budget vs Spend (work). Respect the existing fetch-race fixes flagged in review (AbortController per `timeRange` change). Unpriced models render with a badge, not hidden.

**Exit criteria:** On the personal profile, the page shows per-model tokens + equivalent $, a subscription value multiplier (the "$6k / $200 = steal" view), and a top-tier-share trend. On the work profile, the same data renders as cost + budget. Switching billing mode in Settings reskins labels without changing math. The model scorecard (Decision 7) lands here if the verification gate (Phase 5) is already in; otherwise scorecard ships cost/speed columns now and pass/fail when that gate exists.

---

## Phase 3 — Antigravity + Codex adapters — NEEDS SPEC B + SPEC C + PLANS

**Scope:** The second and third providers, each a full `AgentAdapter` implementation wired into spawn, ingestion, hooks-or-equivalent, and analytics. **Depends on:** Phase 1 (interface + capabilities + registry), Phase 2 (so their usage shows up correctly), Phase 0A (their model entries). **Existing plan:** none — the foundation spec explicitly defers these to "Spec B" (Antigravity) and a new "Spec C" (Codex).

Per-provider concerns each spec must resolve:
- **Spawn/auth:** headless invocation + subscription-seat sign-in (`agy` for Antigravity; `codex`/ChatGPT seat for Codex). No API keys (Decision 6).
- **Usage parsing:** locate + parse each CLI's transcript into `RawUsage.byModel`; register their models + (seat-null) pricing + quota weights in the Phase 0A registry.
- **Capabilities:** declare honestly — e.g. if Codex/Antigravity lack a Claude-style hook system, `canObserveHooks:false`, and the UI degrades. Resume/MCP/approval likewise.
- **Context-file mapping (Decision: "same markdown for different agents"):** each adapter is responsible for pointing its CLI's native context file at the **shared** goal docs — Claude reads `CLAUDE.md`, Codex reads `AGENTS.md`, Antigravity/Gemini reads `GEMINI.md`. Add an adapter method (e.g. `prepareContext(ctx): void`) that generates/symlinks the provider's context file from the shared `plan/research/notes/handoff/todo` set, so the same markdown drives any agent.

**Exit criteria:** A goal created with a Gemini/Codex model spawns the right CLI, its tokens/equivalent-value appear in Phase 2 analytics under the right provider, and the UI hides affordances those providers don't support. Same shared goal markdown drives a Claude goal and a Codex goal without rewriting.

---

## Phase 4 — Enable the stubbed features — MAP TO EXISTING DESIGNS

Independent of each other; can interleave with Phases 2–3.

- **4A. Approval enforcement.** Today `hook-ingest.ts` returns `decision:'allow'` immediately and the built `GlobalApprovalQueue`/`ApprovalCard` UI is never mounted in `AppShell`. Either make supervised goals actually call `ApprovalCoordinator.request()` and mount the queue, or remove the dead machinery. **The orchestrator (Phase 6) assumes approvals can block — decide here, before then.** Gated by capability matrix (`canApprove`). NEEDS short plan.
- **4B. Trace subsystem.** Mount `createTraceRouter` in `index.ts`, instantiate `TraceWriter` in `PtyManager`, populate `trace_dir` on session insert, schedule `pruneTraces` (the `tracePruneDays` config now persists). User confirms this is a known initial-design stub, not drift. NEEDS short plan.
- **4C. Interrupt + home-route.** `POST /goals/:id/interrupt` currently returns `{killed:true}` without touching `processRegistry` — wire it to the real runner (also a prerequisite the orchestrator relies on). `routes.tsx` hardcodes `/board`; read `config.homeRoute` (now persisted) for the index route. Small; fold into Phase 1 tail or a cleanup plan.
- **4D. Markdown view+edit.** Execute `2026-06-08-markdown-view-edit-design.md` — it was explicitly blocked on settings persistence, which Phase 1 delivers. NEEDS plan (its design exists).

**Exit criteria:** No feature advertised in the UI/README is a silent no-op. Approvals either enforce or are gone. Trace files write and prune. Interrupt actually kills.

---

## Phase 5 — Robustness & safety (review suggestions) — NEEDS PLANS

Order within phase by dependency. **Depends on:** Phase 0B (auth), Phase 1 (adapter).

- **5A. Project registry.** Register known repos with per-project defaults (allowed models, permission mode, done-command, worktree root). Doubles as the **`cwd` allow-list** Phase 0B needs and a grouping dimension for board + analytics. Build first in this phase.
- **5B. Workspace isolation + diff review.** Worktree-or-branch per goal; show branch/dirty-state on the goal card; a **diff view** as the completion artifact (+ optional "create PR"). This is the trust mechanism for autonomous multi-agent work and the precondition for two agents safely touching one repo.
- **5C. Verification gate on "complete."** Per-goal/per-project done-command (typecheck/test in the goal's workspace) runs when an agent finishes; pass/fail on the Kanban card and feeds the Phase 2 model scorecard. Turns "the agent says it's done" into evidence (the review's recurring failure mode).
- **5D. Session survivability.** Graceful drain on server shutdown (signal + persist), orphan-reconciliation + resume-on-boot via `buildResumeArgs` at startup. Cheap insurance for an "always-on" tool whose PTYs are server children.
- **5E. Budget/quota guardrails + quota-aware routing.** Per-goal/day cost caps that **pause** a session (work profile), burn-rate alarm, global kill switch, per-provider concurrency limits. Then the novel piece: the orchestrator/router consults Phase 2 window-utilization to route a job to a cooler provider ("Claude window hot → Codex"). Builds directly on Phase 2 bookkeeping.
- **5F. Shared-markdown write attribution.** Once 2+ agents can edit the same `handoff.md`, add last-write-wins detection + per-edit attribution (`written by goal-42/codex`). Convention + file watcher; cheap now, painful after corruption.

**Exit criteria:** Two goals can run against one repo without trampling; a finished goal shows a diff + done-command result; a server restart doesn't silently kill live agents; a runaway autonomous loop hits a cap instead of the wallet.

---

## Phase 6 — Orchestrator "Hawat" (capstone) — CORE PLAN EXISTS; FACES NEEDS PLAN

**Scope:** The event-driven dispatcher. **Depends on:** Phase 4A (approvals real), Phase 1 (adapter + capabilities), Phase 4C (interrupt), ideally Phase 5E (governance/caps). **Existing plan:** `2026-06-08-orchestrator-core.md` (backend) — has a foundation-fallback seam so it can technically run earlier, but land it after the adapter + approvals are real. **NEEDS PLAN:** "Faces" Plan 2 — Discord channel adapter + in-app Orchestrator tab + persona Settings, consuming the core's REST routes + WS events.

**Exit criteria:** A trigger (owner message, approval, stall, scheduled fire) wakes a headless cost-effective brain that loads durable memory + live board snapshot, acts via MCP, mirrors transparently to an in-app chat + Discord, and idle-stops. Single-user locked across channels.

---

## 3. Dependency graph (text)

```
Phase 0A (model registry) ──┬─> Phase 1 (foundation: Tasks 2–10 + deltas A/B/C)
Phase 0B (auth/bind) ───────┘            │
                                         ├─> Phase 2 (analytics overhaul)
                                         │       └─> Phase 5E (quota-aware routing)
                                         ├─> Phase 3 (Antigravity + Codex adapters)
                                         ├─> Phase 4 (enable stubs: approvals/trace/interrupt/md-edit)
                                         └─> Phase 5 (registry → isolation/diff → verify → survive → budget → attribution)
Phase 4A (approvals) + Phase 1 + Phase 5E ──> Phase 6 (orchestrator core → faces)
```

## 4. New specs/plans to write (checklist, in order)

All bite-sized plans below are now **written** (2026-06-09) — paths in the ledger in §6.

- [x] Phase 0A plan — `2026-06-09-model-pricing-registry.md` — **IMPLEMENTED 2026-06-10** (branch `feat/phase-0a-model-pricing-registry`; 1048 tests green)
- [x] Phase 0B plan — `2026-06-09-security-hardening.md` — **IMPLEMENTED 2026-06-10** (same branch, 9 commits; full suite 1091 green)
- [x] Phase 1 — deltas A/B/C/D folded into `2026-06-06-agent-adapter-foundation.md` (new "Plan Revisions (2026-06-09)" section + per-task overrides)
- [x] Phase 2 — `2026-06-09-analytics-overhaul.md`
- [x] Phase 3 — `2026-06-09-antigravity-adapter.md` + `2026-06-09-codex-adapter.md` (each leads with its spec)
- [x] Phase 4 — `2026-06-09-enable-stubs.md` (4A/4B/4C inline; 4D markdown-edit design already exists, referenced)
- [x] Phase 5 — `2026-06-09-robustness-infra.md` (5A/5B/5D) + `2026-06-09-governance-guardrails.md` (5C/5E/5F)
- [x] Phase 6 — `2026-06-09-orchestrator-faces.md` (consumes the existing `2026-06-08-orchestrator-core.md`)

---

## 6. Cross-plan reconciliation (2026-06-09) — read before executing any phase

The 10 plans were written in parallel against §2's locked contracts. Three integration points the authors surfaced are settled here so executors don't re-decide them:

### 6.1 `/api/config` response carries TWO provider keys (no collision)
Foundation Task 8's response exposes both, with distinct names:
- **`providers: ProviderConfig[]`** — the persisted *records* (`id, enabled, billingMode, seatPriceUsdMonthly?, budget?`). Server-side consumers (analytics billing label, budget guardrails) read `ConfigService.getPersisted().providers`.
- **`catalog: AgentCatalogEntry[]`** — the *derived* catalog (`id, label, enabled, models, capabilities, authHint?`) from `buildCatalog(enabledIds)`. Client consumers (model pickers, capability-gated UI, orchestrator persona model list) read `catalog`.

Do **not** overload a single `providers` key for both. Phase 1 Task 10, Phase 4A, and Phase 6 all read `catalog`; Phase 2 and Phase 5E read `providers`.

### 6.2 Migration ledger (working branch is at 014; sibling `enabledProviders` artifacts are NOT on it)
Confirmed by multiple authors: `feat/multi-agent-foundation` has migrations **001–014** only. So **path (a) of Delta B is active** — define the `providers` record shape directly in foundation Task 2/3 at migration **015**; `016` is only needed if a branch carrying `enabledProviders: string[]` is merged first.

| # | Table / change | Plan |
|---|---|---|
| 015 | `app_config` (provider *records* directly) | Phase 1 (foundation Task 3) |
| 016 | *conditional* — rewrite `enabledProviders[]` → `providers[]` (only if a string-list 015 merges first) | Phase 1 Delta B |
| 017 | `session_model_usage` (per-model rows) | Phase 2 |
| 021 | `projects` + `goals.project_id` | Phase 5A |
| 022 | `goal_workspace` + `sessions.provider_session_id`/`workspace_path` | Phase 5B |
| 023 | `verification_results` | Phase 5C |
| 024 | `budget_state` | Phase 5E |

018–020 intentionally unused (adapters reuse `session_usage`; trace needs none — `sessions.trace_dir` exists since migration 001). Numbers are provisional: if execution order differs, bump in lockstep keeping the dependency order above.

### 6.3 Prerequisite seams (why every later plan ships independently)
Each post-Phase-1 plan hard-depends on the Phase 0A registry (`src/shared/agents/model-registry.ts`) and/or the Phase 1 deltas (`RawUsage.byModel`, `providers[]` records, `AgentAdapter.capabilities`/`prepareContext`), none of which are on the branch yet. Every author added a documented fallback seam (a local stub or a both-shapes config reader) and a STOP-and-report check at the dependency point, so a phase can be built and tested before its prerequisite merges — but the **intended order is Phase 0 → Phase 1 → everything else**. Do not skip the green-baseline + Phase 1 characterization tests; they are the safety net the whole refactor rides on.

### 6.4 External-CLI risk (Phase 3)
The Antigravity and Codex plans each begin with a **discovery spike** because `agy`/`codex` flags, transcript formats, and resume semantics are not knowable from this repo. The authors pre-spiked against proxies (`gemini` CLI; the local `~/.codex` store) and labeled every finding ✅verified vs ⚠️assumed. Re-verify the ⚠️ items against the real CLIs before trusting the parse code — especially Antigravity's cumulative-token dedup rule and whether Codex's headless `exec` supports MCP (if not, `canMcp=false`).

---

## 5. Self-Review (by plan author)

**Coverage of the user's request:** "features designed but not built" → Phases 1 (foundation), 3 (adapters), 6 (orchestrator), 4D (markdown edit). "Enable the stub features" → Phase 4 (approvals, trace, interrupt) + trace explicitly named. "Features you suggested" → Phase 5 (capability matrix moved earlier to Phase 1-C; project registry, isolation/diff, verification gate, survivability, budget/quota, attribution, context-file mapping in Phase 3). "Analytics: update list of models and pricing" → Phase 0A (registry + Fable 5) and Phase 2 (per-model, billing-aware, value multiplier). All four asks mapped.

**Decisions traceable:** every Phase cites the cross-cutting decision(s) (§2) it implements. The two corrections from conversation are encoded: dollars-always (not "never show dollars for seats") → Decision 2/3 + Phase 2; per-model attribution → Decision 4 + Delta A.

**Known risks called out inline:** sibling-branch `enabledProviders` reconciliation (Delta B, two-path); Fable-5 symptom may be ingestion-timing not just pricing (Phase 0A note — fix makes it loud regardless); orchestrator-core can run on the fallback seam but should wait for real approvals (Phase 6 depends-on); window-utilization is an estimate (Decision 3, labeled).

**Not bite-sized yet (by design):** Phases 2–6 are briefs; each needs its own `writing-plans` pass at phase start, when the prior phase's reality is known. Phase 0 + Phase 1 deltas are specified to execute.
