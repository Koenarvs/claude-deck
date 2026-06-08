# Always-On Orchestrator — Design Spec

**Status:** Design APPROVED — pending final spec read by user.
**Date:** 2026-06-08
**Topic:** A persistent, externally-reachable orchestrator agent ("Hawat") for Claude Deck.
**Builds on:**
- `2026-04-19-claude-deck-v1-design.md` — goals, sessions, MCP (10 tools), approval workflow, scheduler.
- `2026-06-06-agent-adapter-foundation-design.md` — the `AgentAdapter` interface, provider registry, and `model → provider` resolution this spec's "brain" rides on.

---

## 1. Purpose & Context

Claude Deck today is a cockpit that needs a pilot in the seat: a human must be at the dashboard to triage
approval requests, react to a stalled session, or kick off scheduled work. The plumbing — MCP orchestration,
cron scheduling, the approval workflow, and a Discord access skill — already exists. What's missing is the
**dispatcher**: an always-available agent that ties those pieces together and is reachable from outside the
dashboard (phone, Discord) so the control plane can run itself and ping a human only when one is genuinely
needed.

This spec defines that orchestrator: a **named, persistent, transparent** assistant (carrying over the
"Hawat" identity from the user's Open Claude setup) that is **event-driven** (wakes on triggers, not a
perpetual loop), **billed against a subscription CLI seat** (not a metered API key), and **provider-pluggable**
via the existing `AgentAdapter` foundation (Claude Code now; Antigravity / Gemini Flash later).

### Why event-driven and not a persistent heartbeat loop
A literal "Open Claw" heartbeat — one long-lived process holding context and self-polling forever — is the
exact failure mode documented in `ORCHESTRATION-STATUS.md` (long-lived agents stall, the stream watchdog kills
them, and they "lie about completeness on stall"). It also burns tokens while idle and is the most TOS-fraught
posture. Instead, **"always-on" is a property of the server** (already up 24/7), not of a perpetually-thinking
agent. The orchestrator wakes on a real trigger, loads its memory + a live snapshot of the board, reasons,
acts, and the process exits on idle. Continuity lives in storage, not in a live process.

---

## 2. Locked decisions (from brainstorming)

1. **Event-driven dispatcher**, not a persistent self-polling loop. Process is disposable; state is durable.
2. **Subscription CLI seat** is the brain's billing model — *no metered API key* (the user explicitly rejects
   adding a variable cost on top of existing flat-rate LLM spend). Cost-effective model tier (Haiku, later
   Gemini Flash) is the default.
3. **Provider-pluggable** via the `AgentAdapter` foundation. Claude Code CLI today; Antigravity/Gemini Flash
   when Spec B's adapter lands — the orchestrator chooses its brain by *model value*, so no orchestrator change
   is required to switch providers.
4. **Discord first**, with a **channel-adapter interface** so Slack/Teams slot in later untouched.
5. **Single-user lock across all channels** — the external surface authenticates to the owner only. (This is
   also TOS guardrail #1: never serve third parties on a subscription seat.)
6. **Human-in-the-loop on approvals/stalls, with a recommendation.** The orchestrator *reviews* the situation,
   forms a *reasoned recommendation*, presents situation + recommendation + options; the human ratifies. No
   auto-approve allowlist in v1.
7. **Transparency is a product principle.** No hidden agents. The orchestrator has a **visible, persistent
   in-app chat surface**; every action it takes is observable there and in the existing trace/feed system.
8. **Persistent state, disposable process.** A durable **memory file** + chat history survive idle-stop and
   restart; the process **idle-stops after ~10 min** of no triggers (tunable).
9. **The orchestrator can spawn goals and sub-orchestrators** (inherent to the MCP), with governance — see §6.
10. **Persona is configurable in Settings.** The name (and identity framing) defaults to **"Hawat"** for the
    current owner but is a user-editable setting, so future users name their own assistant — no hardcoded
    identity.

---

## 3. Architecture overview

### Two faces, one brain
There is **one orchestrator**, reachable through two front-ends that share a single conversation thread and a
single memory file:

- **In-app Orchestrator tab** — a persistent chat surface in Claude Deck. The transparency guarantee: every
  message, recommendation, tool call, and spawned session is visible here in real time.
- **Discord** (single-user locked) — the remote front-end to the *same* conversation. Messages on Discord and
  in the tab are one thread.

Both faces post into the same `OrchestratorService`, which is the only thing that talks to the brain.

```
                    ┌─────────────────────────────────────────┐
  Discord (DM) ─────►                                          │
  In-app chat ──────►        OrchestratorService               │
  Scheduler fire ───►   (trigger queue · lifecycle · mirror)   │
  Approval/stall ───►                                          │
  Heartbeat sweep ──►                                          │
                    └───────────────┬─────────────────────────┘
                                    │ on trigger (cold-start if idle)
                                    ▼
                     load memory.md + live state snapshot
                                    │
                                    ▼
                 spawn HEADLESS bounded brain run via AgentAdapter
                  (claude -p --model haiku, claude-deck MCP attached)
                                    │
              ┌─────────────────────┼─────────────────────────┐
              ▼                     ▼                          ▼
      act via MCP tools     stream output to both faces   update memory.md
   (goals/sessions/etc.)      (transparency)                (durable state)
                                    │
                                    ▼
                          run exits · idle timer resets
```

---

## 4. Components

### 4.1 `OrchestratorService` (server) — the dispatcher
A new module in the Express server. Single owner of:
- the **trigger queue** (serialized — one brain run at a time to keep the conversation coherent and avoid
  racing the rate limit),
- the **lifecycle/idle-stop** state machine (§7),
- **mirroring** the run's streamed output to both faces (chat tab via WebSocket, Discord via the channel
  adapter),
- assembling the **context bundle** (§4.6) for each wake.

Designed with a clean interface so it can later be extracted into a standalone sidecar process (deferred, §13)
without changing callers.

### 4.2 Trigger sources (what wakes it)
1. **Owner message** — from the in-app tab or Discord.
2. **Approval request or stall** from a supervised session (subscribe to the existing approval workflow's event
   path + a PtyManager idle/exit signal).
3. **Scheduled task fires** — the existing `node-cron` scheduler routes designated tasks to the orchestrator
   instead of (or in addition to) raw goal creation.
4. **Heartbeat sweep** — a cheap `node-cron` tick (~every 2–5 min) that (a) catches any state the event hooks
   missed, and (b) drives the idle-stop decision. This is the *only* periodic element, and it does **no model
   work** unless it finds something actionable.

### 4.3 The brain (via `AgentAdapter`, headless)
The orchestrator's reasoning runs as a **headless, bounded one-shot** invocation through the existing provider
abstraction:
- Provider + model chosen by **model value** (`haiku` → `ClaudeAdapter` today; `antigravity` → Gemini-backed
  adapter when Spec B lands). Default tier is cost-effective (Haiku / Flash).
- Invocation is **print/headless mode** (`claude -p`), *not* a long-lived PTY session — this is the
  TOS-defensible, watchdog-resistant shape. Each run is bounded and exits.
- The **claude-deck MCP server is attached** (`SpawnContext.mcpServer`), so the brain acts through the *same*
  10 public MCP tools any session uses — nothing bespoke and invisible.

> **Adapter touchpoint (for the implementation plan):** the foundation's `AgentAdapter` is oriented around PTY
> *sessions*; the orchestrator needs a **headless one-shot** invocation. This is expected to be a small additive
> capability (a print-mode arg builder / `promptStrategy: 'flag'` path), not an interface redesign. The plan
> must confirm the exact mechanism per adapter and keep it behavior-preserving for existing session spawns.

### 4.4 Discord adapter (single-user locked)
Reuses the existing Discord pairing/allowlist skill. Locked to the owner's identity only. Implements a small
**`ChannelAdapter` interface** (`receive(message) → trigger`, `send(text/blocks)`, `presence(status)`) so
Slack/Teams are later additive. Inbound messages from anyone other than the paired owner are dropped (logged).

### 4.5 In-app Orchestrator tab (UI)
A new persistent tab/surface rendering the orchestrator conversation: owner + orchestrator turns, inline
**recommendation cards** with ratify/deny/redirect controls for approval/stall events, a live indicator of
**what it's monitoring** (derived from the live snapshot), and a visible log of tool calls / spawned sessions.
The surface is titled with the **configured persona name** (§4.7). Chat history is persisted (survives reload
and idle-stop). This surface *is* the transparency contract.

### 4.7 Persona configuration (Settings)
The assistant's **name and identity framing** are a user setting, not a constant. Defaults to **"Hawat"** for
the current owner; future users set their own. The configured name is woven into the brain's system framing
(§4.6 context bundle) and used as the display name across the in-app tab and Discord. Lives in `AppConfig`
(§11) and is editable from the Settings "Agents"/Orchestrator section the foundation already introduces.

### 4.6 Memory & situational awareness (two distinct things)
- **Durable memory file** — `<dataDir>/orchestrator/memory.md`, markdown, mirroring the user's own
  tiered-memory habit. Holds: a running narrative of what it has done, standing instructions from the owner,
  and open threads awaiting a decision. **Loaded on every wake; updated as it acts.** This is what survives
  idle-stop/restart.
- **Live state snapshot** — reconstructed fresh from SQLite on each wake: active sessions + their states,
  pending approvals, recent goals, recent feed/trace events. This is *why* it wakes already knowing "what's
  happening" rather than from a stale cache — it reads the live board.

The wake-time **context bundle** = system framing + memory file + live snapshot + the triggering event +
recent chat turns.

---

## 5. Data flow — the wake cycle

1. A trigger lands on `OrchestratorService`'s queue. If the process is idle, **cold-start**.
2. Service assembles the context bundle (§4.6).
3. Service spawns a headless brain run via the resolved `AgentAdapter`, MCP attached, model = configured tier.
4. The run reasons and acts:
   - calls MCP tools to query/act on sessions and goals,
   - for an approval/stall trigger: produces a **recommendation** rather than acting unilaterally on
     consequential items,
   - updates `memory.md`.
5. The run's streamed output (assistant text + tool-use events) is **mirrored live** to the chat tab
   (WebSocket) and Discord (channel adapter) — transparency in real time.
6. The run exits. The idle timer resets. After the idle window with no new triggers, the service stops
   the process; all state remains in `memory.md` + SQLite.

---

## 6. Spawning goals & sub-orchestrators (governance)

Because the claude-deck MCP exposes `create_goal` / `create_goal_and_instruct` / `send_goal_instruction`, the
orchestrator **can** create new goals — including ones given orchestration-level directives, supervised or
autonomous. This is an inherent platform capability, not a bolt-on, and the spec embraces it. Governance keeps
it safe and transparent:

- **Visibility (no hidden agents).** Anything the orchestrator spawns is a first-class goal/session, visible on
  the board, in the feed, and noted in the orchestrator chat + `memory.md`. The orchestrator never spawns
  anything the dashboard can't see.
- **Inherited guardrails.** Spawned agents operate under the same four TOS guardrails (§8). Autonomous children
  still respect rate limits and keep the human in the loop for consequential/irreversible/outward-facing
  actions via the existing approval workflow.
- **Fan-out / depth backstop.** A configurable cap on (a) concurrent orchestrator-spawned children and (b)
  orchestration depth (a child spawning grandchildren), so a reasoning error can't trigger runaway spawning.
  Hitting the cap surfaces as a recommendation to the owner, not a silent expansion.
- **Rate-limit shared awareness.** Children consume the same subscription seat; the orchestrator treats the
  seat's window as a shared budget and queues rather than racing it (TOS guardrail #2).

---

## 7. Lifecycle & idle-stop

- **States:** `idle` (no process) → `waking` (cold-start, loading bundle) → `active` (run in flight) →
  `cooling` (run done, idle timer running) → back to `idle` on timeout.
- **Idle timeout:** default **10 min** (config-driven, tunable).
- **Cold-start cost** is just reading `memory.md` + a SQLite snapshot — cheap. The user explicitly accepts
  idle-stop, and it doubles as TOS guardrail #4 (the seat is never held artificially alive).
- **Crash/restart recovery:** on server start, the service rehydrates from `memory.md` + chat history; no live
  process state is assumed.

---

## 8. TOS guardrails (baked in, non-negotiable)

The subscription-seat path is a deliberate "skate the edge, don't cross it" choice. The four lines:

1. **One person, one seat, own work.** External surface is single-user locked (§4.4). Never a public bot that
   serves model output to third parties.
2. **Respect rate limits; queue, don't circumvent.** When the seat's usage window is exhausted, the dispatcher
   *queues and waits*. It never spins up a second identity/account to dodge a cap.
3. **Human-in-the-loop on consequential actions** via the existing approval workflow (§ guardrail applies to
   the orchestrator and all spawned children).
4. **Disposable bounded runs; no held-alive seat** (§7) — headless one-shots that exit, indistinguishable from
   the owner firing off short Claude Code commands by hand.

Switching to Gemini Flash / Antigravity later changes the *provider*, not these four principles.

---

## 9. Transparency principle

A first-class design constraint, not a feature: **no hidden agents, ever.** Concretely —
- the orchestrator's reasoning output is streamed to a visible surface as it runs;
- it acts only through the public MCP tools (which the existing trace system already records);
- everything it spawns is a visible goal/session;
- `memory.md` is a plain, human-readable file the owner can open at any time.

---

## 10. Error handling

- **Watchdog discipline** (from `ORCHESTRATION-STATUS.md` lessons): headless runs are bounded; never invoke a
  watch-mode or long-lived subprocess from inside a run; emit progress so the stream stays alive; abort a run
  that produces no output past a threshold and report it to the owner rather than hanging.
- **Rate-limit backoff:** on a 429 / window-exhausted signal, the dispatcher pauses the queue, notifies the
  owner ("paused until window resets"), and resumes — never escalates to another account.
- **Brain run failure:** a failed/aborted run is surfaced in the chat with the error; the trigger can be
  retried by the owner. `memory.md` is only updated on a clean finish (or via an explicit, narrow write) so a
  crash can't corrupt durable state mid-thought.
- **Discord outage:** the in-app tab remains the source of truth; messages queue and reconcile on reconnect.

---

## 11. Data model & persistence

- **`orchestrator_messages`** (new table): the persisted chat thread (role, content, channel-origin,
  tool-call refs, timestamp). Powers both faces and survives idle-stop.
- **`orchestrator_state`** (new single-row table): lifecycle status, last-wake timestamp, current run handle,
  config (idle timeout, fan-out/depth caps, default model tier).
- **`<dataDir>/orchestrator/memory.md`** (file on disk): the durable narrative memory. File, not table, because
  it is human-readable/editable by design and mirrors the user's existing markdown-memory habit.
- **Config** rides on the foundation's `AppConfig` JSON blob (`config-service.ts`) — add orchestrator settings
  (enabled, **persona name / identity framing** (default `"Hawat"`), default model tier, idle timeout,
  fan-out/depth caps, paired Discord identity) there, surfaced in the Settings Orchestrator section.

---

## 12. Testing strategy

TDD per `superpowers:test-driven-development`.
- **Trigger queue / lifecycle:** state-machine unit tests (idle→wake→active→cooling→idle; serialization; crash
  rehydrate). Use a **fake brain** (no real CLI) that returns scripted output.
- **Context bundle assembly:** given a seeded DB + a `memory.md` fixture, the bundle contains the expected
  snapshot + memory + event.
- **Channel adapter:** single-user lock drops non-owner messages; outbound formatting; a `MockChannelAdapter`
  exercises the interface without Discord.
- **Recommendation flow:** an approval/stall trigger produces a recommendation card with ratify/deny/redirect;
  ratify relays the decision back through the approval workflow.
- **Governance:** fan-out and depth caps enforced; hitting a cap surfaces a recommendation, not a silent spawn.
- **Memory durability:** memory written on clean finish, not on crash; rehydrate-on-restart restores thread +
  monitoring state.
- **Provider pluggability:** with a `MockAdapter` (from the foundation's fixtures), the orchestrator resolves
  brain provider by model value and would switch to a second provider with no orchestrator code change.
- **Regression:** existing session/approval/scheduler/MCP tests stay green.

---

## 13. Out of scope (YAGNI for v1)

- **Multi-user / team access** — single-user only.
- **Slack / Teams adapters** — the `ChannelAdapter` interface is designed for them; only Discord is built.
- **Sidecar extraction** — `OrchestratorService` is interface-clean for it, but it ships inside the Express
  server for v1.
- **Auto-approve allowlist** — owner ratifies every consequential call (locked decision #6). May revisit later.
- **The Antigravity/Gemini adapter itself** — provided by the agent-adapter follow-on (Spec B); this spec only
  consumes the abstraction.

> Note: orchestrator-spawned goals / sub-orchestrators are **in scope** (§6) — they're inherent to the MCP, and
> the value lies in governing them, not forbidding them.

---

## 14. Open questions (resolve in the plan)

1. **Headless invocation mechanism per adapter** — exact `claude -p` arg shape (output format for streaming,
   model flag, MCP attach) and how it generalizes to Antigravity. (§4.3 touchpoint.)
2. **Memory-write mechanism** — a dedicated narrow MCP tool (`orchestrator_remember`) vs. a constrained direct
   file write by the run. Narrow tool is cleaner for transparency/tracing; confirm in the plan.
3. **Scheduler routing** — do scheduled tasks invoke the orchestrator as their handler, or does the orchestrator
   merely observe goals the scheduler creates? (Affects how cron work is "handled by the orchestrator," which
   was an original requirement.)
4. **Default idle timeout & fan-out/depth cap values** — 10 min is the working default; pick initial caps.
5. **Discord transport** — reuse the existing Discord skill's bot/token plumbing directly, or a dedicated
   gateway listener in the server? (Single-user lock is required either way.)

---

## 15. Risks & mitigations

- **TOS posture drifts** (e.g., a future "let a teammate DM it" request) → single-user lock is enforced in code
  and called out as guardrail #1; loosening it is a deliberate, reviewed change.
- **Runaway spawning** from a reasoning error → fan-out/depth backstop (§6) + serialized queue.
- **Watchdog stalls** (the documented v1 pain) → bounded headless runs, no watch-mode, progress emission,
  abort-on-silence (§10).
- **Rate-window exhaustion** mid-task → queue-and-wait with owner notification, never multi-account (§8/§10).
- **Memory corruption** on crash → durable write only on clean finish; human-readable file is recoverable by
  hand if needed.
- **Cost surprise** despite Haiku tier → cost shows in existing analytics; idle-stop bounds idle burn to ~zero.
