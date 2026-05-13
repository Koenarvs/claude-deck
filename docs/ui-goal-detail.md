# Goal Detail View

The Goal Detail View is the primary workspace for monitoring and interacting with a single goal. It presents a full-screen layout composed of a header bar, a terminal panel (left), and a tabbed information pane (right), connected by real-time WebSocket updates.

**Route:** `/goals/:id`  
**Entry component:** `src/pages/GoalDetailPage.tsx`

---

## Architecture Overview

```
GoalDetailPage
 |
 +-- GoalHeader              (top bar: title, status, model, controls)
 |
 +-- GoalSplitView           (resizable two-pane layout)
      |
      +-- TerminalPanel       (left: xterm.js PTY emulator)
      |
      +-- GoalPlanPane        (right: tabbed info panel)
           |
           +-- ContextHealth  (Health tab)
           +-- DocumentsView  (Documents tab)
           +-- PlanRenderer   (To Do tab)
           +-- AgentTree      (Agents tab)
```

### Data Flow

On mount, `GoalDetailPage` fetches `GET /api/goals/:id` which returns a `GoalDetail` composite:

```typescript
interface GoalDetail {
  goal: Goal;
  messages: Message[];
  plan: PlanJson | null;
}
```

This single response populates three Zustand stores:
- `useGoalsStore` -- goal metadata (via `upsertGoal`)
- `useMessagesStore` -- conversation history (via `setState` into `byGoalId`)
- `usePlanStore` -- task list (via `setPlan`)

After initial load, all updates arrive via WebSocket events dispatched by `src/lib/ws-manager.ts`.

---

## Goal Header

**File:** `src/components/goal/GoalHeader.tsx`

The header is a horizontal bar at the top of the detail view containing goal metadata and action controls.

### Props

```typescript
interface GoalHeaderProps {
  goal: Goal;
  onTitleUpdate: (title: string) => void;
  onModelChange: (model: GoalModel) => void;
  onInterrupt: () => void;
  isInterrupting: boolean;
}
```

### Elements (left to right)

| Element | Behavior |
|---------|----------|
| **Title** | Inline-editable. Click to enter edit mode; shows input with Check/X buttons. Enter or blur saves, Escape cancels. Pencil icon appears on hover. |
| **Status badge** | Color-coded pill: planning (warning), active (success), waiting (accent), complete (muted), archived (muted/60). |
| **CWD** | Working directory path with folder icon. Hidden on small screens (`sm:flex`). Truncated to 200px with full path in title tooltip. |
| **Model picker** | `<select>` dropdown with options: Default, Opus, Sonnet, Haiku. Disabled when goal is complete or archived. |
| **Interrupt button** | Red-styled button. Enabled only when `status === 'active'` AND `current_session_id !== null`. Shows "Interrupting..." during request. POSTs to `/api/goals/:id/interrupt`. |
| **Trace download** | Link to `/api/goals/:id/trace` (opens in new tab). Downloads a tar archive of all session trace directories for the goal. |

### Status Color Map

```typescript
const statusColors: Record<GoalStatus, string> = {
  planning: 'bg-deck-warning/20 text-deck-warning',
  active:   'bg-deck-success/20 text-deck-success',
  waiting:  'bg-deck-accent/20  text-deck-accent',
  complete: 'bg-deck-muted/20   text-deck-muted',
  archived: 'bg-deck-muted/20   text-deck-muted/60',
};
```

### Title Editing Flow

1. User clicks the title text (wrapped in a `<button>`)
2. `startEditing()` copies `goal.title` into local `editValue` state and shows the input
3. `useEffect` focuses and selects all text in the input
4. On commit (Enter or blur): trims input, calls `onTitleUpdate(trimmed)` if changed, exits edit mode
5. On cancel (Escape or X button): restores `editValue` to `goal.title`, exits edit mode
6. `GoalDetailPage.handleTitleUpdate` performs optimistic update via `upsertGoal`, then PATCHes the server; reverts on failure

---

## Split View Layout

**File:** `src/components/goal/GoalSplitView.tsx`

The body of the detail page is a horizontally-split two-pane layout.

### Props

```typescript
interface GoalSplitViewProps {
  goalId: string;
  goalStatus: GoalStatus;
}
```

### Layout

- **Left pane:** `TerminalPanel` -- fills remaining space (`flex-1`)
- **Divider:** 1.5px-wide draggable separator, highlighted on drag
- **Right pane:** `GoalPlanPane` -- width computed from `splitRatio`, collapses to 40px icon strip

### Resizable Divider

- Default split: 60% terminal / 40% pane
- Constraints: min 30%, max 85% for terminal width
- Ratio persisted in `localStorage` key `claude-deck:split-ratio`
- During drag: cursor changes to `col-resize`, text selection disabled
- Divider hidden when pane is collapsed

### Pane Collapse

- Collapse state stored in `localStorage` key `claude-deck:plan-pane-collapsed`
- When collapsed, right pane shrinks to 40px with only a `ChevronLeft` expand button and a `ClipboardList` icon
- Smooth CSS transition via `transition-all` on the pane width

### Session Cost Fetching

On mount, `GoalSplitView` fetches cost/token data for the current session:

1. Fetches `GET /api/goals/:id` to find `current_session_id`
2. Fetches `GET /api/sessions/:sessionId` and `GET /api/sessions/:sessionId/usage` in parallel
3. Computes `tokensIn` (input + cache creation + cache read), `tokensOut`, `cost`, `turnCount`, `contextPct`
4. Passes result to `GoalPlanPane` as `sessionHealth`

---

## Terminal Panel (Left Pane)

**File:** `src/components/goal/TerminalPanel.tsx`

A full PTY terminal emulator using [xterm.js](https://xtermjs.org/). This is the primary interaction surface -- it shows the Claude Code session output and accepts keyboard input.

### Lifecycle

1. **Mount:** Creates xterm.js `Terminal` instance, loads `FitAddon` and `WebLinksAddon`, opens into container div
2. **Spawn:** POSTs to `/api/goals/:id/terminal` to start (or resume) a PTY process on the server
3. **Running:** Terminal data flows bidirectionally via WebSocket:
   - Server to client: `terminal:data` events write to xterm
   - Client to server: `terminal:input` messages sent via `sendWsMessage`
4. **Exit:** `terminal:exited` event shows exit code and a Restart button
5. **Unmount:** Cleans up event listeners, ResizeObserver, and disposes xterm

### Terminal Configuration

```typescript
{
  cursorBlink: true,
  cursorStyle: 'block',
  fontSize: 13,
  fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", Menlo, Monaco, monospace',
  scrollback: 10000,
  theme: { /* Tokyo Night color scheme */ },
  allowProposedApi: true,
}
```

### Status Indicator

The terminal has a status bar at the top showing one of:

| Status | Display |
|--------|---------|
| `connecting` | Yellow dot: "connecting" |
| `running` | Green dot: "running" |
| `exited` | Gray dot: "exited (code)" + Restart button |

### Resize Handling

- `ResizeObserver` monitors the terminal container
- Debounced at 100ms to avoid cursor desync during streaming
- After fit, sends `terminal:resize` message with new `cols` and `rows` to the server

### Restart

When the session exits, clicking Restart:
1. Resets status to `connecting`, clears exit code
2. Resets `spawnedRef` flag, clears terminal buffer
3. Re-calls `spawnTerminal()` to POST a new terminal session

---

## Goal Conversation (Alternative Left Pane)

**File:** `src/components/goal/GoalConversation.tsx`

A message-based conversation UI (used when goals run in non-terminal mode). Renders `MessageStream` + `InputBar`.

### Data Source

Messages come from `useMessagesStore.byGoalId[goalId]`. The store is populated on mount by `GoalDetailPage` and updated in real-time by the `message:added` WebSocket event.

### Sending Messages

`handleSend(prompt)` POSTs to `/api/goals/:id/messages`. The server saves the user message and broadcasts it via WebSocket -- no optimistic add is needed on the client.

### Error Display

Send failures show a red error banner above the message stream.

---

## Message Stream

**File:** `src/components/goal/MessageStream.tsx`

Renders the list of `MessageBubble` components with auto-scroll.

### Auto-Scroll

- Tracks previous message count via `prevCountRef`
- When `messages.length` increases, smooth-scrolls to a sentinel `<div>` at the bottom
- Empty state: "No messages yet. Send a prompt to get started."

---

## Message Bubble

**File:** `src/components/goal/MessageBubble.tsx`

Renders individual messages with role-specific styling. Wrapped in `React.memo` for performance.

### Role Configuration

| Role | Icon | Label | Background | Border |
|------|------|-------|------------|--------|
| `user` | User | "You" | `bg-deck-accent/10` | `border-deck-accent/30` |
| `assistant` | Bot | "Claude" | `bg-deck-surface` | `border-deck-border` |
| `system` | Terminal | "System" | `bg-deck-warning/10` | `border-deck-warning/30` |
| `tool_use` | Wrench | "Tool Call" | `bg-deck-surface` | `border-deck-border` |
| `tool_result` | Terminal | "Tool Result" | `bg-deck-bg` | `border-deck-border` |

### Content Rendering by Role

**User messages:** Plain `whitespace-pre-wrap` text.

**Assistant messages:** Checks for `[thinking]...[/thinking]` markers. If found, extracts thinking text into a collapsible `ThinkingContent` block (Brain icon, italic "Thinking..."), and renders the remaining text as `AssistantContent`.

**System messages:** Italic text with warning-tinted color.

**Tool use (`tool_use`):** Collapsible section showing:
- Tool name in monospace
- Expand to see parsed JSON arguments (or raw string on parse failure)
- Max height 384px with scroll

**Tool result (`tool_result`):** Collapsible section showing:
- Tool name in monospace
- Character count when collapsed (for results > 200 chars)
- Expand to see full result text
- Max height 384px with scroll, word-wrap enabled

### Timestamp

Every message shows a timestamp formatted as `HH:MM:SS` using `toLocaleTimeString`.

---

## Input Bar

**File:** `src/components/goal/InputBar.tsx`

A textarea with send button at the bottom of the conversation panel.

### Behavior

| State | Textarea | Placeholder |
|-------|----------|-------------|
| Active | Enabled | "Send a follow-up message... (Enter to send, Shift+Enter for newline)" |
| Sending | Disabled | "Sending..." |
| Complete/Archived | Disabled | "Goal is complete" |

### Auto-Resize

The textarea grows automatically up to 6 lines (max height: 144px at 24px line height). On send, height resets to single line.

### Keyboard

- **Enter** (without Shift): Submit message
- **Shift+Enter**: Insert newline

---

## Goal Plan Pane (Right Pane)

**File:** `src/components/goal/GoalPlanPane.tsx`

A tabbed panel on the right side of the split view with four tabs.

### Tabs

| Tab | Icon | ID | Content |
|-----|------|----|---------|
| Health | Activity | `health` | Session metrics (ContextHealth component) |
| Documents | FileText | `documents` | Markdown file viewer |
| To Do | CheckSquare | `todo` | Task list from plan_json (PlanRenderer component) |
| Agents | GitBranch | `agents` | Session tree (AgentTree component) |

Default active tab: `health`.

### Collapse/Expand

- Collapse button (ChevronRight) in the tab bar
- When collapsed: 40px-wide strip with ChevronLeft expand button and ClipboardList icon
- State persisted in `localStorage` key `claude-deck:plan-pane-collapsed`

---

### Health Tab

**File:** `src/components/goal/ContextHealth.tsx`

Displays session health metrics in a card layout.

#### Metrics

| Metric | Format | Source |
|--------|--------|--------|
| Context Window | Progress bar + percentage | `contextPct` from usage API |
| Tokens In | K/M formatted | `inputTokens + cacheCreationTokens + cacheReadTokens` |
| Tokens Out | K/M formatted | `outputTokens` |
| Cost | `$X.XXXX` | `estimatedCostUsd` |
| Turns | Integer | `stream_event_count` |

#### Health Color Thresholds

| Range | Color |
|-------|-------|
| < 50% | Green (`text-deck-success`) |
| 50-75% | Yellow (`text-deck-warning`) |
| > 75% | Red (`text-deck-danger`) |

Both the Activity icon and the progress bar use the same threshold colors.

---

### Documents Tab

Renders markdown files from the goal's working directory.

#### File Discovery

On tab activation, fetches `GET /api/goals/:id/documents` which lists all `.md` files in the goal's CWD. The response shape is `{ files: string[] }`.

#### File Selection

Auto-selects in priority order:
1. `conversation.md` (if present)
2. `plan.md` (if present)
3. First file in list

Users can switch files via a `<select>` dropdown.

#### Content Loading

Fetches `GET /api/goals/:id/document?name=<filename>`. For `conversation.md`, appends `&tail=500` to load only the last 500 lines.

Response shape:
```typescript
{
  exists: boolean;
  content: string | null;
  hasMore?: boolean;
  totalLines?: number;
}
```

#### Pagination

If `hasMore` is true, a "Load earlier messages..." button appears. Clicking it fetches the next 500-line chunk at `offset + 500` and prepends it to the existing content.

#### Auto-Refresh

When viewing `conversation.md`, subscribes to the `conversation:updated` WebSocket event via `onConversationUpdated(goalId, handler)`. On update, re-fetches the last 500 lines and auto-scrolls to bottom.

#### Markdown Rendering

Uses `ReactMarkdown` with `remarkGfm` plugin. Styled with Tailwind prose classes (`prose prose-invert prose-sm`) with custom overrides for headings, links, code blocks, tables, blockquotes, and horizontal rules.

#### Empty States

- No files found: "No documents found" / "Place .md files in the goal's working directory"
- File not found: "{filename} not found" / "File may not exist yet"

---

### To Do Tab

**File:** `src/components/goal/PlanRenderer.tsx`

Renders the hierarchical task list from `plan_json.todos`.

#### Data Source

Reads from `usePlanStore.byGoalId[goalId]`. Updated via the `goal:plan-updated` WebSocket event (triggered when `TodoWrite` is called in a session).

#### Data Structure

```typescript
interface PlanTodo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority: number;
  children: PlanTodo[];
}

interface PlanJson {
  todos: PlanTodo[];
  raw_content: string;
}
```

#### Progress Bar

Displays `completed/total (percent%)` with a green progress bar. Counts are computed recursively across all nesting levels.

#### Status Icons

| Status | Icon | Color | Animation |
|--------|------|-------|-----------|
| `pending` | Circle | `text-deck-muted` | None |
| `in_progress` | Loader2 | `text-deck-accent` | `animate-spin` |
| `completed` | Check | `text-deck-success` | None |

Completed items show `line-through` text decoration. Children are indented 16px per depth level.

#### Empty State

"No tasks yet" / "Tasks appear when TodoWrite is called"

The entire component is wrapped in `React.memo`.

---

### Agents Tab

Displays a hierarchical tree of sessions associated with the goal.

#### Data Fetching

Fetches `GET /api/sessions?goal_id=:id&limit=200`. Builds a tree from `parent_session_id` relationships:

1. Groups sessions into parent-child relationships using `parent_session_id`
2. Sessions without a parent (or whose parent isn't in the result set) become root nodes
3. Children are sorted by `started_at`

#### Display

Each session row shows:

| Element | Description |
|---------|-------------|
| Tree connector | Unicode `&#9492;` (corner) for non-root nodes |
| Status dot | Green + pulse animation if active (`ended_at == null`), gray if done |
| Name | `display_name` or first 12 chars of session ID + "..." |
| Status badge | "Active" (green) or "Done" (gray) |
| Event count | `{stream_event_count}t` (if > 0) |

Indentation: `8px + depth * 16px` left padding.

#### Empty State

"No sessions" / "Sessions appear when the goal runs"

---

## Goal Editing

All goal mutations go through `PATCH /api/goals/:id` and use optimistic updates on the client.

### Editable Fields from Detail View

| Field | UI Control | Location |
|-------|-----------|----------|
| `title` | Inline text input | GoalHeader |
| `model` | Select dropdown | GoalHeader |

### Optimistic Update Pattern

Used by both `handleTitleUpdate` and `handleModelChange` in `GoalDetailPage`:

1. Create optimistic goal: `{ ...goal, [field]: newValue, updated_at: Date.now() }`
2. Call `upsertGoal(optimistic)` to update the store immediately
3. PATCH the server
4. On success: upsert the server-returned goal (authoritative)
5. On failure: revert by calling `upsertGoal(originalGoal)`

### Status Transitions

Status changes are not directly available in the detail view header (they happen via the kanban board or API). The server enforces a state machine:

```
planning  --> active, complete, archived
active    --> planning, waiting, complete, archived
waiting   --> planning, active, complete, archived
complete  --> active, archived
archived  --> (terminal, no transitions out)
```

Invalid transitions return HTTP 400 with `{ error, from, to }`.

---

## Inter-Goal Messaging

The system supports communication between goals through `InterGoalMessage` objects.

### Message Types

| Type | Purpose |
|------|---------|
| `instruction` | Task delegation from one goal to another |
| `result` | Reporting results back to a control goal |
| `status_update` | Progress notifications |
| `context` | Sharing contextual information |

### Message Lifecycle

```
pending  -->  delivered  -->  acknowledged
```

- **Pending:** Created and broadcast via `goal:instruction` WS event
- **Delivered:** Auto-delivered if target goal has an active session (instruction forwarded as follow-up prompt)
- **Acknowledged:** Explicitly acknowledged via `POST /api/goals/:id/instructions/:messageId/acknowledge`

### Client-Side Storage

`useGoalsStore` maintains a `pendingInstructions: Map<string, InterGoalMessage[]>` indexed by `to_goal_id`. The `goal:instruction` WebSocket event calls `addInstruction()` to update this map.

### Relevant API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/goals/:id/instruct/:targetId` | Send instruction from one goal to another |
| GET | `/api/goals/:id/instructions` | List pending/delivered instructions for a goal |
| POST | `/api/goals/:id/instructions/:messageId/acknowledge` | Acknowledge an instruction |
| POST | `/api/goals/create-and-instruct` | Atomically create goal + send instruction + optionally spawn session |

---

## Session Association

Goals are linked to Claude Code sessions via the `current_session_id` field and the `sessions.goal_id` foreign key.

### How Sessions Link to Goals

| Action | What Happens |
|--------|-------------|
| **Goal created with `initialPrompt`** | Server spawns a terminal session and sets `current_session_id` |
| **POST `/goals/:id/messages`** | Spawns or resumes a terminal session for the goal |
| **POST `/goals/:id/terminal`** | Explicitly spawns a PTY session (uses stored `initial_prompt` if no prompt in body) |
| **POST `/goals/:id/adopt-session`** | Links an external (pre-existing) session to the goal by updating `sessions.goal_id` |

### Session Lifecycle Updates

The server broadcasts `goal:status` events when session state changes, updating `current_session_id` and `status` on the client. The `GoalSplitView` uses `current_session_id` to fetch session cost data.

### Agent Tree Relationship

The Agents tab queries all sessions with `goal_id = :id` (up to 200). Sessions have a `parent_session_id` field that creates the tree hierarchy -- this represents subagent spawning during a goal's execution.

---

## WebSocket Events

The Goal Detail View responds to these server-pushed events:

| Event | Handler | Effect |
|-------|---------|--------|
| `goal:created` | `upsertGoal` | Adds goal to store |
| `goal:updated` | `upsertGoal` | Updates goal metadata |
| `goal:status` | `upsertGoal` (merge) | Updates status + current_session_id |
| `goal:plan-updated` | `setPlan` | Updates plan in store, refreshes To Do tab |
| `message:added` | `addMessage` | Appends message, triggers auto-scroll |
| `goal:instruction` | `addInstruction` | Adds to pendingInstructions map |
| `conversation:updated` | `emitConversationUpdated` | Re-fetches conversation.md in Documents tab |
| `terminal:data` | `emitTerminalData` | Writes data to xterm instance |
| `terminal:started` | `emitTerminalStarted` | Sets terminal status to "running" |
| `terminal:exited` | `emitTerminalExited` | Sets terminal status to "exited", shows exit code |
| `session:observed` | `upsertSession` | Updates session in store (Agents tab) |
| `session:ended` | `upsertSession` (set ended_at) | Marks session as done in Agents tab |
| `hook:event` | `setActiveTool` | Tracks active tool usage per session |
| `ping` | (no-op) | Keepalive |

### Event Routing Architecture

Events flow through a centralized dispatcher in `src/lib/ws-manager.ts`:

1. WebSocket message received and parsed
2. Validated against `ServerEventSchema` (Zod discriminated union)
3. `dispatch()` routes to the appropriate Zustand store action
4. Terminal and conversation events use dedicated event emitters (`terminal-events.ts`, `conversation-events.ts`) that fan out to per-goal listeners

---

## API Endpoints

### Goal CRUD

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/goals` | Create a new goal |
| GET | `/api/goals` | List goals (filter by `?status=` and `?tag=`) |
| GET | `/api/goals/:id` | Get goal detail (goal + messages + plan) |
| PATCH | `/api/goals/:id` | Update goal fields |
| DELETE | `/api/goals/:id` | Soft-delete (archive) a goal |

### Goal Actions

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/goals/:id/messages` | Send prompt to spawn/resume session |
| POST | `/api/goals/:id/interrupt` | Interrupt the active session |
| POST | `/api/goals/:id/terminal` | Spawn PTY terminal session |
| POST | `/api/goals/:id/adopt-session` | Link external session to goal |

### Documents & Traces

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/goals/:id/documents` | List `.md` files in goal CWD |
| GET | `/api/goals/:id/document?name=X&tail=N` | Read document content |
| GET | `/api/goals/:id/trace` | Download tar of all session traces |

### Inter-Goal Messaging

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/goals/:id/instruct/:targetId` | Send instruction between goals |
| GET | `/api/goals/:id/instructions` | List pending/delivered instructions |
| POST | `/api/goals/:id/instructions/:msgId/acknowledge` | Acknowledge instruction |
| POST | `/api/goals/create-and-instruct` | Atomic create + instruct + spawn |

### Session Data (used by detail view)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sessions/:id` | Session metadata |
| GET | `/api/sessions/:id/usage` | Token/cost usage data |
| GET | `/api/sessions?goal_id=X&limit=N` | Sessions for a goal (Agents tab) |

---

## State Stores

### useGoalsStore

```typescript
interface GoalsState {
  goals: Goal[];
  pendingInstructions: Map<string, InterGoalMessage[]>;
  setGoals: (goals: Goal[]) => void;
  upsertGoal: (goal: Goal) => void;
  removeGoal: (id: string) => void;
  addInstruction: (message: InterGoalMessage) => void;
  goalsByStatus: (status: GoalStatus) => Goal[];
}
```

`upsertGoal` replaces if `id` matches, appends if new. `goalsByStatus` returns sorted by `kanban_order`.

### useMessagesStore

```typescript
interface MessagesState {
  byGoalId: Record<string, Message[]>;
  bySessionId: Record<string, Message[]>;
  addMessage: (goalId: string | null, sessionId: string, message: Message) => void;
  setMessagesForSession: (sessionId: string, messages: Message[]) => void;
}
```

Dual-indexed by goal and session. `addMessage` appends to both indices.

### usePlanStore

```typescript
interface PlanState {
  byGoalId: Record<string, PlanJson>;
  setPlan: (goalId: string, plan: PlanJson) => void;
}
```

Simple key-value store. Updated by both initial fetch and `goal:plan-updated` WS events.

---

## Error Handling

| Context | Error Response |
|---------|---------------|
| Goal not found (fetch) | Error message + "Back to Board" link |
| Goal not found (API) | HTTP 404 `{ error: "Goal not found" }` |
| Invalid status transition | HTTP 400 `{ error, from, to }` |
| Duplicate title on create | `DuplicateGoalTitleError` thrown server-side |
| Terminal spawn failure | Logged to console, no UI error |
| Message send failure | Red error banner in conversation panel |
| Document not found | Empty state in Documents tab |
| Network error on title/model update | Reverts optimistic update silently |

---

## Performance Optimizations

| Technique | Component |
|-----------|-----------|
| `React.memo` | `MessageBubble`, `PlanRenderer` |
| Debounced resize (100ms) | `TerminalPanel` ResizeObserver |
| Tail-loading with pagination | Documents tab (500 lines at a time) |
| Local state for drag interactions | `GoalSplitView` divider (no store writes during drag) |
| Cancellation tokens | All `useEffect` data fetchers use `cancelled` flags |
| WebSocket dispatch to stores | No polling; events push directly to Zustand |

---

## localStorage Keys

| Key | Purpose | Default |
|-----|---------|---------|
| `claude-deck:split-ratio` | Terminal/pane width ratio | `0.6` |
| `claude-deck:plan-pane-collapsed` | Whether right pane is collapsed | `false` |

---

## Type Reference

### Goal

```typescript
interface Goal {
  id: string;
  title: string;
  description: string | null;
  cwd: string;
  status: GoalStatus;              // 'planning' | 'active' | 'waiting' | 'complete' | 'archived'
  priority: number;
  tags: string[];
  current_session_id: string | null;
  model: GoalModel | null;         // 'opus' | 'sonnet' | 'haiku' | 'default'
  permission_mode: PermissionMode;  // 'autonomous' | 'supervised'
  plan_json: PlanJson | null;
  initial_prompt?: string | null;
  kanban_order: number;
  created_at: number;               // epoch ms
  updated_at: number;               // epoch ms
  completed_at: number | null;      // epoch ms
}
```

### Message

```typescript
interface Message {
  id: string;
  session_id: string;
  role: MessageRole;     // 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result'
  content: string | null;
  tool_name: string | null;
  tool_args: string | null;
  tool_result: string | null;
  tool_use_id: string | null;
  created_at: number;    // epoch ms
}
```

### InterGoalMessage

```typescript
interface InterGoalMessage {
  id: string;
  from_goal_id: string;
  to_goal_id: string;
  content: string;
  message_type: InterGoalMessageType;    // 'instruction' | 'result' | 'status_update' | 'context'
  status: InterGoalMessageStatus;        // 'pending' | 'delivered' | 'acknowledged'
  created_at: number;
  delivered_at: number | null;
  acknowledged_at: number | null;
}
```

---

## File Manifest

### Client Components

| File | Purpose |
|------|---------|
| `src/pages/GoalDetailPage.tsx` | Page component: data fetching, event handlers |
| `src/components/goal/GoalHeader.tsx` | Header bar with title, status, model, controls |
| `src/components/goal/GoalSplitView.tsx` | Resizable two-pane layout |
| `src/components/goal/TerminalPanel.tsx` | xterm.js PTY terminal |
| `src/components/goal/GoalConversation.tsx` | Message-based conversation container |
| `src/components/goal/MessageStream.tsx` | Scrollable message list with auto-scroll |
| `src/components/goal/MessageBubble.tsx` | Individual message renderer (memoized) |
| `src/components/goal/InputBar.tsx` | Textarea + send button |
| `src/components/goal/GoalPlanPane.tsx` | Tabbed right pane (Health, Documents, To Do, Agents) |
| `src/components/goal/ContextHealth.tsx` | Session health metrics card |
| `src/components/goal/PlanRenderer.tsx` | Hierarchical task list (memoized) |

### Client State & Events

| File | Purpose |
|------|---------|
| `src/stores/useGoalsStore.ts` | Goal state management |
| `src/stores/useMessagesStore.ts` | Message state (dual-indexed by goal and session) |
| `src/stores/usePlanStore.ts` | Plan/todo state |
| `src/lib/ws-manager.ts` | WebSocket connection + event dispatch |
| `src/lib/terminal-events.ts` | Per-goal terminal event emitters |
| `src/lib/conversation-events.ts` | Per-goal conversation update emitters |

### Shared Types

| File | Purpose |
|------|---------|
| `src/shared/types.ts` | Goal, Message, PlanJson, InterGoalMessage, etc. |
| `src/shared/schemas.ts` | Zod validation schemas |
| `src/shared/events.ts` | Server/Client event schemas (Zod discriminated unions) |

### Server

| File | Purpose |
|------|---------|
| `server/routes/goals.ts` | Goal CRUD + action endpoints |
| `server/routes/trace.ts` | Trace download endpoints |
| `server/routes/system.ts` | Document listing/reading endpoints |
| `server/services/goal-service.ts` | Goal business logic + DB operations |
| `server/services/inter-goal-message-service.ts` | Inter-goal messaging |
| `server/state-machine/goal-status.ts` | Status transition validation |
