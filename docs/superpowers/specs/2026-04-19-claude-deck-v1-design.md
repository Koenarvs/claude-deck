# claude-deck v1 — Design Spec

**Date:** 2026-04-19
**Status:** Draft — pending final review
**Predecessor:** `claude-monitor` (weekend prototype at `C:\Users\Koena\claude-monitor`)

## 1. Goals, context, constraints

### 1.1 Why we're building this

`claude-monitor` is the prior weekend experiment. It uses `@anthropic-ai/claude-agent-sdk`'s in-process `query()` to spawn and control Claude Code sessions. Two structural problems surfaced:

1. **Permission request bug.** The SDK does not reliably fire `PermissionRequest` hooks on every tool use, so supervised-mode approvals are unreliable.
2. **Feature parity lag.** Slash commands, plan mode, output styles, and other CLI affordances require reimplementation through SDK options; they don't come "for free."

`claude-deck` is v2. Not a migration — a fresh architecture that uses the `claude` CLI as a subprocess rather than the SDK as a library, and adds a passive observer layer via native CLI hooks.

### 1.2 The three-paradigm framing

Three distinct architectural models for a Claude Code dashboard exist. `claude-deck` combines the two that matter:

- **Observer** (e.g., `Claude-Code-Agent-Monitor`): passive listener; user runs `claude` in a terminal; native hooks POST events to a dashboard; dashboard never spawns or controls.
- **SDK controller** (current `claude-monitor`): active control via `@anthropic-ai/claude-agent-sdk`; the pain point.
- **CLI wrapper** (Agentic-OS-style): active control via subprocess of the `claude` CLI with `stream-json` IPC; full feature parity.

`claude-deck` = CLI wrapper (for dashboard-spawned goals) + observer hooks (for ambient awareness of all other claude sessions on the machine) + a unified UI that treats goals as first-class tracked objectives rather than disposable chats.

### 1.3 Scope for v1

Build target: 8-10 hours of wall-clock work with aggressive parallel-agent decomposition.

**In scope:**
- CLI subprocess wrapper with stream-json IPC
- Goal data model, CRUD, state machine
- Hybrid hook layer (observer + approval gate + plan pane feed)
- Kanban board (primary UI), dashboard (secondary UI), goal detail split view, sessions list, activity feed, analytics, scheduler, settings
- Trace capture (per-session JSONL archives + download API) for Karpathy-style self-improvement loops
- MCP server exposing dashboard ops as tools
- Docker + PM2 + PWA manifest (installable web app via Chrome)
- Carry-over components from claude-monitor (folder browser, spawn dialog, settings panel, skills/extensions panels, CLAUDE.md editor, message stream, input bar)

**Out of scope for v1 (deferred):**
- In-UI trace viewer (download JSONL works for now)
- Trace diff / replay tooling (belongs in separate analysis toolkit)
- LAN / phone access, auth, TLS (use Tailscale when needed)
- Native desktop shell (web app + PWA is sufficient; Tauri wrap is a later 1-2h job)

### 1.4 Explicitly cut (SDK-era dead weight)

- SDK-based session runner (`server/session-runner.ts` in claude-monitor)
- `ApprovalBanner` per-session UI (approvals move to a global queue)
- SDK-specific compaction detection
- Cross-session context prefix injection (was an SDK workaround)

### 1.5 Non-goals

- Replace the `claude` CLI's built-in UX. `claude-deck` is a control plane, not a terminal replacement.
- Multi-user / team collaboration features. Single-operator, single-machine.
- Cloud deployment. Local-first by construction.

## 2. Architecture overview

### 2.1 Runtime topology

```
┌─────────────────────────────────────────────────────────────────┐
│                    Browser (React 19 + Vite)                    │
│  Kanban board · Goal detail (msgs | plan) · Feed · Settings     │
└──────────────▲─────────────────────────▲────────────────────────┘
               │ WebSocket               │ HTTP REST
               │                         │
┌──────────────┴─────────────────────────┴────────────────────────┐
│              Express server (TS, port 4100)                     │
│                                                                 │
│  ┌──────────────┐  ┌─────────────────┐  ┌──────────────────┐    │
│  │ GoalManager  │  │ HookIngest      │  │ SessionRunner    │    │
│  │ CRUD + state │  │ POST /hook/*    │  │ spawn claude CLI │    │
│  │ Kanban query │  │ broadcast +     │  │ stream-json IPC  │    │
│  │              │  │ block on approv │  │ resume support   │    │
│  └──────┬───────┘  └────────┬────────┘  └─────────┬────────┘    │
│         │                   │                     │             │
│         ├──────── TraceWriter (JSONL append) ─────┤             │
│         │                   │                     │             │
│         └───────────────────┴─────────────────────┘             │
│                         SQLite (goals, messages, events)        │
└─────────────────────────────────────────────────────────────────┘
               ▲                                       ▲
               │ PreToolUse/PostToolUse                │ stdin/stdout
               │ hook HTTP calls                       │ stream-json
               │                                       │
       ┌───────┴───────────┐                ┌──────────┴──────────┐
       │ ANY claude session│                │ claude (spawned)    │
       │ (terminal/IDE/us) │                │ per-goal subprocess │
       └───────────────────┘                └─────────────────────┘
```

### 2.2 Key design choices

- **Subprocess per turn.** For v1 we assume the `claude` CLI exits after each `result` event (the documented `--print` behavior). On user follow-up, we spawn a new subprocess with `--resume <session_id>`, which rehydrates the prior context. Open question §16.2 asks whether `--input-format stream-json` allows multi-turn within one process; if yes we upgrade to long-running in v1.1 without breaking the interface.
- **Hooks installed globally in `~/.claude/settings.json`** do triple duty: observer, approval gate, plan pane feed. One mechanism, three wins. Global scope means dashboard-spawned *and* terminal-spawned sessions both emit events to claude-deck with no per-session configuration.
- **Goals outlive sessions.** A goal can span multiple spawned sessions (close the subprocess, reopen later with `--resume`). External sessions (from a user's terminal) can be adopted into a goal post-hoc.
- **Trace files on disk are the source of truth for raw events.** SQLite holds queryable state; filesystem holds byte-level fidelity. Self-improvement loops read the trace.
- **Single Express server, one SQLite file, one WS channel.** Monolith by choice for v1 — deferral of service splits until operational complexity justifies them.

### 2.3 Stack

**Backend:** Node.js ≥22, TypeScript (strict, `noImplicitAny`), Express 5, `ws`, `better-sqlite3`, `node-cron`, `pino`, `zod`, `uuid`.

**Frontend:** React 19, Vite 6, Tailwind CSS v4, TypeScript, React Router v7, Zustand (state), `react-window` (virtualized lists), `recharts` (analytics), `lucide-react` (icons), `zod` (payload validation).

**MCP package (`mcp/`):** Standalone Node package depending on `@modelcontextprotocol/sdk`.

**Tooling:** `vitest`, `@testing-library/react`, `@playwright/test`, `prettier`.

**Deployment:** Docker (reference), PM2 (long-running local), PWA manifest (Chrome "Install app").

## 3. Data model

SQLite at `<data_dir>/claude-deck.db`. Migration runner at `server/db/migrate.ts`; migrations in `server/db/migrations/*.sql`.

### 3.1 `goals`

User-curated objectives. Persistent; outlive sessions.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | uuid |
| `title` | TEXT NOT NULL | user-editable |
| `description` | TEXT | optional |
| `cwd` | TEXT NOT NULL | resolved absolute path |
| `status` | TEXT NOT NULL | `planning \| active \| waiting \| complete \| archived` |
| `priority` | INTEGER DEFAULT 0 | |
| `tags` | TEXT | JSON array of strings |
| `current_session_id` | TEXT | FK → sessions.id, nullable |
| `model` | TEXT | `opus \| sonnet \| haiku \| default` |
| `permission_mode` | TEXT | `autonomous \| supervised`, default `supervised` |
| `plan_json` | TEXT | rendered from latest `TodoWrite` |
| `kanban_order` | REAL | float for drag-insert without renumber |
| `created_at` | INTEGER | ms epoch |
| `updated_at` | INTEGER | |
| `completed_at` | INTEGER | |

Index: `(status, kanban_order)` for Kanban queries.

### 3.2 `sessions`

Every `claude` invocation, dashboard-spawned or external.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | claude's `session_id` from hook init or from `--session-id` flag |
| `goal_id` | TEXT | FK → goals.id, nullable (external sessions have none unless adopted) |
| `origin` | TEXT NOT NULL | `dashboard \| external` |
| `cwd` | TEXT | |
| `model` | TEXT | |
| `trace_dir` | TEXT | absolute path to per-session trace dir |
| `stream_event_count` | INTEGER DEFAULT 0 | |
| `hook_event_count` | INTEGER DEFAULT 0 | |
| `stderr_bytes` | INTEGER DEFAULT 0 | |
| `total_cost_usd` | REAL | |
| `total_tokens_in` | INTEGER | |
| `total_tokens_out` | INTEGER | |
| `started_at` | INTEGER | |
| `ended_at` | INTEGER | |

Index: `(goal_id, started_at)`, `(origin, started_at)`.

### 3.3 `messages`

Per-session chat log; source for UI rendering.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | uuid |
| `session_id` | TEXT NOT NULL | FK |
| `role` | TEXT | `user \| assistant \| system \| tool_use \| tool_result` |
| `content` | TEXT | truncated for display — full content lives in trace files |
| `tool_name` | TEXT | for tool_use / tool_result |
| `tool_args` | TEXT | JSON |
| `tool_result` | TEXT | truncated to 4000 chars for DB; full in trace |
| `tool_use_id` | TEXT | correlates tool_use → tool_result |
| `token_in` | INTEGER | |
| `token_out` | INTEGER | |
| `created_at` | INTEGER | |

Index: `(session_id, created_at)`.

### 3.4 `hook_events`

Raw log of every hook fire. Feeds the `/feed` page and external session discovery.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | |
| `session_id` | TEXT | from hook payload |
| `event_type` | TEXT | `SessionStart \| PreToolUse \| PostToolUse \| UserPromptSubmit \| Stop \| …` |
| `tool_name` | TEXT | nullable |
| `payload_json` | TEXT | full hook payload |
| `created_at` | INTEGER | |

Index: `(session_id, created_at)`, `(event_type, created_at)`.

### 3.5 `approvals`

Pending / resolved tool approvals.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | |
| `session_id` | TEXT | |
| `goal_id` | TEXT | nullable if external session |
| `tool_name` | TEXT | |
| `tool_args` | TEXT | JSON |
| `status` | TEXT | `pending \| approved \| denied \| timeout` |
| `decided_reason` | TEXT | optional |
| `requested_at` | INTEGER | |
| `resolved_at` | INTEGER | |

### 3.6 `scheduled_tasks`

Cron-driven goal templates.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | |
| `name` | TEXT NOT NULL | |
| `cron_expr` | TEXT NOT NULL | standard cron syntax |
| `goal_template_json` | TEXT NOT NULL | `{title, cwd, model, initialPrompt, tags?}` |
| `enabled` | INTEGER DEFAULT 1 | bool |
| `last_run_at` | INTEGER | |
| `next_run_at` | INTEGER | |
| `created_at` | INTEGER | |

### 3.7 `trace_index`

Optional fast-lookup index into stream.jsonl files. Not required for v1; include only if time permits.

| Column | Type | Notes |
|---|---|---|
| `session_id` | TEXT | PK part 1 |
| `offset` | INTEGER | byte offset in stream.jsonl; PK part 2 |
| `event_type` | TEXT | |
| `tool_name` | TEXT | |
| `timestamp` | INTEGER | |

## 4. File system layout

```
<data_dir>/
  claude-deck.db                 # SQLite
  config.json                    # mutable runtime config
  traces/
    <session_id>/
      stream.jsonl               # raw stream-json events from CLI stdout
      hooks.jsonl                # raw hook payloads
      stderr.log                 # CLI stderr
      meta.json                  # session metadata
  backups/                       # periodic DB snapshots (future)
```

Default `data_dir`: `./data/` relative to install. Configurable in `config.json`.

## 5. HTTP API

All endpoints validate bodies with zod schemas from `src/shared/schemas.ts`. Responses are JSON. CORS: localhost-only.

```
# Goals
POST   /api/goals                    body: CreateGoalInput          → Goal
GET    /api/goals                    query: status?, tag?           → Goal[]
GET    /api/goals/:id                                                → GoalDetail { goal, messages, plan }
PATCH  /api/goals/:id                body: UpdateGoalInput          → Goal
DELETE /api/goals/:id                                                → { archived: true }
POST   /api/goals/:id/messages       body: { prompt, modelOverride? } → { session_id }
POST   /api/goals/:id/interrupt                                      → { killed: true }
POST   /api/goals/:id/adopt-session  body: { session_id }           → Goal

# Sessions
GET    /api/sessions                 query: origin?, active?, limit?, offset? → Session[]
GET    /api/sessions/:id             → Session
GET    /api/sessions/:id/messages    query: limit?, before?         → Message[]

# Hook ingest (called by claude CLI via hook client script)
POST   /api/hook/session-start
POST   /api/hook/user-prompt-submit
POST   /api/hook/pre-tool-use        → blocks up to 30m; returns { decision: "allow"|"deny", reason? }
POST   /api/hook/post-tool-use
POST   /api/hook/stop

# Approvals (UI-driven)
GET    /api/approvals                query: status?                 → Approval[]
POST   /api/approvals/:id/decide     body: { decision, reason? }    → Approval

# Trace
GET    /api/goals/:id/trace                                          → tar stream of all session trace dirs
GET    /api/sessions/:id/trace/stream                                → stream.jsonl
GET    /api/sessions/:id/trace/hooks                                 → hooks.jsonl
GET    /api/sessions/:id/trace/bundle                                → tar.gz of the session's trace dir

# Config + introspection
GET    /api/config                                                   → Config
PUT    /api/config                   body: Partial<Config>          → Config
GET    /api/directories              query: path?                   → DirectoryListing
GET    /api/skills                                                   → Skill[]
GET    /api/extensions                                               → { mcp, plugins, hooks }
POST   /api/system/install-hooks                                     → { installed: true }
POST   /api/system/uninstall-hooks                                   → { uninstalled: true }

# Scheduler
GET    /api/scheduled-tasks                                          → ScheduledTask[]
POST   /api/scheduled-tasks          body: CreateScheduledTaskInput → ScheduledTask
PATCH  /api/scheduled-tasks/:id      body: UpdateScheduledTaskInput → ScheduledTask
DELETE /api/scheduled-tasks/:id                                      → { deleted: true }
POST   /api/scheduled-tasks/:id/run-now                              → { goal_id }

# Analytics
GET    /api/analytics/tokens         query: from, to, groupBy       → TokenSeries
GET    /api/analytics/tools          query: from, to               → ToolFrequency
GET    /api/analytics/heatmap        query: from, to               → HeatmapData
GET    /api/analytics/cost           query: from, to, groupBy       → CostSeries
```

### 5.1 Hook request/response contract

Hooks call `POST /api/hook/pre-tool-use` with payload:

```json
{
  "session_id": "uuid",
  "tool_name": "Bash",
  "tool_input": {"command": "ls", "description": "list files"},
  "cwd": "/path",
  "timestamp": 1700000000000
}
```

Server responds within 30 min (default):
```json
{"decision": "allow"}
```
or
```json
{"decision": "deny", "reason": "user declined"}
```

Hook client script exits 0 on allow, exits 2 with stderr = reason on deny. On HTTP timeout or server unreachable: **fail-open**, exit 0, log warning. Rationale: never freeze the user's CLI because the dashboard crashed.

## 6. WebSocket contract

Endpoint `/ws`. Server-push only; client messages are subscription management.

### 6.1 Server → client events

```typescript
type ServerEvent =
  | { type: "goal:created"; goal: Goal }
  | { type: "goal:updated"; goal: Goal }
  | { type: "goal:status"; id: string; status: GoalStatus; current_session_id: string | null }
  | { type: "goal:plan-updated"; id: string; plan_json: PlanJson }
  | { type: "message:added"; goal_id: string | null; session_id: string; message: Message }
  | { type: "approval:pending"; approval: Approval; goal_id: string | null }
  | { type: "approval:resolved"; id: string; decision: "approved" | "denied" | "timeout" }
  | { type: "session:observed"; session: Session }
  | { type: "session:ended"; id: string }
  | { type: "hook:event"; event: HookEvent }
  | { type: "subprocess:error"; goal_id: string; error: string }
  | { type: "ping" };
```

### 6.2 Client → server messages

```typescript
type ClientMessage =
  | { type: "subscribe"; goals: string[] | "all" }
  | { type: "unsubscribe" }
  | { type: "ping" };
```

Scope by goal to avoid sending irrelevant events to background tabs.

## 7. Subprocess wrapper (SessionRunner)

### 7.1 Spawn contract

```
claude
  --output-format stream-json
  --input-format  stream-json
  --session-id    <goal.id-or-new-uuid>       # first invocation only; reuse on resume
  --permission-mode default
  --model         <goal.model>
  [--append-system-prompt <optional goal context>]
  [--resume       <existing-session-id>]      # subsequent invocations
```

Working directory is **not** a CLI flag — it's set via `child_process.spawn(..., { cwd: goal.cwd })` when spawning the node subprocess.

Hooks are **not** scoped per session; they come from the global `~/.claude/settings.json` and fire for every claude invocation on this machine.

### 7.2 stdin protocol (server → CLI)

One JSON object per line:
```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<prompt>"}]}}
```

### 7.3 stdout protocol (CLI → server)

Line-delimited JSON. Parse each line with try/catch; log malformed lines, continue.

Relevant event types:
- `{type: "system", subtype: "init", session_id, ...}` — seed `sessions` row
- `{type: "assistant", message: {content: [block, ...]}}` — content blocks: `text`, `tool_use`, `thinking`
- `{type: "user", message: {content: [{type: "tool_result", ...}]}}` — tool results
- `{type: "system", subtype: "compact_boundary", compact_metadata}` — compaction event
- `{type: "result", subtype, total_cost_usd, num_turns, session_id}` — end-of-turn

### 7.4 Process lifecycle

```typescript
class SessionRunner {
  constructor(goal: Goal, deps: { traceWriter, messageService, goalService, broadcast })
  async start(initialPrompt: string): Promise<void>
  async sendFollowup(prompt: string): Promise<void>
  async interrupt(): Promise<void>
  async cleanup(): Promise<void>
}
```

`ProcessRegistry` is a `Map<goalId, SessionRunner>` in memory. Constraint: one subprocess per goal. Re-entering `start()` on an existing goal kills the current subprocess first.

**On server startup:** no auto-resume of prior subprocesses (they're dead). Goals with non-terminal `status` are set to `waiting` and await user re-engagement.

**On server SIGTERM / SIGINT:** kill all children via the registry, fsync trace files, close DB, exit.

### 7.5 Parser edge cases

| Case | Behavior |
|---|---|
| Malformed JSON line | Log line + parser error, continue |
| Unknown event type | Log debug, ignore |
| CLI stderr output | Appended to `<trace_dir>/stderr.log`; surface to UI only on non-zero exit |
| Subprocess exits non-zero mid-turn | Mark session `ended_at`, goal `status=error`, broadcast `subprocess:error` |
| stdin write after process exits | Swallow `EPIPE`, log, surface as "goal needs restart" |

## 8. Hook layer

### 8.1 What gets installed

`~/.claude/settings.json` gets our hooks merged in. Hooks are global (fire on every claude session) with fail-open semantics. Installed / removed via `POST /api/system/install-hooks` and `POST /api/system/uninstall-hooks`.

```json
{
  "hooks": {
    "SessionStart":     [{"hooks":[{"type":"command","command":"node <install_dir>/hooks/client.js session-start"}]}],
    "UserPromptSubmit": [{"hooks":[{"type":"command","command":"node <install_dir>/hooks/client.js user-prompt-submit"}]}],
    "PreToolUse":       [{"hooks":[{"type":"command","command":"node <install_dir>/hooks/client.js pre-tool-use"}]}],
    "PostToolUse":      [{"hooks":[{"type":"command","command":"node <install_dir>/hooks/client.js post-tool-use"}]}],
    "Stop":             [{"hooks":[{"type":"command","command":"node <install_dir>/hooks/client.js stop"}]}]
  }
}
```

The installer backs up the existing file, merges (preserving other hooks), and writes atomically.

### 8.2 `hooks/client.js` behavior

Pseudocode for the single-file hook script (target < 150 LOC):

```
event = argv[2]                              # e.g., "pre-tool-use"
payload = JSON.parse(readStdin())
payload.received_at = Date.now()

try {
  res = httpPostJson(`http://127.0.0.1:4100/api/hook/${event}`, payload, timeout=30*60*1000)
  if (event === "pre-tool-use") {
    body = res.json()
    if (body.decision === "deny") {
      console.error(body.reason || "Denied by claude-deck")
      process.exit(2)
    }
    process.exit(0)
  } else {
    process.exit(0)     // fire-and-forget for non-blocking hooks
  }
} catch (err) {
  # server unreachable or timeout → fail open
  console.error(`claude-deck hook unreachable: ${err.message}`)
  process.exit(0)
}
```

Zero external dependencies. Runs via Node's stdlib.

### 8.3 Approval coordinator (server-side)

```typescript
class ApprovalCoordinator {
  private pending: Map<string, Deferred<Decision>>  // keyed by approval.id
  
  async request(approval): Promise<Decision> {
    insert approval row (status=pending)
    broadcast approval:pending WS event
    
    if (goal.permission_mode === "autonomous") {
      update status=approved, resolve immediately
      return { decision: "allow" }
    }
    
    deferred = new Deferred<Decision>()
    this.pending.set(approval.id, deferred)
    
    timer = setTimeout(() => {
      if (pending.has(approval.id)) {
        update status=timeout
        pending.delete(approval.id)
        deferred.resolve({ decision: "deny", reason: "timeout" })
        broadcast approval:resolved
      }
    }, 30 * 60 * 1000)
    
    return deferred.promise
  }
  
  resolve(approvalId, decision, reason) {
    deferred = pending.get(approvalId)
    if (!deferred) return  // stale
    update approval row
    pending.delete(approvalId)
    clearTimeout(timer)
    deferred.resolve({ decision, reason })
    broadcast approval:resolved
  }
}
```

## 9. Trace capture

### 9.1 TraceWriter module

Per-session instance with three append streams open to `<trace_dir>/{stream,hooks,stderr}.{jsonl,log}`. Buffered writes (4KB chunks); fsync on session end (`result` event from CLI or server shutdown).

```typescript
class TraceWriter {
  constructor(sessionId: string, traceDir: string)
  appendStream(rawLine: string): void     // raw stream-json line
  appendHook(payload: object): void       // hook payload as JSON line
  appendStderr(chunk: string): void
  async close(): Promise<void>            // fsync + close
}
```

### 9.2 Fidelity requirement

**Binary acceptance test:** given a completed session, reading `stream.jsonl` and reconstructing the event sequence must produce byte-identical content blocks to what the CLI emitted. Truncation happens only in the `messages` table for display; trace files are untruncated.

### 9.3 Downstream enablement

The trace format is designed to be consumed by:
- Self-improvement tooling (e.g., Karpathy-style rollout analysis)
- Prompt / skill evaluation harnesses
- Replay testing with different model versions
- Debugging "what did the model see when it made that call"

`claude-deck` ships the capture and download. Analysis tools live elsewhere.

## 10. Frontend structure

### 10.1 Routes

```
/              → redirect to config.homeRoute (default /board)
/board         → KanbanPage (default home)
/dashboard     → DashboardPage
/goals/:id     → GoalDetailPage
/sessions      → SessionsListPage
/sessions/:id  → SessionDetailPage
/feed          → FeedPage
/analytics     → AnalyticsPage
/scheduled     → ScheduledPage
/skills        → SkillsPage (carry from claude-monitor)
/claude-md     → ClaudeMdPage (carry)
/settings      → SettingsPage (carry, extended)
```

A/B switch between Kanban-first and Dashboard-first homes: single config flag.

### 10.2 State (Zustand)

Stores: `useGoalsStore`, `useSessionsStore`, `useMessagesStore`, `usePlanStore`, `useApprovalsStore`, `useFeedStore`, `useConfigStore`, `useConnectionStore`.

A singleton `WSManager` connects on mount, dispatches WS events into stores by `event.type`.

### 10.3 Global UI

- `<GlobalApprovalQueue>` — floats top-right when approvals pending; visible on every route
- `<ConnectionIndicator>` — bottom-left, shows WS state
- Tab-title badge on approval pending
- Browser notifications API on approval pending (consent prompted once)
- Keyboard shortcuts: `Cmd/Ctrl+K` command palette; `G then B/D/F/A/S` goto; `Esc` close modals

### 10.4 Carry-over components (claude-monitor → claude-deck)

No refactor; import paths updated:
`FolderBrowser`, `SpawnDialog`, `SettingsPanel`, `SkillsBrowser`, `ExtensionsPanel`, `ClaudeMdPanel`, `ErrorBoundary`, `SubagentList`, `MessageBubble`, `MessageStream`, `InputBar`

Retired: `ApprovalBanner` (replaced by `<GlobalApprovalQueue>`).

## 11. MCP server (`mcp/`)

Standalone sibling package. Dependencies: `@modelcontextprotocol/sdk`, Node stdlib.

**Tools exposed:**
- `list_goals(status?, tag?)` — returns Goal[]
- `get_goal(id)` — returns GoalDetail
- `create_goal(title, cwd, model?, initialPrompt?, tags?)` — creates + spawns
- `send_message(goal_id, prompt)` — sends followup
- `list_sessions(origin?, active?)` — returns Session[]
- `get_session_messages(session_id)` — returns Message[]
- `schedule_task(name, cron_expr, goal_template)` — creates scheduled task

Transport: stdio. Registered in user's MCP config so any `claude` session can drive `claude-deck`.

**Integration pattern:** MCP tools call the dashboard's HTTP API at `http://127.0.0.1:4100/api/*` rather than reading SQLite directly. This keeps validation, business logic, and WebSocket broadcasts unified — an MCP-driven `create_goal` triggers the same `goal:created` broadcast as a UI-driven create. Reference CCAM's `mcp/` for package structure only; API integration pattern differs.

## 12. Deployment

### 12.1 Local dev

```
npm install
npm run dev     # concurrently runs server (tsx watch) + client (vite)
```

- Vite dev server: 5173 (proxies `/api` and `/ws` to 4100 via `vite.config.ts` `server.proxy`; WS requires `ws: true`)
- Express: 4100

### 12.2 Production local

```
npm run build
npm start              # or:  pm2 start ecosystem.config.cjs
```

In production, Express serves the built React app at `/` from `dist/client/`.

### 12.3 Docker

```
docker compose up
```

`Dockerfile` stages: deps → build → runtime (node:22-alpine). Volumes for `./data/` persistence.

### 12.4 PWA install

- `public/manifest.webmanifest` with name, icons (192, 512), `display: standalone`, `theme_color`
- `<link rel="manifest">` in `index.html`
- Chrome / Edge offers "Install app" for localhost URLs; install produces a windowed app with no browser chrome

### 12.5 First-run setup

```
1. npm install
2. npm run build
3. npm start
4. Open http://localhost:4100 (or install PWA)
5. Settings → Install Global Hooks → confirms write to ~/.claude/settings.json
6. Ready. Any `claude` session now reports to the dashboard.
```

## 13. Acceptance criteria

### 13.1 Functional acceptance (day-complete smoke test)

1. `docker compose up` on a fresh machine → UI at `localhost:4100`.
2. Create a goal via Kanban "+ New Goal" → subprocess spawns, initial prompt sent, assistant reply streams to UI within 10s.
3. Approve a `Bash` tool via the global approval queue → tool executes, result renders.
4. Run `claude` in a separate terminal in a different cwd → session appears in `/feed` within 1s, `session:observed` WS event fires.
5. Adopt that external session into an existing goal → future events from that session flow to the goal.
6. `POST /api/goals/:id/messages` via curl → follow-up turn executes through the existing subprocess.
7. Download a goal's trace → tar bundle; expand; `stream.jsonl` + `hooks.jsonl` contain the expected counts.
8. Schedule a task with cron `* * * * *` (every minute) → fires within 60s, creates a new goal.
9. MCP inspector `list_goals` → returns the goals present in SQLite.

### 13.2 Observability acceptance

- **Trace fidelity:** concatenate all `assistant` content-block text in `stream.jsonl` for a session; equals the sequence of assistant messages in UI.
- **Trace schema:** every message in `messages` table for a session has a corresponding event in `stream.jsonl` (by tool_use_id or position).
- **Trace replay:** re-reading `stream.jsonl` line-by-line produces no parse errors and recovers the exact event sequence.
- **Trace completeness:** for every hook fired during a session (as logged by the CLI), a corresponding event exists in `hooks.jsonl`.

### 13.3 Performance bars

| Metric | Target |
|---|---|
| Kanban render (50 goals) | < 200ms cold, < 50ms warm |
| WS event → UI render | < 100ms p95 |
| Message bubble render on WS event | < 100ms |
| Plan pane re-render on WS | < 100ms |
| Approval card appearance | < 500ms from WS event |
| Trace append throughput | sustain 1MB/s without blocking event loop |
| Hook HTTP response (autonomous mode — server auto-allows) | < 50ms |
| Hook HTTP response (supervised mode — waiting on user) | up to 30 min ceiling, then auto-deny |
| Feed page (10k events) scroll | ≥ 30fps |
| Analytics page (30 days) load | < 1s |

### 13.4 Safety / degradation

| Condition | Expected behavior |
|---|---|
| Server down, user runs `claude` in terminal | CLI works normally (fail-open) |
| SQLite locked | Hook endpoint responds allow + logs warning within 1s |
| Subprocess crash mid-turn | Goal → `error`, UI shows retry, no orphan process |
| WS disconnect | Client reconnects with exponential backoff, state preserved |
| Hook timeout (30m) | Auto-deny, row status=timeout |
| Malformed stream-json line | Logged, skipped, session continues |

### 13.5 Code quality bar

- Zero TypeScript errors (`npm run typecheck` clean)
- No `any` types in new code (lint rule enforced)
- All zod schemas in `src/shared/schemas.ts` are the single source of truth
- All inbound payloads (HTTP + WS) validate via zod before handling
- Every public function in server modules has a JSDoc describing contract
- Test coverage: every service module has a test file; every API route has a contract test; E2E Playwright covers acceptance §13.1

## 14. Build plan — parallel-agent decomposition

### 14.1 Foundation (sequential, ~1-1.5h, 1 agent)

F0 delivers the scaffold every other agent reads. No parallelism here — drift would propagate.

- **F0a Project scaffold:** `package.json`, tsconfig, vite, tailwind, .gitignore, .env.example
- **F0b Shared contracts:** `src/shared/types.ts`, `src/shared/schemas.ts`, `src/shared/events.ts`
- **F0c DB schema + migration runner:** `server/db/migrations/001_init.sql`, `server/db/migrate.ts`
- **F0d Server skeleton:** Express boot, route registry, pino, zod middleware, WS server, CORS
- **F0e Frontend skeleton:** React Router setup, AppShell, Zustand store scaffolding, WSManager singleton, dark theme tokens

**Foundation ACs:** `npm run typecheck && npm run build && npm test && npm run dev` all succeed; empty routes render; WS echoes ping.

### 14.2 Parallel Burst 1 — Backend services (6 agents, ~3-4h)

| ID | Agent | Key deliverable | Primary ACs |
|---|---|---|---|
| B1 | SessionRunner | `server/session-runner.ts`, `server/stream-parser.ts`, `server/process-registry.ts` | Spawns CLI; first assistant event within 5s; interrupt kills cleanly |
| B2 | Hook ingest + approvals | `server/routes/hooks.ts`, `server/approval-coordinator.ts`, `hooks/client.js` | PreToolUse blocks until decision; autonomous auto-allow; timeout auto-deny; fail-open verified |
| B3 | Goals service | `server/routes/goals.ts`, `server/services/goal-service.ts` | API contract tests pass; kanban_order insertion works; plan_json updates via service |
| B4 | Sessions service | `server/routes/sessions.ts`, `server/services/session-service.ts`, `server/services/message-service.ts` | Hook init creates session; external goal_id=NULL; adopt endpoint works |
| B5 | Trace writer + API | `server/trace-writer.ts`, `server/routes/trace.ts`, `server/services/trace-service.ts` | All B1/B2 events land in JSONL; bundle endpoint returns valid tar; fidelity test passes. `trace_index` table is stretch-goal (§3.7) — skip if pressed for time. |
| B6 | Scheduler | `server/scheduler.ts`, `server/routes/scheduled.ts` | Cron fires at scheduled time; run-now immediate; disabled tasks don't fire |

### 14.3 Parallel Burst 2 — Frontend pages (6 agents, ~3-4h)

| ID | Agent | Key deliverable | Primary ACs |
|---|---|---|---|
| F1 | Kanban page | `src/pages/KanbanPage.tsx`, `src/components/kanban/*` | 50 goals render < 200ms; drag between columns → PATCH fires; new-goal modal wires to SpawnDialog |
| F2 | Goal detail + Plan | `src/pages/GoalDetailPage.tsx`, `src/components/goal/*` | Message bubble < 100ms on WS; plan pane re-renders < 100ms; trace download streams |
| F3 | Dashboard + stats | `src/pages/DashboardPage.tsx`, `src/components/dashboard/*` | Live stats from WS; recent activity shows last 20 events |
| F4 | Sessions + detail | `src/pages/SessionsListPage.tsx`, `src/pages/SessionDetailPage.tsx`, `src/components/sessions/*` | Table sorts/filters for < 500 rows; session detail shows messages; trace download |
| F5 | Feed + Analytics | `src/pages/FeedPage.tsx`, `src/pages/AnalyticsPage.tsx`, `src/components/feed/*`, `src/components/analytics/*` | Feed 10k events @ 30fps; analytics 30d < 1s |
| F6 | Scheduled + Settings + carry-over | `src/pages/ScheduledPage.tsx`, `src/pages/SettingsPage.tsx`, `src/components/scheduled/*` | Cron picker validates; install-hooks button triggers installer; home-route toggle persists |

### 14.4 Parallel Burst 3 — Support/infra (4 agents, ~1-2h)

| ID | Agent | Key deliverable | Primary ACs |
|---|---|---|---|
| S1 | MCP server | `mcp/package.json`, `mcp/src/*` | Builds + runs; MCP inspector lists tools; `create_goal` writes row |
| S2 | Hook installer | `scripts/install-hooks.ts`, `scripts/uninstall-hooks.ts` | Merges into `~/.claude/settings.json`; idempotent; uninstall restores backup |
| S3 | Deploy + PWA | `Dockerfile`, `docker-compose.yml`, `ecosystem.config.cjs`, `public/manifest.webmanifest`, `public/icons/*` | `docker compose up` runs; Chrome "Install app" appears |
| S4 | Global UX | `src/components/global/*`, `src/lib/notifications.ts` | Approval floats globally; browser notification fires; tab badge updates |

### 14.5 Integration pass (serial, 2-3h)

One agent (or Jerry) after all bursts report done.

1. Merge F0 → main (already done).
2. Rebase-merge Burst 1 branches serially. Conflicts expected in `package.json`, `shared/types.ts` extensions, WS event registration. Resolve toward `shared/` as schema of record.
3. Rebase-merge Burst 2 branches serially.
4. Rebase-merge Burst 3 branches serially.
5. Run `npm run typecheck && npm test && npm run build` after each merge; fix breakage before moving on.
6. Run Playwright E2E covering §13.1.
7. Manual smoke test.
8. File `v1.1` issues for bugs that surface.

### 14.6 Per-agent handoff template

Each parallel agent receives:

```
SCOPE: <files/modules this agent owns>
CONTRACTS: <pointers to src/shared/types.ts + schemas.ts sections>
INTEGRATION POINTS: <which other agents' work this agent depends on or feeds>
ACCEPTANCE CRITERIA: <copied from §13 + §14.x, as failing tests>
QUALITY BAR: <no any, zod on boundaries, JSDoc on public surface, tests green>
FIRST COMMIT: failing test suite derived from ACs
FINAL COMMIT: green tests + implementation + PR description listing AC pass/fail
```

Written-plans skill (invoked after this spec is approved) produces one detailed per-agent plan per row in §14.2-14.4.

## 15. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Agents drift from shared contracts | `src/shared/*` is source of truth; CI fails if an agent re-defines a shared type locally |
| Integration hell with 16 branches | Merge burst-by-burst, not agent-by-agent; conflicts hit predictable seams |
| Feature gaps at integration | Accept scope slip; defer a page to v1.1 rather than descoping the wrapper |
| CLI version drift breaks stream-json | Pin a tested `claude` CLI version in README; document upgrade procedure |
| Hook installation conflicts with user's existing hooks | Installer merges, doesn't replace; backup on every change |
| Subprocess orphaning | ProcessRegistry kills on server shutdown; PID tracked; stale-PID cleanup on startup |
| Trace disk bloat | 90-day rolling prune in scheduler (enabled by default, configurable) |
| Work-PC install friction | Docker image is portable target; PWA install works in any Chromium browser |

## 16. Open questions (to resolve before or during implementation)

1. **Windows path handling in `hooks/client.js`.** The hook command string in settings.json uses forward slashes for portability (Git Bash, PowerShell, and node all accept forward-slash paths on Windows). Verify Windows paths with spaces work via quoting: `node "C:/path with spaces/hooks/client.js"`. If quoting is unreliable in settings.json, fall back to installing hooks into a no-spaces path (`~/.claude-deck/hooks/client.js`).
2. **CLI `--session-id` reuse semantics.** Confirm via testing whether passing the same `--session-id` across invocations is equivalent to `--resume <id>`. Document the winner. Related: confirm whether `--input-format stream-json` allows multi-turn within one process (if yes → upgrade to long-running subprocess in a follow-up without breaking §7 interface).
3. **Thinking content blocks in stream-json.** Confirm whether extended-thinking output appears as a distinct block type and include it in the parser's union.
4. **Compaction event fidelity.** Trace capture should preserve the full pre/post-compaction window — confirm `compact_boundary` event contains enough to reconstruct.

These four can be resolved via a 30-minute CLI smoke test before Burst 1 kicks off; results feed back into this spec.

## 17. Post-v1 roadmap (not in scope today)

- In-UI trace viewer with filtering, search, pretty-printing
- Trace diff between runs (for regression detection)
- Trace replay into a new session (for evaluation)
- Tailscale-backed LAN/phone access
- Multi-user mode with auth / TLS / per-user goal visibility
- Tauri desktop wrapper
- Rich templates / recipes for common goal types
- Goal dependency graph (goal A blocks goal B)
- "Retrospective" prompt — LLM-generated summary of a completed goal's trace

---

**End of spec.**
