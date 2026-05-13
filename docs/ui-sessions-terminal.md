# Sessions & Terminal

Reference documentation for the Sessions tab, embedded terminal, transcript replay, session lifecycle, and token/cost display in Claude Deck.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Sessions Tab (UI)](#sessions-tab-ui)
3. [Session Detail Page](#session-detail-page)
4. [Terminal Integration](#terminal-integration)
5. [PTY Manager (Backend)](#pty-manager-backend)
6. [Session Runner (Backend)](#session-runner-backend)
7. [Session Lifecycle](#session-lifecycle)
8. [Transcript Replay](#transcript-replay)
9. [Conversation Logger](#conversation-logger)
10. [Token & Cost Display](#token--cost-display)
11. [WebSocket Event Flow](#websocket-event-flow)
12. [Database Schema](#database-schema)
13. [API Endpoints](#api-endpoints)
14. [State Management (Client)](#state-management-client)

---

## Architecture Overview

```
                          ┌──────────────────┐
                          │   Browser (UI)   │
                          │                  │
                          │  SessionsListPage│
                          │  SessionDetail   │
                          │  TerminalPanel   │
                          │  ContextHealth   │
                          └───────┬──────────┘
                                  │ WebSocket + REST
                                  ▼
                          ┌──────────────────┐
                          │   Express Server │
                          │                  │
                          │  /api/sessions/* │
                          │  /api/goals/*    │
                          │  /ws             │
                          └───────┬──────────┘
                                  │
                    ┌─────────────┼─────────────┐
                    ▼             ▼              ▼
             ┌────────────┐ ┌──────────┐ ┌──────────────┐
             │ PtyManager │ │ Session  │ │  Transcript  │
             │ (node-pty) │ │ Runner   │ │  Service     │
             │            │ │ (stdio)  │ │  (JSONL)     │
             └─────┬──────┘ └────┬─────┘ └──────┬───────┘
                   │             │               │
                   ▼             ▼               ▼
             ┌──────────────────────────────────────────┐
             │          claude CLI binary               │
             │  (--session-id | --resume)               │
             └──────────────────────────────────────────┘
                                  │
                                  ▼
                          ~/.claude/projects/<hash>/<session-id>.jsonl
```

There are two independent mechanisms for running Claude CLI sessions:

| Mechanism | Class | I/O Mode | Use Case |
|-----------|-------|----------|----------|
| **PTY** | `PtyManager` | Raw terminal (node-pty) | Goal detail view with interactive xterm.js terminal |
| **Stdio** | `SessionRunner` | `stream-json` via stdin/stdout pipes | Programmatic message-based interaction (MCP, API) |

Both register themselves in the singleton `ProcessRegistry` (keyed by goal ID, one-subprocess-per-goal constraint).

---

## Sessions Tab (UI)

### Component Hierarchy

```
SessionsListPage
  ├── SessionFilters
  └── SessionsTable
       └── OriginBadge (per row)
```

**File:** `src/pages/SessionsListPage.tsx`

### Data Loading

On mount, fetches `GET /api/sessions?limit=500`. The response includes enriched fields (`last_event_at`, `current_tool`, `goal_title`) joined server-side from `hook_events` and `goals` tables.

Sessions are stored in the Zustand `useSessionsStore` and updated in real-time via WebSocket events (`session:observed`, `session:ended`).

### Filtering

**File:** `src/components/sessions/SessionFilters.tsx`

Three filter controls:

| Filter | Type | Options | Default |
|--------|------|---------|---------|
| Origin | Dropdown | All Origins, Dashboard, External | All Origins |
| Date Range | Dropdown | Today, Last 7 days, Last 30 days, All time | All time |
| Active Only | Checkbox | On/Off | On |

Date range filtering is applied client-side before passing to the table. Origin and active filters are applied within `SessionsTable` itself.

A **Reset** button appears when any filter deviates from defaults. The session count is displayed at the right end of the filter bar.

### Sessions Table

**File:** `src/components/sessions/SessionsTable.tsx`

**Columns:**

| Column | Source | Notes |
|--------|--------|-------|
| Origin | `session.origin` | Rendered as `OriginBadge` (Dashboard = blue Monitor icon, External = amber Globe icon) |
| Goal | `enriched.goal_title` | Linked goal name, truncated to 10rem |
| Name | `session.display_name` or cwd last segment or truncated ID | Primary identifier shown to user |
| Working Dir | `session.cwd` | Truncated to 30 chars with leading `...` |
| Model | `session.model` | Raw model string or `--` |
| Started | `session.started_at` | `Mon DD, HH:MM` format |
| Last Event | `enriched.last_event_at` | Relative time (`3s ago`, `2h ago`) |
| Current Tool | `enriched.current_tool` | Yellow badge if a tool is currently executing |
| Duration | Computed | `ended_at - started_at` (or live if active), formatted as `Xh Ym` or `Xm Ys` |
| Status | Computed from `ended_at` | Green pulsing "Active" badge or gray "Ended" badge |
| Actions | End / Restart buttons | End (Square icon) for active sessions, Restart (RotateCcw icon) for ended sessions with a goal |

**Sorting:** Click the **Started** or **Duration** column headers to toggle ascending/descending sort. Active sort column shows a blue arrow icon.

**Session Hierarchy:** Sessions with a `parent_session_id` (subagent sessions) are rendered as a tree. Child sessions are indented with a `└` prefix. The `buildSessionTree()` function groups children by parent and flattens into a depth-annotated list.

**Row Click:** Navigates to `/sessions/:id` (SessionDetailPage).

**Pagination:** Displays up to 50 sessions initially. A "Load more (N remaining)" button loads the next batch.

### End Session

Clicking the End button calls `POST /api/sessions/:id/end`, which sets `ended_at = Date.now()` in the database. The store is optimistically updated.

### Restart Session

Clicking the Restart button calls `POST /api/sessions/:id/restart`. This is only available for ended sessions that are linked to a goal. The server spawns a new `PtyManager` with `--resume <sessionId>`.

---

## Session Detail Page

**File:** `src/pages/SessionDetailPage.tsx`

Displays a single session's full details. Fetches both `GET /api/sessions/:id` and `GET /api/sessions/:id/messages` on mount.

### Layout

```
SessionDetailPage
  ├── SessionDetailHeader (metadata + stats)
  ├── MessageStream (read-only message list)
  ├── HookEventsSection (collapsible)
  └── TraceDownloadPanel
```

### Session Detail Header

**File:** `src/components/sessions/SessionDetailHeader.tsx`

Displays:
- **Back link** to `/sessions`
- **Session ID** (monospace)
- **Origin badge** (Dashboard/External)
- **Active badge** with pulsing green dot (if active)
- **Mark Ended** button (if active) -- calls `POST /api/sessions/:id/end`
- **Goal link** to `/goals/:goal_id`
- **Working directory** (monospace)
- **Stats grid:** Model, Duration, Cost, Tokens (in/out)

The cost and token stats are fetched separately from `GET /api/sessions/:id/usage`, which reads JSONL files (not the database).

### Message Stream

**File:** `src/components/sessions/MessageStream.tsx`

Renders messages as styled bubbles with role-based styling:

| Role | Icon | Background | Border |
|------|------|------------|--------|
| user | User | Accent/5% | Accent/20% |
| assistant | Bot | Surface | Border |
| system | Info | Warning/5% | Warning/20% |
| tool_use | Wrench | Background | Border |
| tool_result | Terminal | Background | Border |

Each bubble shows: role icon, label, tool name (if applicable), timestamp, content, and tool args/results (collapsible `<pre>` blocks).

The stream auto-scrolls to the bottom when new messages arrive.

### Hook Events Section

Collapsible panel that lazy-loads hook events from `GET /api/sessions/:id/events?limit=200`. Each event shows:
- Icon by type (Play=SessionStart, Wrench=PreToolUse/PostToolUse, MessageSquare=UserPromptSubmit, Square=Stop)
- Timestamp (HH:MM:SS)
- Event type chip (color-coded)
- Tool name badge (if applicable)

---

## Terminal Integration

### xterm.js Setup

**File:** `src/components/goal/TerminalPanel.tsx`

The terminal panel is rendered within the `GoalSplitView` component (left pane = terminal, right pane = plan/health).

**Terminal Configuration:**

```typescript
new Terminal({
  cursorBlink: true,
  cursorStyle: 'block',
  fontSize: 13,
  fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", Menlo, Monaco, monospace',
  scrollback: 10000,
  theme: { /* Tokyo Night-inspired dark theme */ },
  allowProposedApi: true,
})
```

**Addons loaded:**
- `FitAddon` -- auto-sizes terminal to container dimensions
- `WebLinksAddon` -- makes URLs clickable

### Terminal Lifecycle (Client-Side)

1. **Mount:** Component creates `Terminal` instance, loads addons, opens in container div, calls `term.focus()`
2. **Spawn:** Calls `POST /api/goals/:goalId/terminal` to start or confirm PTY is running
3. **Input:** `term.onData()` sends keystrokes via WebSocket: `{ type: 'terminal:input', goal_id, data }`
4. **Output:** Listens for `terminal:data` WS events, writes data to xterm via `term.write(data)`
5. **Resize:** `ResizeObserver` on the container div triggers `fitAddon.fit()`, then sends `{ type: 'terminal:resize', goal_id, cols, rows }` via WebSocket. Resize is debounced at 100ms.
6. **Exit:** On `terminal:exited` event, shows `--- session exited (code N) ---` and a **Restart** button
7. **Cleanup:** On unmount, unsubscribes all event listeners, disconnects ResizeObserver, disposes xterm

### Status Indicators

The terminal header bar shows:
- `running` (green dot) -- PTY process is alive
- `connecting` (yellow dot) -- waiting for PTY spawn
- `exited (N)` (gray dot) -- process exited with code N, Restart button visible

### Focus Handling

- Terminal is auto-focused on mount via `term.focus()`
- Container click handler re-focuses the terminal
- No explicit blur handling; xterm manages its own focus state

### Terminal Event Bus

**File:** `src/lib/terminal-events.ts`

A per-goal-ID event emitter pattern using a `Map<string, TerminalListeners>`:

```typescript
interface TerminalListeners {
  onData: TerminalDataHandler[];     // (data: string) => void
  onStarted: TerminalLifecycleHandler[];  // () => void
  onExited: TerminalExitHandler[];   // (exitCode: number) => void
}
```

Functions:
- `onTerminalData(goalId, handler)` -- subscribe to PTY output
- `onTerminalStarted(goalId, handler)` -- subscribe to PTY start
- `onTerminalExited(goalId, handler)` -- subscribe to PTY exit
- `emitTerminalData/Started/Exited()` -- called by `ws-manager.ts` dispatch
- `cleanupTerminalListeners(goalId)` -- removes all listeners for a goal

The `ws-manager.ts` dispatch function bridges WebSocket events to this bus:
```
WS terminal:data  → emitTerminalData(goal_id, data)
WS terminal:started → emitTerminalStarted(goal_id)
WS terminal:exited → emitTerminalExited(goal_id, exitCode)
```

---

## PTY Manager (Backend)

**File:** `server/pty-manager.ts`

### Class: `PtyManager`

Implements the `Killable` interface for `ProcessRegistry`. Wraps `node-pty` to spawn and manage Claude CLI processes.

### Spawning (`start()`)

```
claude --session-id <goalId> [--permission-mode bypassPermissions] [--model <model>] [--mcp-config <json>]
```

Key parameters:
- `--session-id <goalId>`: Uses the goal ID as the session ID (enables 1:1 goal-to-session mapping)
- `--permission-mode bypassPermissions`: Added when `goal.permission_mode === 'autonomous'`
- `--model <model>`: Added when `goal.model` is set and not `'default'`
- `--mcp-config <json>`: Injects the Claude Deck MCP server so spawned sessions can orchestrate other goals

**PTY options:**
```typescript
{
  name: 'xterm-256color',
  cols: 120,
  rows: 30,
  cwd: goal.cwd,
  env: { ...process.env, TERM: 'xterm-256color' },
}
```

### Windows Compatibility

Two Windows-specific workarounds:

1. **Real Node Path:** On Windows with Git Bash, `process.execPath` may point to Git's bundled node stub. `findRealNodePath()` uses `where node` to find the real `node.exe` and temporarily overrides `process.execPath` during `pty.spawn()` so conpty can track child PIDs.

2. **Claude Path Resolution:** `resolveClaudePath()` uses `which claude` to find the CLI binary, converts Git Bash paths (`/c/...` to `C:/...`), and appends `.exe` on Windows.

### Initial Prompt Delivery

The PTY needs to wait until Claude Code's interactive prompt is ready before sending the initial prompt. Two-layer detection:

1. **Idle timer (primary):** After PTY output stops for 5 seconds, assume the prompt is ready. Reset on every `onData` chunk.
2. **Regex detection (best-effort):** Strips ANSI codes and matches `> ` or `❯ ` at end of output.
3. **Fallback timeout:** If no data at all after 45 seconds, send anyway (covers slow startups).

Once the prompt is detected as ready:
```typescript
setTimeout(() => {
  this.write(pendingPrompt);
  setTimeout(() => {
    this.write('\r');  // Send Enter
  }, 200);
}, 500);
```

### Resuming (`resume()`)

```
claude --resume <sessionId> [--permission-mode bypassPermissions] [--mcp-config <json>]
```

Uses `--resume` instead of `--session-id`. No initial prompt delivery logic needed (the session continues from where it left off).

### Data Flow

```
PTY onData → broadcast('terminal:data', { goal_id, data })
                    ↓
            WebSocket → all subscribed clients
                    ↓
            ws-manager dispatch → emitTerminalData(goalId, data)
                    ↓
            TerminalPanel → term.write(data)
```

### Exit Handling

```
PTY onExit → broadcast('terminal:exited', { goal_id, exitCode })
           → processRegistry.remove(goalId)
           → onExitCallback(goalId, exitCode)
                 ↓
           Goal status → 'waiting'
           ConversationLogger → stop()
```

### MCP Config Injection

Both `start()` and `resume()` inject a `--mcp-config` JSON string that configures a `claude-deck` MCP server. This allows spawned Claude sessions to create and instruct other goals:

```json
{
  "mcpServers": {
    "claude-deck": {
      "command": "node",
      "args": ["<mcp/dist/index.js>"],
      "env": { "CLAUDE_DECK_URL": "http://127.0.0.1:<port>" }
    }
  }
}
```

---

## Session Runner (Backend)

**File:** `server/session-runner.ts`

### Class: `SessionRunner`

An alternative to `PtyManager` for programmatic (non-interactive) sessions. Uses `child_process.spawn()` with piped stdio instead of a PTY.

### CLI Arguments

```
claude --output-format stream-json --input-format stream-json --verbose
       --permission-mode bypassPermissions
       --session-id <uuid> | --resume <uuid>
       [--model <model>] [--mcp-config <json>]
```

### Stream JSON Protocol

Prompts are sent via stdin in stream-json format:
```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<prompt>"}]}}
```

stdin is kept open after writing (not ended) to allow multi-turn interaction.

### Event Handling

stdout is parsed by `stream-parser.ts` into typed `StreamJsonEvent` objects:

| Event Type | Handler | Action |
|------------|---------|--------|
| `system` (init) | `handleSystemEvent` | Logs session ID and model |
| `system` (compact_boundary) | `handleSystemEvent` | Traced only, no messages created |
| `assistant` | `handleAssistantEvent` | Extracts content blocks → messages (text, tool_use, thinking) |
| `user` | `handleUserEvent` | Extracts tool_result blocks → messages |
| `result` | `handleResultEvent` | Ends session, creates completion system message, transitions goal to `waiting` |

### Content Block Deduplication

Assistant events may contain previously-seen content blocks. `SessionRunner` tracks a `Set<string>` of content hashes (`type:first-100-chars-of-text`) to skip duplicates.

### Enriched Prompts

Before sending the initial prompt, `SessionRunner` prepends:
1. **Project Memory:** Contents of `<goal.cwd>/.claude/memory/MEMORY.md` (if it exists)
2. **External Skills:** Skills from configured skill directories not under the goal's cwd

### Dependencies (Injected)

```typescript
interface SessionRunnerDeps {
  traceWriter: TraceWriter;       // Writes raw stream data to disk
  messageService: MessageService; // Persists messages + broadcasts WS events
  goalService: GoalService;       // Updates goal status + session references
  broadcast: (event: ServerEvent) => void;
  skillProvider?: SkillProvider;  // External skill injection
}
```

---

## Session Lifecycle

### Creation Paths

Sessions can be created through three paths:

#### 1. Dashboard PTY (Primary)

```
UI: POST /api/goals/:id/terminal
  → spawnTerminalSession(goalId, initialPrompt?)
    → PtyManager.start() or PtyManager.resume()
    → processRegistry.set(goalId, ptyMgr)
    → goalService.update(goalId, { status: 'active' })
```

**Session ID = Goal ID.** The PTY is spawned with `--session-id <goalId>`, so Claude Code's own JSONL file is named `<goalId>.jsonl`.

**Resume detection:** `spawnTerminalSession()` checks if `findJsonlFile(goalId)` returns a path. If yes, the session is resumed with `PtyManager.resume(goalId)` instead of starting fresh. This means reopening a goal's terminal always picks up where it left off.

#### 2. Dashboard Stdio (API/MCP)

```
API: POST /api/goals/:id/messages
  → spawnGoalSession(goalId, prompt)
    → SessionRunner.start(prompt) or SessionRunner.sendFollowup(prompt)
    → processRegistry.set(goalId, runner)
```

Creates a new UUID session ID (not the goal ID). Inserts a session row and user message into the database.

#### 3. External (Hook-Observed)

```
Claude CLI starts independently
  → SessionStart hook fires
    → POST /api/hooks/SessionStart
      → HookIngest.onSessionStart(payload)
        → INSERT INTO sessions (origin='external')
        → broadcast('session:observed', session)
```

External sessions may be auto-linked to goals by:
1. **ID match:** `session_id = goal.id` (dashboard-spawned PTY sessions)
2. **CWD fallback:** Matches the session's `cwd` to a waiting goal with no current session

### Session End

Sessions are ended through:

| Trigger | Mechanism |
|---------|-----------|
| Claude CLI exits | `PtyManager.onExit` → broadcasts `terminal:exited` |
| CLI `result` event | `SessionRunner.handleResultEvent` → `endSession()` |
| `Stop` hook fires | `HookIngest.onStop()` → `UPDATE sessions SET ended_at` |
| Manual end | `POST /api/sessions/:id/end` → `sessionService.end()` |
| Server startup cleanup | Abandoned sessions (no goal, >24h old) auto-closed |

### Session Restart

`POST /api/sessions/:id/restart` (only for ended sessions with a goal):

```
restartSession(sessionId, goalId)
  → new PtyManager(goal, { broadcast, onExit })
  → processRegistry.set(goalId, ptyMgr)
  → goalService.update(goalId, { status: 'active' })
  → convLogger.rebuild()  // replay JSONL into conversation.md
  → ptyMgr.resume(sessionId)  // --resume <sessionId>
```

### Subagent Sessions

When Claude Code spawns a subagent, the `SubagentStart` hook fires:
- Sets `parent_session_id` on the child session
- Sets `display_name` from the agent description
- Links child to parent's goal

`SubagentStop` sets `ended_at` on the child session.

In the Sessions table, child sessions appear indented under their parent with a `└` prefix.

### Process Registry

**File:** `server/process-registry.ts`

Singleton `Map<string, Killable>` enforcing one-subprocess-per-goal:

```typescript
interface Killable {
  interrupt(): Promise<void>;  // Send SIGTERM (PtyManager.kill() / SessionRunner SIGTERM)
  cleanup(): Promise<void>;    // Close trace files, release resources
}
```

On server shutdown (`SIGTERM`/`SIGINT`), `killAll()` iterates all entries, calling `interrupt()` + `cleanup()` with `Promise.allSettled()`.

---

## Transcript Replay

### JSONL File Location

**File:** `server/services/transcript-service.ts`

Claude Code stores session transcripts at:
```
~/.claude/projects/<project-hash>/<session-id>.jsonl
```

`findJsonlFile(sessionId)` scans all subdirectories of `~/.claude/projects/` to locate the JSONL file for a given session ID.

### Transcript Parsing

`getTranscript(sessionId)` reads the JSONL file and extracts `TranscriptMessage[]`:

```typescript
interface TranscriptMessage {
  role: 'user' | 'assistant';
  text: string;
}
```

For each JSONL line:
- `type: 'user'` with `message.content` → extracts text (string content or text blocks from array)
- `type: 'assistant'` with `message.content` → extracts text blocks, tool_use as `[Tool: name]`, tool_result as `[Result: truncated]`

### Terminal Formatting

`formatTranscriptForTerminal(messages)` renders the transcript with ANSI colors for display in the terminal on session resume:

```
─────────────────────────────────────────────────────
  Conversation history (from Claude Code transcript)
─────────────────────────────────────────────────────

> You   (green, bold)
<user message>

> Claude (cyan, bold)
<assistant message>

─────────────────────────────────────────────────────
  End of history — live session below
─────────────────────────────────────────────────────
```

### When Replay Happens

Transcript replay is triggered by the `ConversationLogger.rebuild()` method, which is called:
1. When `spawnTerminalSession()` detects an existing JSONL file and resumes
2. When `restartSession()` resumes an ended session

The ConversationLogger reads the full JSONL, converts it to a `conversation.md` file in the goal's cwd, and broadcasts a `conversation:updated` event.

---

## Conversation Logger

**File:** `server/services/conversation-logger.ts`

Watches the Claude Code JSONL file and maintains a `conversation.md` file in the goal's working directory. This file provides a human-readable record of the conversation alongside the code.

### Modes

- **`start()`**: For new sessions. Polls for the JSONL file (retries every 3s, up to 14 attempts = ~42s), then begins watching.
- **`rebuild()`**: For resumed sessions. Reads the entire JSONL file immediately, writes a full `conversation.md`, then begins watching for new entries.

### File Watching

Uses `fs.watchFile()` with 1-second polling interval:
1. Detects file modification via `mtimeMs` comparison
2. Debounces at 300ms to batch rapid writes
3. Reads only new bytes since `lastByteOffset` (incremental reads via `readSync` with offset)
4. Parses new lines as JSONL entries
5. Appends formatted markdown to `conversation.md`
6. Broadcasts `conversation:updated` WebSocket event

### Output Format

`conversation.md` entries:

```markdown
### You -- 2:30 PM

User's prompt text

---

### Claude -- 2:31 PM

Assistant's response text

> **Tool:** `Read` -- path/to/file.ts

---

> **Result:** ok

---
```

Tool inputs are summarized per tool type (file paths for Read/Write/Edit, command for Bash, pattern for Grep/Glob, description for Agent).

---

## Token & Cost Display

### Data Source: JSONL Files (Not Database)

Token and cost data is computed at request time from Claude Code's JSONL session files. The database does not store token counts or costs (columns `total_cost_usd`, `total_tokens_in`, `total_tokens_out` exist in the schema but are not populated).

**File:** `server/services/usage-service.ts`

### Per-Session Usage

`getSessionUsage(sessionId, model?)` returns:

```typescript
interface SessionUsage {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalTokens: number;
  currentContextTokens: number;  // Last message's input + cache_read + cache_creation
  contextWindow: number;         // Model-dependent (200K or 1M)
  contextPct: number;            // (currentContext / contextWindow) * 100, capped at 100
  estimatedCostUsd: number;
  messageCount: number;
}
```

Iterates every line of the JSONL file, summing `message.usage` fields:
- `input_tokens`
- `cache_creation_input_tokens`
- `cache_read_input_tokens`
- `output_tokens`

### Context Window Calculation

```typescript
currentContext = lastInputTokens + lastCacheRead + lastCacheCreation
contextPct = min(100, round((currentContext / contextWindow) * 100))
```

Context window size is determined by model:
- `*1m*` in model name → 1,000,000
- `*haiku*` → 200,000
- Default (opus, sonnet) → 200,000
- If `currentContextTokens > 200,000` → forced to 1,000,000

### Cost Estimation

Per-model pricing (USD per token):

| Model | Input | Cache Read | Cache Creation | Output |
|-------|-------|------------|----------------|--------|
| Opus | $15/M | $1.50/M | $18.75/M | $75/M |
| Sonnet | $3/M | $0.30/M | $3.75/M | $15/M |
| Haiku | $0.80/M | $0.08/M | $1/M | $4/M |

Model detection: Falls back to Opus pricing if model is unknown.

### Aggregate Usage

`getAllSessionUsageSummaries(sinceDaysAgo)` scans all JSONL files across all project directories. Used by analytics endpoints.

`getAggregateTotals(sinceDaysAgo)` computes total sessions, cost, tokensIn, tokensOut.

`getDailyCosts(sinceDaysAgo)` groups sessions by date using their first message timestamp.

### Where Usage Is Displayed

1. **Session Detail Header** (`SessionDetailHeader.tsx`): Fetches `GET /api/sessions/:id/usage` on mount. Shows cost and tokens in/out.

2. **Goal Split View** (`GoalSplitView.tsx`): Fetches usage for the current session and passes to `GoalPlanPane` → `ContextHealth`.

3. **Context Health Widget** (`ContextHealth.tsx`): Shows:
   - Context window progress bar (green <50%, yellow 50-75%, red >75%)
   - Context percentage
   - Tokens In/Out (formatted as K/M)
   - Cost ($X.XXXX)
   - Turn count

4. **Analytics Page**: Uses aggregate endpoints for cost-over-time charts and total stats.

### Client-Side Health Store

**File:** `src/stores/useSessionHealthStore.ts`

```typescript
interface SessionHealth {
  sessionId: string;
  goalId: string | null;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCost: number;
  turnCount: number;
  contextWindowUsed: number; // 0-100
  lastUpdated: number;
}
```

Client-side estimation uses a fixed 1M context window:
```typescript
function estimateContextUsage(currentContextTokens: number): number {
  return Math.min(100, Math.round((currentContextTokens / 1_000_000) * 100));
}
```

---

## WebSocket Event Flow

### Server → Client Events

**Terminal events** (only via PTY sessions):

| Event | Fields | Triggered By |
|-------|--------|--------------|
| `terminal:data` | `goal_id`, `data` | `PtyManager.onData()` |
| `terminal:started` | `goal_id` | `PtyManager.start()` / `resume()` |
| `terminal:exited` | `goal_id`, `exitCode` | `PtyManager.onExit()` |

**Session events:**

| Event | Fields | Triggered By |
|-------|--------|--------------|
| `session:observed` | `session` (full object) | `SessionService.create()` (external), `HookIngest.onSessionStart()` |
| `session:ended` | `id` | `SessionService.end()`, `SessionRunner.handleResultEvent()`, `HookIngest.onStop()` |

### Client → Server Messages

| Message | Fields | Handler |
|---------|--------|---------|
| `terminal:input` | `goal_id`, `data` | `terminalHandler.onInput()` → `PtyManager.write()` |
| `terminal:resize` | `goal_id`, `cols`, `rows` | `terminalHandler.onResize()` → `PtyManager.resize()` |
| `subscribe` | `goals: string[] \| 'all'` | Sets subscription filter |
| `unsubscribe` | (none) | Clears subscriptions |
| `ping` | (none) | Responds with `{ type: 'ping' }` |

### Subscription-Based Routing

**File:** `server/ws.ts`

Each WebSocket client has a subscription state: either a `Set<string>` of goal IDs or `'all'`.

Broadcasting logic:
- Events with a `goal_id` → only sent to clients subscribed to that goal (or `'all'`)
- Events without a `goal_id` → sent to all clients with any subscriptions
- The UI subscribes to `'all'` on connection open

### Client WebSocket Manager

**File:** `src/lib/ws-manager.ts`

Module-level singleton WebSocket connection with exponential backoff reconnect (1s base, 30s max). On first React mount, `useWsManager()` hook initializes the connection.

The `dispatch()` function routes incoming `ServerEvent` objects to Zustand stores and the terminal event bus:

```
terminal:data    → emitTerminalData()
terminal:started → emitTerminalStarted()
terminal:exited  → emitTerminalExited()
session:observed → useSessionsStore.upsertSession()
session:ended    → useSessionsStore.upsertSession({ ...session, ended_at })
goal:status      → useGoalsStore.upsertGoal()
message:added    → useMessagesStore.addMessage()
hook:event       → useActiveToolStore.setActiveTool()
```

---

## Database Schema

### Sessions Table

```sql
CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,
  goal_id            TEXT REFERENCES goals(id),
  origin             TEXT NOT NULL CHECK (origin IN ('dashboard', 'external')),
  cwd                TEXT,
  model              TEXT,
  display_name       TEXT,          -- Added in migration 003
  parent_session_id  TEXT,          -- Added in migration 003 (subagent hierarchy)
  trace_dir          TEXT,
  stream_event_count INTEGER DEFAULT 0,
  hook_event_count   INTEGER DEFAULT 0,
  stderr_bytes       INTEGER DEFAULT 0,
  started_at         INTEGER,
  ended_at           INTEGER
);
```

> **Note:** Columns `total_cost_usd`, `total_tokens_in`, and `total_tokens_out` were removed in migration 006. Token and cost data is now sourced exclusively from Claude Code JSONL log files via `usage-service.ts`.

**Indexes:**
- `(origin, started_at)` -- for list queries
- `(goal_id, started_at)` -- for goal-scoped queries
- `(parent_session_id)` -- for subagent tree traversal

### Related Tables

- **`messages`** -- per-session chat log (role, content, tool_name, tool_args, tool_result, tool_use_id)
- **`hook_events`** -- raw hook fires (event_type, tool_name, payload_json, created_at)
- **`goals`** -- has `current_session_id` FK pointing to the active session

---

## API Endpoints

### Session Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sessions` | List sessions with filters (origin, active, limit, offset). Returns enriched sessions with `last_event_at`, `current_tool`, `goal_title`. |
| `GET` | `/api/sessions/:id` | Get single session by ID |
| `GET` | `/api/sessions/:id/messages` | List messages for a session (limit, before cursor) |
| `GET` | `/api/sessions/:id/events` | List hook events for a session (limit, offset) |
| `GET` | `/api/sessions/:id/usage` | Get token usage from JSONL files |
| `POST` | `/api/sessions/:id/end` | Manually mark session as ended |
| `POST` | `/api/sessions/:id/restart` | Restart an ended session with `--resume` |

### Goal Terminal Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/goals/:id/terminal` | Spawn or confirm PTY terminal. Body: `{ prompt?: string }`. Returns `already_running` if PTY exists. |
| `POST` | `/api/goals/:id/messages` | Send a message (spawns SessionRunner or PTY with prompt) |
| `POST` | `/api/goals/:id/interrupt` | Interrupt the active session |

### Hook Endpoints (External Sessions)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/hooks/SessionStart` | Creates external session row, links to goal if possible |
| `POST` | `/api/hooks/Stop` | Marks session as ended |
| `POST` | `/api/hooks/SubagentStart` | Links child session to parent |
| `POST` | `/api/hooks/SubagentStop` | Marks child session as ended |

---

## State Management (Client)

### `useSessionsStore`

**File:** `src/stores/useSessionsStore.ts`

```typescript
interface SessionsState {
  sessions: Session[];
  setSessions: (sessions: Session[]) => void;
  upsertSession: (session: Session) => void;
}
```

Used by `SessionsListPage` to hold the full session list. Updated by:
- Initial fetch (`setSessions`)
- WebSocket `session:observed` event (`upsertSession`)
- WebSocket `session:ended` event (`upsertSession` with `ended_at` set)
- Optimistic updates after End/Restart actions

### `useSessionHealthStore`

**File:** `src/stores/useSessionHealthStore.ts`

```typescript
interface SessionHealthState {
  bySessionId: Record<string, SessionHealth>;
  updateHealth: (sessionId: string, update: Partial<SessionHealth>) => void;
  removeHealth: (sessionId: string) => void;
}
```

Tracks per-session health metrics. Used by `ContextHealth` widget and `KanbanCard`.

### `useMessagesStore`

Stores messages keyed by session ID. Used by `SessionDetailPage` for live message updates via the `message:added` WebSocket event.

### `useActiveToolStore`

Tracks the currently-executing tool per session. Updated by `hook:event` WebSocket events (set on `PreToolUse`, cleared on `PostToolUse`). Displayed as a yellow badge in the Sessions table's "Current Tool" column.

### `useConnectionStore`

Tracks WebSocket connection status (`connecting`, `open`, `closed`, `error`). Used by the `ConnectionIndicator` component in the app header.
