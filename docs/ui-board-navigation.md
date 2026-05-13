# Board & Navigation

Reference documentation for the Kanban board, sidebar navigation, goal cards, and supporting components in Claude Deck.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Page Layout](#page-layout)
- [Sidebar Navigation](#sidebar-navigation)
  - [Structure](#sidebar-structure)
  - [Navigation Items](#navigation-items)
  - [Search Trigger](#search-trigger)
  - [Usage Strip](#usage-strip)
  - [Connection Strip](#connection-strip)
  - [Dynamic Badges](#dynamic-badges)
- [Kanban Board](#kanban-board)
  - [Page Wrapper (KanbanPage)](#kanbanpage)
  - [Board Component (KanbanBoard)](#kanbanboard)
  - [Columns (KanbanColumn)](#kanbancolumn)
  - [Drag-and-Drop System](#drag-and-drop-system)
  - [Kanban Ordering Algorithm](#kanban-ordering-algorithm)
- [Goal Cards (KanbanCard)](#kanbancard)
  - [Card Anatomy](#card-anatomy)
  - [Status Rail Colors](#status-rail-colors)
  - [Live Indicators](#live-indicators)
  - [Session Stats](#session-stats)
  - [Model Badge](#model-badge)
  - [Approval Badge](#approval-badge)
  - [Archive Action](#archive-action)
- [New Goal Modal](#new-goal-modal)
  - [Form Fields](#form-fields)
  - [Duplicate Resolution](#duplicate-resolution)
  - [Optimistic Updates](#optimistic-updates)
- [Goal Status State Machine](#goal-status-state-machine)
- [Command Palette](#command-palette)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Real-Time Updates (WebSocket)](#real-time-updates-websocket)
- [State Management](#state-management)
- [API Endpoints](#api-endpoints)
- [Design Tokens & Theming](#design-tokens--theming)
- [File Index](#file-index)

---

## Architecture Overview

The board view is the default landing page of Claude Deck (`/` redirects to `/board`). It follows a two-panel layout: a fixed-width sidebar on the left and a flexible main content area on the right. All real-time state (goal updates, session events, approvals) flows through a singleton WebSocket connection that dispatches events to Zustand stores, which React components subscribe to via selectors.

```
┌────────────────────────────────────────────────────────────────────┐
│ AppShell (flex h-screen)                                           │
│ ┌──────────┬───────────────────────────────────────────────────┐   │
│ │ Sidebar  │ <main>                                            │   │
│ │ 220px    │  ┌─ KanbanPage ────────────────────────────────┐  │   │
│ │ fixed    │  │ Header: "Board" + [+ New Goal]              │  │   │
│ │          │  │                                              │  │   │
│ │ Brand    │  │ ┌──────────────────────────────────────────┐ │  │   │
│ │ Search   │  │ │ KanbanBoard (DndContext)                 │ │  │   │
│ │ Nav      │  │ │ ┌────────┬────────┬────────┬────────┐   │ │  │   │
│ │          │  │ │ │Planning│ Active │Waiting │Complete│   │ │  │   │
│ │          │  │ │ │        │        │        │        │   │ │  │   │
│ │          │  │ │ │ Card   │ Card   │ Card   │ Card   │   │ │  │   │
│ │          │  │ │ │ Card   │ Card   │        │        │   │ │  │   │
│ │          │  │ │ │        │        │        │        │   │ │  │   │
│ │ Today $  │  │ │ └────────┴────────┴────────┴────────┘   │ │  │   │
│ │ Local ●  │  │ └──────────────────────────────────────────┘ │  │   │
│ └──────────┴─────────────────────────────────────────────────┘  │   │
│                                                                    │
│ [Global overlays: ConnectionIndicator, ToastContainer,             │
│  CommandPalette, TweaksPanel]                                      │
└────────────────────────────────────────────────────────────────────┘
```

**Key files:**

| Layer | File | Purpose |
|-------|------|---------|
| Shell | `src/components/AppShell.tsx` | Root layout: sidebar + main + overlays |
| Page | `src/pages/KanbanPage.tsx` | Board page: header, loading states, modal |
| Board | `src/components/kanban/KanbanBoard.tsx` | DnD context, columns, drag overlay |
| Column | `src/components/kanban/KanbanColumn.tsx` | Single status column with sortable context |
| Card | `src/components/kanban/KanbanCard.tsx` | Goal card with stats, indicators, actions |
| Modal | `src/components/kanban/NewGoalModal.tsx` | Create goal form with duplicate detection |
| Sidebar | `src/components/Sidebar.tsx` | Navigation, search, usage, connection |

---

## Page Layout

### AppShell (`src/components/AppShell.tsx`)

The outermost layout component. Wraps every page.

```tsx
<div className="flex h-screen bg-bg text-fg">
  <Sidebar />                    {/* Fixed 220px left panel */}
  <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
    {children}                   {/* Routed page content */}
  </main>
  <ConnectionIndicator />        {/* Fixed bottom-left status pill */}
  <ToastContainer />             {/* Notification toasts */}
  <CommandPalette />             {/* Cmd+K modal */}
  {tweaksOpen && <TweaksPanel />} {/* UI config panel */}
</div>
```

**Hooks used:**
- `useKeyboardShortcuts()` — registers global shortcuts, manages command palette state
- `useApplyUIConfig()` — applies UI preferences (theme, animation level, etc.)

---

## Sidebar Navigation

**File:** `src/components/Sidebar.tsx`

The sidebar is a 220px-wide, full-height panel pinned to the left edge. It contains four vertical sections: brand, search, navigation, and footer.

### Sidebar Structure

```
┌─────────────────────┐
│ [C] Claude Deck     │  Brand block
│      v0.1.0 · local │
├─────────────────────┤
│ 🔍 Search…    ⌘K   │  Search trigger button
├─────────────────────┤
│ ▫ Board        (3)  │  Nav items (6 total)
│ ▫ Sessions           │
│ ▫ Analytics          │
│ ▫ Scheduled          │
│ ▫ Skills             │
│ ▫ Settings           │
├─────────────────────┤
│ ┌─────────────────┐ │
│ │ TODAY     $4.23  │ │  UsageStrip
│ │ 12.3K new       │ │
│ │ 45.6K cached    │ │
│ └─────────────────┘ │
│ [—] Local           │  ConnectedStrip
│     ● connected     │
│       :4100         │
└─────────────────────┘
```

### Navigation Items

Defined as a static `navItems` array:

| Route | Label | Icon | Badge Key | Accent |
|-------|-------|------|-----------|--------|
| `/board` | Board | `LayoutGrid` | `approvals` | `true` |
| `/sessions` | Sessions | `Layers` | — | — |
| `/analytics` | Analytics | `Gauge` | — | — |
| `/scheduled` | Scheduled | `Clock` | — | — |
| `/skills` | Skills | `Sparkles` | — | — |
| `/settings` | Settings | `Settings` | — | — |

**NavItem interface:**

```typescript
interface NavItem {
  to: string;          // Route path
  label: string;       // Display label
  icon: React.ReactNode; // Lucide icon (size 15)
  badgeKey?: 'approvals' | 'active'; // Dynamic badge source
  accent?: boolean;    // Use accent color for badge (vs neutral)
}
```

Each item renders as a `<NavLink>` from React Router with active state styling:

| State | Styling |
|-------|---------|
| **Active** | `bg-hover font-medium text-fg` |
| **Inactive** | `font-normal text-dim hover:bg-hover hover:text-fg` |

### Search Trigger

A styled button (not an actual input) that visually represents the search entry point. Displays the `Search` icon and `⌘K` keyboard shortcut hint. Clicking it or pressing `Cmd/Ctrl+K` opens the Command Palette.

### Usage Strip

**Component:** `UsageStrip` (internal to `Sidebar.tsx`)

Displays aggregated daily cost and token usage across all sessions that started today:

- **Today's cost**: Summed `estimatedCostUsd` from all session usage endpoints
- **New tokens**: `inputTokens + cacheCreationTokens + outputTokens`
- **Cached tokens**: `cacheReadTokens`

Data is fetched from `GET /api/sessions?limit=50`, filtered to sessions with `started_at >= today 00:00:00`, then individual `GET /api/sessions/{id}/usage` calls per session. Refreshes every 30 seconds via `setInterval`.

Token formatting: `0` / `1.2K` / `3.4M`.

### Connection Strip

**Component:** `ConnectedStrip` (internal to `Sidebar.tsx`)

Static display showing the current connection mode:
- Avatar circle with `—` character
- Label: "Local"
- Animated pulse dot + "connected · :4100"

### Dynamic Badges

Badges appear on nav items when their `badgeKey` matches a non-zero count:

| Badge Key | Source | Store |
|-----------|--------|-------|
| `approvals` | `useApprovalsStore.pending.length` | `useApprovalsStore` |
| `active` | Sessions where `ended_at === null` | `useSessionsStore` |

Badge styling varies by the nav item's `accent` flag:

| Accent | Style |
|--------|-------|
| `true` | `bg-accent text-accent-fg` (filled accent pill) |
| `false` | `border border-line bg-inset text-dim` (neutral outline pill) |

The Board tab uses `accent: true` with the `approvals` badge key, so pending approval counts appear as a filled accent-colored pill.

---

## Kanban Board

### KanbanPage

**File:** `src/pages/KanbanPage.tsx`

The page wrapper handles data loading and top-level UI:

1. **On mount**: Fetches `GET /api/goals` → validates with `z.array(GoalSchema)` → calls `setGoals()` on the goals store
2. **Loading state**: Centered "Loading goals..." text
3. **Error state**: Centered error message in danger color
4. **Header**: Title "Board" + `[+ New Goal]` button (accent-styled, `Plus` icon)
5. **Content**: Renders `<KanbanBoard />` once loaded
6. **Modal**: `<NewGoalModal open={modalOpen} onClose={closeModal} />`

### KanbanBoard

**File:** `src/components/kanban/KanbanBoard.tsx`

The core board component. Wraps all columns in a `@dnd-kit/core` `DndContext`.

**Visible columns** (the `VISIBLE_STATUSES` constant — `archived` is excluded):

```typescript
const VISIBLE_STATUSES: GoalStatus[] = ['planning', 'active', 'waiting', 'complete'];
```

**Layout:** A horizontal flex container with 4 fixed-width columns, horizontal scrolling when needed:

```tsx
<div className="flex h-full min-h-0 gap-4 overflow-x-auto pb-4">
  {VISIBLE_STATUSES.map(status => (
    <KanbanColumn key={status} status={status} goals={goalsByStatus(status)} />
  ))}
</div>
```

**DnD sensors:**

| Sensor | Config | Purpose |
|--------|--------|---------|
| `PointerSensor` | `activationConstraint: { distance: 5 }` | Mouse/touch drag with 5px dead zone to avoid accidental drags |
| `KeyboardSensor` | `coordinateGetter: sortableKeyboardCoordinates` | Arrow key reordering for accessibility |

**Collision detection:** `closestCorners` — determines which droppable zone the dragged item is closest to.

**Drag overlay:** Renders a ghost copy of the dragged card with visual treatment:

```tsx
<DragOverlay dropAnimation={null}>
  <div className="w-72 rotate-2 opacity-80 shadow-xl">
    <KanbanCard goal={activeGoal} />
  </div>
</DragOverlay>
```

- `rotate-2`: Slight rotation for visual feedback
- `opacity-80`: Semi-transparent
- `shadow-xl`: Elevated shadow
- `dropAnimation={null}`: No spring animation on drop (instant placement)

### KanbanColumn

**File:** `src/components/kanban/KanbanColumn.tsx`

Each column represents a single `GoalStatus` and acts as both a droppable zone and a sortable context.

**Props:**

| Prop | Type | Description |
|------|------|-------------|
| `status` | `GoalStatus` | The status this column represents |
| `goals` | `Goal[]` | Pre-filtered and sorted goals for this status |

**Column header colors** — a colored top border for visual status identification:

| Status | CSS Variable | Visual |
|--------|-------------|--------|
| `planning` | `--cd-warn` | Warm yellow/amber |
| `active` | `--cd-accent` | Theme accent color |
| `waiting` | `--cd-dim` | Muted gray |
| `complete` | `--cd-ok` | Green |
| `archived` | `--cd-faint` | Very faint gray |

**Column anatomy:**

```
┌──────────────────────────┐
│ Planning            (3)  │  ← Header: label + count badge
├──────────────────────────┤
│ ┌──────────────────────┐ │
│ │ Card 1               │ │  ← Sortable goal cards
│ └──────────────────────┘ │
│ ┌──────────────────────┐ │
│ │ Card 2               │ │
│ └──────────────────────┘ │
│ ┌──────────────────────┐ │
│ │ Card 3               │ │
│ └──────────────────────┘ │
└──────────────────────────┘
```

**Empty state:** When a column has zero goals, it shows an `Inbox` icon (size 24, 50% opacity) and "No goals" text in faint color.

**Count badge:** A small pill next to the column label showing the number of goals, styled with monospace tabular figures: `mono-tabular inline-flex h-5 min-w-[1.25rem] ... text-[10px]`.

**Drop target feedback:** When `isOver` is true (a card is dragged over this column), the column gets `ring-2 ring-accent/40` — a subtle accent-colored ring.

**Column width:** Fixed at `w-72` (288px), `flex-shrink-0`.

**Scrolling:** Each column's card area scrolls independently via `overflow-y-auto`.

### Drag-and-Drop System

Built on `@dnd-kit/core` + `@dnd-kit/sortable`.

**Flow:**

1. **Drag start**: `handleDragStart` stores the active goal in a ref (for rendering the drag overlay)
2. **Drag end**: `handleDragEnd` processes the drop:
   - Resolves the target status from the drop container ID
   - Computes the new `kanban_order` using the ordering algorithm
   - Determines if status or order changed (skips no-ops)
   - Performs optimistic update via `upsertGoal()`
   - Sends `PATCH /api/goals/{id}` with `{ status?, kanban_order? }`
   - On failure: rolls back to original goal state

**Container ID convention:**
- Columns use IDs formatted as `column-{status}` (e.g., `column-planning`)
- Cards use the goal's UUID as the sortable ID

**Resolution logic** (`resolveDropStatus`): If the drop target ID starts with `column-`, extract the status directly. Otherwise, find the goal with that ID and return its status.

### Kanban Ordering Algorithm

**Function:** `computeKanbanOrder(columnGoals, dropIndex, draggedGoalId)`

Goals within a column are ordered by a floating-point `kanban_order` field. The algorithm computes a new order value based on the drop position:

| Drop Position | Computation | Example |
|---------------|-------------|---------|
| Empty column | `1.0` | — |
| Before first card | `first.kanban_order / 2` | First=1.0 → 0.5 |
| Between two cards | `(before.kanban_order + after.kanban_order) / 2` | 1.0, 3.0 → 2.0 |
| After last card | `last.kanban_order + 1.0` | Last=3.0 → 4.0 |

The dragged goal is filtered out of the column before computing to avoid self-reference issues.

**Store sorting:** `goalsByStatus(status)` in the goals store returns goals sorted by `kanban_order` ascending:

```typescript
goalsByStatus: (status) =>
  get().goals
    .filter((g) => g.status === status)
    .sort((a, b) => a.kanban_order - b.kanban_order),
```

---

## KanbanCard

**File:** `src/components/kanban/KanbanCard.tsx`

The primary visual unit on the board. Each card represents a single goal and is both a sortable drag handle and a clickable navigation target.

### Card Anatomy

```
┌─ ┬──────────────────────────────┐
│  │ Implement user auth          │  Title (line-clamp-2)
│  │ …/my-project/src             │  Working directory (truncated)
│S │ ████████░░░░░░░░░░░░  42%    │  Context bar (active/waiting only)
│T │ ● Running                    │  Activity indicator (active only)
│A │ ⚠ Bash                       │  Approval badge (when pending)
│T │ ⏸ Idle                       │  Idle indicator (waiting, no approval)
│U │                              │
│S │ [Opus]  3t  $0.42  12.3K [🗑]│  Model + stats + archive
│  │                              │
└─ ┴──────────────────────────────┘
 ↑ 3px colored left border (status rail)
```

### Status Rail Colors

The left border of each card is 3px wide and colored by goal status:

| Status | CSS Variable | Color |
|--------|-------------|-------|
| `planning` | `--cd-warn` | Yellow/amber |
| `active` | `--cd-accent` | Theme accent |
| `waiting` | `--cd-dim` | Gray |
| `complete` | `--cd-ok` | Green |
| `archived` | `--cd-faint` | Faint gray |

### Card Sections (Top to Bottom)

#### 1. Title

```tsx
<h3 className="text-[13px] font-medium leading-snug text-fg line-clamp-2">
  {goal.title}
</h3>
```

- Font: 13px, medium weight
- Truncation: 2-line clamp
- Color: `text-fg` (primary foreground)

#### 2. Working Directory

```tsx
<FolderOpen size={10} /> {shortenCwd(goal.cwd)}
```

- `shortenCwd()`: If the path has more than 2 segments, shows `…/last-two/parts`. Normalizes backslashes to forward slashes.
- Font: 10px monospace (`mono-tabular`), `text-faint`
- Icon: `FolderOpen` at 10px

#### 3. Context Bar (Active/Waiting Goals Only)

A horizontal progress bar showing context window usage percentage. Only rendered when `goal.status` is `active` or `waiting` and stats have loaded.

```tsx
<div className="h-[4px] flex-1 overflow-hidden rounded-full bg-inset">
  <div className={`h-full rounded-full ${colorClass}`}
       style={{ width: `${Math.min(100, contextPct)}%` }} />
</div>
<span className="mono-tabular text-[10px] text-faint">{contextPct}%</span>
```

| Context % | Bar Color | Semantic |
|-----------|-----------|----------|
| 0–50% | `bg-accent` | Normal |
| 51–80% | `bg-warn` | Warning |
| 81–100% | `bg-danger` | Critical |

#### 4. Activity Indicator (Active Goals Only)

```tsx
<span className="pulse-dot !h-[5px] !w-[5px]" />
<span className="mono-tabular text-[10px] text-accent">
  {activeTool ?? 'Running'}
</span>
```

- Shows a pulsing green dot and the currently executing tool name (e.g., "Read", "Bash", "Edit")
- Falls back to "Running" when no specific tool is active
- Tool name comes from the `useActiveToolStore`, updated via `hook:event` WebSocket events (`PreToolUse` sets it, `PostToolUse` clears it)

#### 5. Approval Badge (When Pending)

```tsx
<AlertCircle size={11} className="text-warn" />
<span className="mono-tabular truncate text-[10px] text-warn">
  {pendingApproval.tool_name}
</span>
```

- Appears when the approval store has a pending approval matching this goal's ID
- Shows the tool name awaiting approval (e.g., "Bash", "Write")
- Orange/yellow warning color
- Takes visual priority over the idle indicator

#### 6. Idle Indicator (Waiting Goals, No Pending Approval)

```tsx
<Pause size={11} className="text-faint" />
<span className="mono-tabular text-[10px] text-faint">Idle</span>
```

- Only shown for `waiting` status goals that have no pending approval
- Gray/faint styling

#### 7. Stats Row (Bottom)

The bottom row contains three elements:

**Model badge** (left, conditional):

| Model | Label | Text Color |
|-------|-------|------------|
| `opus` | "Opus" | `text-amber-400` |
| `sonnet` | "Sonnet" | `text-indigo-400` |
| `haiku` | "Haiku" | `text-emerald-400` |
| `default` | — | (not shown) |

Badge uses `Cpu` icon (9px) and renders as an inline pill with `bg-accent-soft`. Hidden when model is `default` or `null`.

**Stats** (right-aligned, conditional):

| Stat | Format | Example | Condition |
|------|--------|---------|-----------|
| Turns | `{n}t` | `12t` | `turns > 0` |
| Cost | `$X.XX` | `$1.42` | `cost > 0` |
| Tokens | `{fmtTokens(n)}` | `45.6K` | `tokens > 0` |

All stats use `mono-tabular text-[10px] text-faint`.

**Archive button** (far right):

- `Archive` icon (12px), hidden by default (`opacity-0`)
- Appears on card hover (`group-hover:opacity-100`)
- Click: `DELETE /api/goals/{id}` → `removeGoal(id)` on success
- Stops event propagation to avoid navigating to goal detail

### Session Stats Loading

Stats are loaded asynchronously per card on mount:

1. `GET /api/goals/{id}` — to get the current `current_session_id`
2. `GET /api/sessions/{sessionId}` — for `stream_event_count` (turns)
3. `GET /api/sessions/{sessionId}/usage` — for token and cost data

Stats are computed as:
- `tokensIn` = `inputTokens + cacheCreationTokens + cacheReadTokens`
- `tokensOut` = `outputTokens`
- `cost` = `estimatedCostUsd`
- `contextPct` = `contextPct` (from usage endpoint)

The effect re-runs when `goal.id`, `goal.current_session_id`, or `goal.model` changes.

### Click / Keyboard Behavior

- **Click**: Navigates to `/goals/{goal.id}` (goal detail page)
- **Enter / Space**: Same navigation (keyboard accessible)
- **ARIA**: `role="button"`, `tabIndex={0}`, `aria-label="Goal: {title}"`

### Drag State

When a card is being dragged:
- `isDragging` adds `z-50 opacity-50 shadow-lg` — the original card fades while the overlay shows the ghost copy
- Transform and transition are applied via `@dnd-kit/utilities` `CSS.Transform.toString()`

---

## New Goal Modal

**File:** `src/components/kanban/NewGoalModal.tsx`

A dialog for creating new goals, opened from the "New Goal" button in the KanbanPage header.

### Form Fields

| Field | Type | Required | Validation | Placeholder |
|-------|------|----------|------------|-------------|
| Title | `<input text>` | Yes | `CreateGoalInputSchema` | "What do you want to accomplish?" |
| Working Directory | `<input text>` | Yes | `CreateGoalInputSchema` | "/path/to/project" |
| Model | `<select>` | No | — | Default |
| Permission | `<select>` | No | — | Supervised |
| Tags | `<input text>` | No | Comma-split | "comma-separated (e.g. frontend, bugfix)" |
| Initial Prompt | `<textarea>` | No | — | "What should Claude work on first?" |

**Model options:** Default, Opus, Sonnet, Haiku

**Permission options:** Supervised, Autonomous

### Duplicate Resolution

When the server returns `409 Conflict` with `existing_goal_id` in the response body, the modal switches to a duplicate resolution view:

```
A goal named "Existing Title" already exists.

[Resume existing goal]     ← navigates to /goals/{existing_id}
[Use a different name]     ← re-focuses the title input
[Cancel]                   ← closes the modal
```

The `ApiError` class parses the response to extract `existing_goal_id` and `existing_title`.

### Optimistic Updates

1. A temporary goal with `id: "temp-{timestamp}"` is inserted into the store immediately
2. On API success: remove temp goal, insert real goal
3. On API failure: remove temp goal, show error message

### Modal Behavior

- **Close triggers**: Escape key, backdrop click, Cancel button, close icon
- **Form reset**: All fields clear on close
- **Focus**: Title input gets `autoFocus` on open
- **ARIA**: `role="dialog"`, `aria-modal="true"`, `aria-label="Create new goal"`

---

## Goal Status State Machine

**File:** `server/state-machine/goal-status.ts`

The server enforces valid status transitions. Drag-and-drop on the board triggers `PATCH /api/goals/{id}` with the new status, which is validated against this state machine.

### Transition Diagram

```
          ┌────────────────────────────────────────┐
          │                                        │
          ▼                                        │
     ┌──────────┐    sendMessage    ┌────────┐     │
     │ planning │ ─────────────────>│ active │     │
     └──────────┘                   └────────┘     │
       │   │  ▲                      │  │  ▲       │
       │   │  │                      │  │  │       │
       │   │  └──────────────────────┘  │  │       │
       │   │       (back to planning)   │  │       │
       │   │                            │  │ reopen│
       │   │         wait/done          │  │       │
       │   │    ┌───────────────────────┘  │       │
       │   │    │           │              │       │
       │   │    ▼           ▼              │       │
       │   │ ┌─────────┐ ┌──────────┐     │       │
       │   │ │ waiting │ │ complete │─────┘       │
       │   │ └─────────┘ └──────────┘              │
       │   │    │                   │               │
       │   │    │    sendMessage    │               │
       │   │    └──────────────────►│ (to active)  │
       │   │                        │               │
       │   └────────────────────────┼───────────────┘
       │          archive           │   archive
       │                            │
       ▼                            ▼
  ┌──────────┐                (all non-archived
  │ archived │◄────────────── statuses can archive)
  └──────────┘
   (terminal)
```

### Allowed Transitions Table

| From | To (allowed) |
|------|-------------|
| `planning` | `active`, `complete`, `archived` |
| `active` | `planning`, `waiting`, `complete`, `archived` |
| `waiting` | `planning`, `active`, `complete`, `archived` |
| `complete` | `active`, `archived` |
| `archived` | *(none — terminal state)* |

### API Functions

```typescript
canTransition(from: GoalStatus, to: GoalStatus): boolean
allowedTransitions(from: GoalStatus): GoalStatus[]
```

On the board, dragging a card from one column to another triggers a status transition. The server validates with `canTransition()` before persisting. Invalid transitions return `400` with `{ error, from, to }`.

---

## Command Palette

**File:** `src/components/global/CommandPalette.tsx`

A modal overlay for keyboard-driven navigation, opened via `Cmd/Ctrl+K`.

### Available Commands

| ID | Label | Shortcut | Route |
|----|-------|----------|-------|
| `board` | Board | `G B` | `/board` |
| `dashboard` | Dashboard | `G D` | `/dashboard` |
| `sessions` | Sessions | — | `/sessions` |
| `feed` | Feed | `G F` | `/feed` |
| `analytics` | Analytics | `G A` | `/analytics` |
| `scheduled` | Scheduled | — | `/scheduled` |
| `skills` | Skills | — | `/skills` |
| `claude-md` | CLAUDE.md | — | `/claude-md` |
| `settings` | Settings | `G S` | `/settings` |

### Interaction

- **Search**: Filters commands by label substring match (case-insensitive)
- **Arrow keys**: Move selection up/down
- **Enter**: Navigate to selected command's route
- **Escape**: Close palette
- **Mouse**: Click to select, hover to highlight

### Accessibility

- `role="dialog"`, `aria-modal="true"`
- Input: `role="combobox"`, `aria-expanded="true"`, `aria-controls="command-list"`, `aria-autocomplete="list"`
- List: `role="listbox"` with `role="option"` items and `aria-selected` state
- `aria-activedescendant` points to the currently highlighted option

---

## Keyboard Shortcuts

**File:** `src/hooks/useKeyboardShortcuts.ts`

Global keyboard shortcuts, registered via a `keydown` listener on `document`. Shortcuts are suppressed when focus is in `INPUT`, `TEXTAREA`, `SELECT`, or `contentEditable` elements (except `Escape`).

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl + K` | Toggle command palette |
| `Escape` | Close command palette / close modals |
| `G then B` | Navigate to `/board` |
| `G then D` | Navigate to `/dashboard` |
| `G then F` | Navigate to `/feed` |
| `G then A` | Navigate to `/analytics` |
| `G then S` | Navigate to `/settings` |

**Chord behavior:** Pressing `G` starts a 1-second window. If a valid target key is pressed within that window, navigation occurs. The chord state resets after the timeout or after any key press following `G`.

---

## Real-Time Updates (WebSocket)

**File:** `src/lib/ws-manager.ts`

A module-level singleton WebSocket connection that subscribes to all server events. The connection persists for the application lifetime and auto-reconnects with exponential backoff (1s base, 30s max).

### Events Relevant to the Board

| Event | Store Action | Board Effect |
|-------|-------------|--------------|
| `goal:created` | `upsertGoal()` | New card appears in the appropriate column |
| `goal:updated` | `upsertGoal()` | Card reflects updated title, tags, model, etc. |
| `goal:status` | `upsertGoal()` with merged status | Card moves to a different column |
| `approval:pending` | `addPending()` | Approval badge appears on the card |
| `approval:resolved` | `markResolved()` | Approval badge disappears |
| `hook:event` (PreToolUse) | `setActiveTool()` | Active tool name shown on card |
| `hook:event` (PostToolUse) | `setActiveTool(null)` | Tool name clears, shows "Running" |
| `session:ended` | `upsertSession()` | Session stats may update |
| `goal:instruction` | `addInstruction()` | Pending instruction count tracked |

---

## State Management

### Goals Store (`src/stores/useGoalsStore.ts`)

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

- `setGoals`: Bulk replace (initial load)
- `upsertGoal`: Insert or replace by ID (WebSocket events, optimistic updates)
- `removeGoal`: Filter out by ID (archive, optimistic rollback)
- `goalsByStatus`: Derived selector — filters by status, sorts by `kanban_order` ascending

### Approvals Store (`src/stores/useApprovalsStore.ts`)

```typescript
interface ApprovalsState {
  pending: Approval[];         // Active approval requests
  resolved: Approval[];       // Recent history (max 100)
  addPending: (approval: Approval) => void;
  markResolved: (id: string, decision: ApprovalDecision) => void;
}
```

### Active Tool Store (`src/stores/useActiveToolStore.ts`)

```typescript
interface ActiveToolState {
  bySessionId: Record<string, string | null>;  // sessionId → tool name
  setActiveTool: (sessionId: string, toolName: string | null) => void;
  clearSession: (sessionId: string) => void;
}
```

Cards look up `activeTool` by the goal's `current_session_id`. When a `PreToolUse` hook event arrives via WebSocket, the tool name is set; `PostToolUse` clears it.

### Connection Store (`src/stores/useConnectionStore.ts`)

```typescript
type ConnectionStatus = 'connecting' | 'open' | 'closed' | 'error';
```

Drives the `ConnectionIndicator` overlay at the bottom-left of the screen.

---

## API Endpoints

Endpoints used by the board and its components:

| Method | Path | Purpose | Used By |
|--------|------|---------|---------|
| `GET` | `/api/goals` | List all goals | `KanbanPage` (initial load) |
| `GET` | `/api/goals/:id` | Get goal detail | `KanbanCard` (stats loading) |
| `POST` | `/api/goals` | Create new goal | `NewGoalModal` |
| `PATCH` | `/api/goals/:id` | Update status/order | `KanbanBoard` (drag-and-drop) |
| `DELETE` | `/api/goals/:id` | Archive goal | `KanbanCard` (archive button) |
| `GET` | `/api/sessions/:id` | Session detail | `KanbanCard` (stats) |
| `GET` | `/api/sessions/:id/usage` | Token/cost usage | `KanbanCard` (stats), `UsageStrip` |
| `GET` | `/api/sessions?limit=50` | List sessions | `UsageStrip` (daily aggregation) |

**Query parameters for `GET /api/goals`:**

| Param | Type | Description |
|-------|------|-------------|
| `status` | `GoalStatus` | Filter by status |
| `tag` | `string` | Filter by tag |

**Body for `PATCH /api/goals/:id`:**

```typescript
interface UpdateGoalInput {
  title?: string;
  description?: string | null;
  status?: GoalStatus;          // Validated against state machine
  priority?: number;
  tags?: string[];
  model?: GoalModel | null;
  permission_mode?: PermissionMode;
  kanban_order?: number;         // Floating-point ordering
}
```

**Error responses:**

| Status | Condition | Body |
|--------|-----------|------|
| `400` | Invalid status transition | `{ error, from, to }` |
| `404` | Goal not found | `{ error }` |
| `409` | Duplicate goal name | `{ error, existing_goal_id, existing_title }` |
| `500` | Server error | `{ error }` |

---

## Design Tokens & Theming

The board uses CSS custom properties (design tokens) for consistent theming across multiple color schemes.

### Status-Semantic Tokens

| Token | Semantic Use | Board Usage |
|-------|-------------|-------------|
| `--cd-warn` | Planning / caution | Planning column header, approval text |
| `--cd-accent` | Active / primary action | Active column header, accent badges, context bar (normal) |
| `--cd-dim` | Waiting / muted | Waiting column header, stats text |
| `--cd-ok` | Complete / success | Complete column header, pulse dot |
| `--cd-faint` | Archived / very subtle | Archived styling, idle indicators |
| `--cd-danger` | Error / critical | Context bar (>80%), archive hover |

### Themes Available

The application supports multiple themes via `data-theme` attribute:

- **Dark** (default dark)
- **Light** (default light)
- **Matrix Dark** / **Matrix Light** (green-tinted)
- **Ocean Dark** / **Ocean Light** (blue-tinted)

Each theme overrides the full set of `--cd-*` tokens.

### Typography Classes

| Class | Usage |
|-------|-------|
| `mono-tabular` | Monospace text with tabular figures — used for stats, counts, costs |
| `text-fg` | Primary foreground text |
| `text-dim` | Secondary/muted text |
| `text-faint` | Tertiary/very muted text |
| `text-accent` | Accent-colored text |

### Animation: Pulse Dot

Defined in `src/main.css` as a `@utility` rule:

```css
@utility pulse-dot {
  position: relative;
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  background: var(--cd-ok);
}
.pulse-dot::after {
  /* Expanding ring animation */
  border: 2px solid var(--cd-ok);
  animation: pulse-ring 2.5s ease-out infinite;
}
```

Animation respects the `data-live` attribute:
- `data-live="off"`: Animation disabled
- `data-live="subtle"`: Slower animation (3.5s), reduced opacity (0.25)

---

## File Index

Complete list of files covered in this document:

| File | Category |
|------|----------|
| `src/components/AppShell.tsx` | Layout |
| `src/components/Sidebar.tsx` | Navigation |
| `src/pages/KanbanPage.tsx` | Page |
| `src/components/kanban/KanbanBoard.tsx` | Board |
| `src/components/kanban/KanbanColumn.tsx` | Board |
| `src/components/kanban/KanbanCard.tsx` | Board |
| `src/components/kanban/NewGoalModal.tsx` | Board |
| `src/components/global/CommandPalette.tsx` | Navigation |
| `src/components/global/ConnectionIndicator.tsx` | Overlay |
| `src/hooks/useKeyboardShortcuts.ts` | Navigation |
| `src/stores/useGoalsStore.ts` | State |
| `src/stores/useApprovalsStore.ts` | State |
| `src/stores/useActiveToolStore.ts` | State |
| `src/stores/useConnectionStore.ts` | State |
| `src/shared/types.ts` | Types |
| `src/shared/events.ts` | Types |
| `src/lib/api.ts` | API |
| `src/lib/format.ts` | Utilities |
| `src/lib/ws-manager.ts` | WebSocket |
| `src/routes.tsx` | Routing |
| `src/main.css` | Styles |
| `server/state-machine/goal-status.ts` | Server |
| `server/routes/goals.ts` | Server |
