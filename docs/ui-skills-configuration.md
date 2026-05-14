# Skills & Configuration

Reference documentation for the Skills page, Settings page, skill/memory/MCP injection at session spawn, and the Claude Deck MCP server.

---

## Skills Page

**Route:** `/skills`  
**Component:** `src/pages/SkillsPage.tsx`  
**Navigation:** Sidebar link (Sparkles icon)

The Skills page provides a tabbed interface for browsing Claude Code skills, agents, routines, and extensions. It also manages custom skill scan directories that control which skills get injected into goal sessions.

### Tab Structure

Four tabs, each with a dedicated sub-component:

| Tab | Icon | Component | Data Source |
|-----|------|-----------|-------------|
| Skills | `Sparkles` | `SkillsList` | `GET /api/skills` |
| Agents | `Bot` | `AgentsList` | `GET /api/agents` |
| Routines | `Clock` | `RoutinesList` | `GET /api/scheduled-tasks` |
| Extensions | `Puzzle` | `ExtensionsList` | `GET /api/extensions` |

Tab state is managed via `activeTab` React state (`TabId = 'skills' | 'agents' | 'routines' | 'extensions'`). No URL-based routing per tab.

### Skills Tab

Displays skills discovered by the skill scanner. Each skill renders as a clickable card showing name, description, and a scope badge (`project`, `user`, or `custom`). Clicking a card opens the markdown viewer modal with the skill's full content.

**Scan Directories panel** (only visible on Skills tab): An input field + "Add" button lets users register filesystem paths that the scanner should check for `.claude/skills/`, `.claude/agents/`, etc. Registered directories appear as removable chips below the input.

#### Skill Card Fields

- **name**: Directory name or `.md` filename (minus extension)
- **description**: Extracted from `description: <text>` pattern in the file
- **scope**: `project` (cwd `.claude/`), `user` (`~/.claude/`), or `custom` (registered directory)
- **type**: Surface type (`skills`, `agents`, `hooks`, `commands`)
- **path**: Absolute filesystem path to the skill file

### Agents Tab

Same card layout as Skills but filtered to `type === 'agents'`. Shows a `Bot` icon on each card. Empty state includes a hint: "Place .md files in `~/.claude/agents/` or `.claude/agents/`".

### Routines Tab

Displays scheduled tasks (cron-based goal creation). Cards are non-clickable and show:

- Task name with `Clock` icon
- Raw cron expression in monospace
- Human-readable cron description (via `formatCron()` helper)
- Next run and last run timestamps
- Enabled status badge: "Active" (green) or "Paused" (muted)

`formatCron()` translates common patterns:
- `* *` → "Every minute"
- `*/N *` → "Every N minutes"
- `H M * * *` → "Daily at HH:MM"
- `H M * * 1-5` → "Weekdays at HH:MM"
- Everything else → raw expression

### Extensions Tab

Reads `~/.claude/settings.json` and displays three sections:

1. **MCP Servers** — count and JSON dump of each server config (currently always empty array from the API; MCP servers from `settings.json` are not parsed yet)
2. **Plugins** — count and JSON dump of each entry from `settings.enabledPlugins`
3. **Hook Types** — count and pill badges for each key in `settings.hooks`

### Markdown Viewer Modal

**Component:** `SkillViewerModal` (defined in `src/pages/SkillsPage.tsx:551-618`)

A modal overlay that renders skill/agent markdown content. Shared by both Skills and Agents tabs.

**Opening:** `openViewer(name, filePath)` → `GET /api/skill-content?path=<encoded-path>` → sets `viewerContent`

**Rendering:** Uses `react-markdown` with `remark-gfm` plugin for GitHub Flavored Markdown (tables, strikethrough, task lists, autolinks). Extensive dark-theme prose styling via Tailwind.

**Closing:** Backdrop click, Escape key, or X button. Clears both `viewerContent` and `viewerLoading` state.

**Security:** The `/api/skill-content` endpoint validates that the path ends in `.md` and does not contain `..` (path traversal prevention).

---

## Skill Directory Management

### Database Schema

**Migration:** `server/db/migrations/008_skill_directories.sql`

```sql
CREATE TABLE IF NOT EXISTS skill_directories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  label TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Service

**File:** `server/services/skill-directory-service.ts`

Factory function `createSkillDirectoryService(db)` returns:

| Method | Description |
|--------|-------------|
| `list()` | All directories, ordered by `created_at ASC` |
| `listEnabled()` | Only rows where `enabled = 1` |
| `add(dirPath, label?)` | Inserts directory; throws on UNIQUE violation |
| `remove(id)` | Deletes by ID; returns `true` if deleted, `false` if not found |

The `enabled` column (integer 0/1) is converted to a boolean in the domain type `SkillDirectory`.

### REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/skill-directories` | List all directories |
| `POST` | `/api/skill-directories` | Add a directory (`{ path, label? }`). Returns 201 on success, 409 on duplicate. |
| `DELETE` | `/api/skill-directories/:id` | Remove by ID. Returns 200 or 404. |

### Legacy Migration

On first load, the Skills page migrates directories from localStorage key `claude-deck:skill-dirs` (a JSON array of paths) to the database. Uses a `useRef(false)` guard to ensure one-time execution. After migration, the localStorage key is removed. Failures are non-fatal (best-effort).

---

## Skill Discovery (Scanner)

**File:** `server/skill-scanner.ts`

### `scanSkills(options?)`

The single source of truth for skill scanning. Used by both the HTTP API (for the UI) and the session runner (for prompt injection).

**Discovery locations:**

1. **Project scope:** `<cwd>/.claude/<surface>` for each surface type
2. **User scope:** `~/.claude/<surface>` for each surface type
3. **Custom scope:** Paths from `options.extraDirs`, each checked for `/.claude/<surface>` subdirectories

**Surface types:** `['skills', 'agents', 'hooks', 'commands']`

**File detection rules:**
- **Directory-based skills:** Looks for `SKILL.md` inside each subdirectory. Name = directory name.
- **File-based skills:** Any `.md` file directly in the surface directory. Name = filename minus `.md`.
- **Description extraction:** Regex `description:\s*(.+)` from file content.
- **Content loading:** Only populates `skill.content` when `options.includeContent` is `true`.

**Custom directory path handling:**
- If the path already contains `/.claude/`, it's used as-is and the surface type is inferred from the path segment after `.claude/`.
- Otherwise, the scanner appends `/.claude/<surface>` for each of the 4 surface types.

### `scanSkillsForInjection(dirs, excludeCwd?)`

Wraps `scanSkills()` with two filters for session-time injection:

1. **Scope filter:** Only keeps `scope === 'custom'` skills (project/user scope skills are auto-discovered by Claude Code itself).
2. **CWD exclusion:** Skills whose path falls under the goal's `cwd` are filtered out (they're auto-discovered by Claude Code). Path comparison is case-insensitive with normalized forward slashes for Windows compatibility.

---

## Skill Injection at Session Spawn

When a goal session starts, external skills from configured directories are scanned and prepended to the initial prompt.

### Data Flow

1. **`server/index.ts:105-117`** — `SkillProvider` implementation calls `skillDirectoryService.listEnabled()` to get enabled directories from the database.
2. **`server/skill-scanner.ts:129-145`** — `scanSkillsForInjection(dirPaths, cwd)` scans those directories with `includeContent: true`, filters to custom scope, and excludes skills under the goal's `cwd`.
3. **`server/session-runner.ts:376-394`** — `buildEnrichedPrompt()` calls `skillProvider.getExternalSkills(cwd)` and formats each skill as `## Skill: <name>\n<content>`, joined by `---` separators.

### Enriched Prompt Structure

The prompt is assembled bottom-to-top (each injection prepends):

```
The following skills are available from external directories. You can use these capabilities:

## Skill: <skill-1-name>
<skill-1-SKILL.md-content>

---

## Skill: <skill-2-name>
<skill-2-SKILL.md-content>

---

## Project Memory

<contents of .claude/memory/MEMORY.md>

---

<original-user-prompt>
```

If no external skills exist, the skills block is omitted. If no MEMORY.md exists, the memory block is omitted. The original prompt always appears at the bottom.

---

## Memory Injection at Session Spawn

**File:** `server/session-runner.ts:399-417`

### How It Works

At session spawn, the runner reads `<goal.cwd>/.claude/memory/MEMORY.md`. If the file exists and is non-empty, its contents are prepended to the enriched prompt under a `## Project Memory` heading.

### Behavior

| Scenario | Result |
|----------|--------|
| File doesn't exist | `null` returned, no injection |
| File exists but empty | `null` returned, no injection |
| File exists with content | Content prepended to prompt |
| Read error | Warning logged, `null` returned (graceful degradation) |

### Path

Always `<goal.cwd>/.claude/memory/MEMORY.md` — not configurable. This is the same path Claude Code uses for its built-in memory system.

---

## MCP Configuration at Session Spawn

### Automatic Injection

Every dashboard-spawned session automatically receives the Claude Deck MCP server via the `--mcp-config` CLI argument. There is no UI for configuring this; it happens transparently.

**File:** `server/session-runner.ts:339-361`

### MCP Config Structure

```json
{
  "mcpServers": {
    "claude-deck": {
      "command": "node",
      "args": ["<project-root>/mcp/dist/index.js"],
      "env": {
        "CLAUDE_DECK_URL": "http://127.0.0.1:<port>"
      }
    }
  }
}
```

- **Entry point:** Resolved relative to the server directory: `path.resolve(__dirname, '..', 'mcp', 'dist', 'index.js')`
- **Port:** From `process.env.PORT`, defaulting to `4100`
- **Transport:** stdio (MCP server communicates via stdin/stdout with the Claude CLI subprocess)

### Graceful Degradation

If `buildMcpConfig()` fails (e.g., MCP entry point not found), it logs a warning and returns `null`. The session spawns without Claude Deck tools — no crash.

### PtyManager Duplication

`server/pty-manager.ts` contains an identical `buildMcpConfig()` method. Both SessionRunner and PtyManager inject the same MCP config.

---

## Claude Deck MCP Server

**Directory:** `mcp/src/`  
**Entry point:** `mcp/src/index.ts`  
**Server name:** `claude-deck`  
**Version:** `0.1.0`  
**Transport:** stdio

The MCP server exposes 10 tools that proxy to the Claude Deck dashboard HTTP API. All mutations flow through the dashboard API, ensuring WebSocket broadcasts and validation are unified with the UI.

### Tools

| Tool | Description | Key Inputs |
|------|-------------|------------|
| `list_goals` | List goals, optionally filter by status or tag | `status?`, `tag?` |
| `get_goal` | Get a goal with messages and plan | `goal_id` |
| `create_goal` | Create a goal, optionally spawn a session | `title`, `cwd`, `model?`, `permission_mode?`, `initialPrompt?`, `tags?` |
| `update_goal` | Update status, title, description, or tags | `goal_id`, `status?`, `title?`, `description?`, `tags?` |
| `send_message` | Send a follow-up prompt to a goal's active session | `goal_id`, `prompt` |
| `list_sessions` | List sessions by origin or active status | `origin?`, `active?` |
| `get_session_messages` | Get all messages for a session | `session_id` |
| `schedule_task` | Create a cron-based scheduled task | `name`, `cron_expr`, `goal_template` |
| `send_goal_instruction` | Send an inter-goal instruction or result | `target_goal_id`, `content`, `message_type?`, `from_goal_id?` |
| `create_goal_and_instruct` | Atomically create goal + send instruction + optionally spawn | `title`, `cwd`, `instruction`, `source_goal_id`, `model?`, `permission_mode?`, `tags?`, `spawn_session?` |

### API Client

**File:** `mcp/src/api-client.ts`

- **Base URL:** `process.env.CLAUDE_DECK_URL` or `http://127.0.0.1:4100`
- **Error types:**
  - `ApiConnectionError` — dashboard unreachable
  - `ApiError` — non-2xx HTTP response
- All tool calls wrapped in `handleToolCall()` which catches errors and returns MCP-compliant `{ content, isError: true }` responses.

### Inter-Goal Communication

Two tools enable goal-to-goal orchestration:

- **`send_goal_instruction`**: Sends a message to an existing goal. Message types: `instruction`, `result`, `status_update`, `context`.
- **`create_goal_and_instruct`**: Atomic create-and-instruct. Creates a new goal, sends it an instruction message, and optionally spawns a session. Rolls back on failure (returns 409 if duplicate title).

---

## Scheduled Tasks (Routines)

### Architecture

A cron-based scheduler creates goals from templates on a recurring schedule.

**Files:**
- `server/scheduler.ts` — `Scheduler` class, cron job lifecycle
- `server/services/scheduled-task-service.ts` — Database CRUD
- `server/routes/scheduled.ts` — REST API
- `src/components/scheduled/ScheduledTaskEditor.tsx` — Editor modal UI

### Database Schema

Table: `scheduled_tasks`

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (UUID) | Primary key |
| `name` | TEXT | Human-readable task name |
| `cron_expr` | TEXT | Standard cron expression |
| `goal_template_json` | TEXT | Serialized JSON goal template |
| `enabled` | INTEGER (0/1) | Whether the task is active |
| `last_run_at` | INTEGER | Epoch ms of last fire |
| `next_run_at` | INTEGER | Epoch ms of next scheduled fire |
| `created_at` | TEXT | ISO timestamp |

### Goal Template

The `goal_template_json` field contains a serialized object with:
- `title` — Base title (timestamp appended at fire time)
- `cwd` — Working directory for the created goal
- `model` — Optional model override
- `initialPrompt` — Optional prompt to auto-start a session
- `tags` — Optional tag array

### Scheduler Class

**File:** `server/scheduler.ts`

Uses `node-cron` for scheduling. Lifecycle:

| Method | Description |
|--------|-------------|
| `start()` | Loads all enabled tasks from DB, registers cron jobs |
| `stop()` | Stops and clears all registered jobs |
| `refresh(id)` | Re-registers a single task after create/update/delete |
| `runNow(id)` | Fires a task immediately, bypassing cron schedule |

When a cron fires, `fireTask()`:
1. Parses the goal template JSON
2. Appends an ISO timestamp to the title: `${template.title} (${timestamp})`
3. Creates a goal via the injected `GoalCreator` callback
4. Records `last_run_at` on the task

### REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/scheduled-tasks` | List all tasks |
| `POST` | `/api/scheduled-tasks` | Create task (validates cron with `cron.validate()`) |
| `PATCH` | `/api/scheduled-tasks/:id` | Update task fields |
| `DELETE` | `/api/scheduled-tasks/:id` | Delete task |
| `POST` | `/api/scheduled-tasks/:id/run-now` | Fire task immediately |

### Editor UI

**Component:** `src/components/scheduled/ScheduledTaskEditor.tsx`

Modal form with fields: task name, cron expression (with `CronPicker`), goal title, working directory, model dropdown, enabled checkbox, initial prompt textarea, and tags input. Validates required fields and cron syntax before submission.

---

## Settings Page

**Route:** `/settings` (via sidebar)  
**Component:** `src/pages/SettingsPage.tsx`  
**State:** `useConfigStore` Zustand store

### Configuration Sections

#### 1. Global Hooks

**Component:** `src/components/settings/HookInstallerSection.tsx`

Manages Claude Code hook installation in `~/.claude/settings.json`. Hooks enable observer mode, the approval gate, and plan pane feed for external sessions.

| Action | Endpoint | Description |
|--------|----------|-------------|
| Install | `POST /api/system/install-hooks` | Backs up existing settings, merges hooks, writes atomically. Idempotent. |
| Uninstall | `POST /api/system/uninstall-hooks` | Removes claude-deck hooks, restores backup. Idempotent. |
| Status | `GET /api/system/hook-status` | Returns `{ installed, installedAt }` |

The UI shows:
- Installation status badge ("Installed" / "Not installed")
- Count of installed hook types
- Confirmation dialog before install/uninstall with explanatory text

#### 2. Home Route Toggle

**Component:** `src/components/settings/HomeRouteToggle.tsx`

Selects the landing page: Kanban Board (`/board`) or Dashboard (`/dashboard`).

#### 3. Data Directory

**Component:** `src/components/settings/DataDirSection.tsx`

Read-only display of the data directory path containing `claude-deck.db`, `config.json`, and `traces/`.

#### 4. Defaults

Inline in `SettingsPage.tsx:135-189`. Controls default values applied when creating new goals:

- **Default Model** — Dropdown: Default, Opus, Sonnet, Haiku
- **Default Permission Mode** — Two-button toggle: Supervised ("Tools require approval via the dashboard") / Autonomous ("Tools are auto-approved")

#### 5. Trace Retention

Inline in `SettingsPage.tsx:192-214`. Numeric input for trace pruning threshold (1-365 days).

### Config API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/config` | Returns hardcoded defaults (persistence is a v1.1 feature) |
| `PUT` | `/api/config` | Accepts updates, logs them, but does not persist yet |

Current defaults returned by `GET /api/config`:
```json
{
  "homeRoute": "/board",
  "defaultModel": "default",
  "defaultPermissionMode": "supervised",
  "traceRetentionDays": 90
}
```

---

## Model Selection

### Type Definition

**File:** `src/shared/types.ts:5`

```typescript
type GoalModel = 'opus' | 'sonnet' | 'haiku' | 'default' | (string & {});
```

The union with `(string & {})` allows custom model names without type errors.

### Where Model Is Set

1. **Goal creation modal** (`NewGoalModal.tsx:39`) — defaults to `'default'`; stored as `undefined`/`null` in the goal when `'default'` is selected
2. **Settings page** — sets the application-wide default model
3. **MCP `create_goal` tool** — accepts `model` parameter
4. **Scheduled task templates** — stored in `goal_template_json`

### How Model Is Passed to Claude CLI

**File:** `server/session-runner.ts:322-324`

```typescript
if (this.goal.model && this.goal.model !== 'default') {
  args.push('--model', this.goal.model);
}
```

If `model` is `null` or `'default'`, the `--model` flag is omitted entirely and Claude Code uses its configured default. Same logic in `server/pty-manager.ts:85-87`.

---

## Permission Mode

### Type Definition

**File:** `src/shared/types.ts:7`

```typescript
type PermissionMode = 'autonomous' | 'supervised';
```

### Database Column

`goals.permission_mode TEXT NOT NULL DEFAULT 'supervised'`

### Where Permission Mode Is Set

1. **Goal creation modal** (`NewGoalModal.tsx:40`) — defaults to `'supervised'`
2. **Settings page** — sets the application-wide default permission mode
3. **MCP `create_goal` tool** — accepts `permission_mode` parameter

### How Permission Mode Is Passed to Claude CLI

**SessionRunner** (`server/session-runner.ts:313`):
```typescript
'--permission-mode', 'bypassPermissions',
```
Currently **hardcoded** to `bypassPermissions` regardless of the goal's setting. The dashboard's approval coordinator handles approval gating for supervised sessions at a higher level.

**PtyManager** (`server/pty-manager.ts:82-84`):
```typescript
if (this.goal.permission_mode === 'autonomous') {
  args.push('--permission-mode', 'bypassPermissions');
}
```
PtyManager respects the goal's setting — only adds `--permission-mode bypassPermissions` for autonomous goals. Supervised goals run with Claude Code's default permission behavior.

---

## Goal Creation Flow

### UI Flow (NewGoalModal)

**Component:** `src/components/kanban/NewGoalModal.tsx`

1. User fills form: title (required), working directory (required), model, permission mode, tags, initial prompt
2. Client-side validation via `CreateGoalInputSchema` (Zod)
3. Optimistic UI insert with temporary `temp-<timestamp>` ID
4. `POST /api/goals` with `CreateGoalInput`
5. On success: replace optimistic goal with real goal, close modal
6. On 409 (duplicate title): show resolution dialog with three options:
   - **Resume existing goal** — navigates to the existing goal
   - **Use a different name** — refocuses the title input
   - **Cancel** — closes the modal

### Server Flow

1. Goal created in database with `status: 'planning'`
2. If `initialPrompt` provided: spawns a session via `spawnTerminal(goalId, prompt)`
3. Session spawn triggers skill injection, memory injection, and MCP config injection

---

## CLI Arguments at Session Spawn

### SessionRunner (`server/session-runner.ts:308-333`)

Always present:
```
--output-format stream-json
--input-format stream-json
--verbose
--permission-mode bypassPermissions
--session-id <uuid>           (or --resume <uuid> for resumption)
```

Conditional:
```
--model <value>               (if model is not null/default)
--mcp-config <json-string>    (if MCP config builds successfully)
```

### PtyManager (`server/pty-manager.ts:79-93`)

```
--session-id <goal-id>
--permission-mode bypassPermissions    (only if autonomous)
--model <value>                        (if model is not null/default)
--mcp-config <json-string>             (if MCP config builds successfully)
```

### Working Directory

Set via `spawn()` options (`{ cwd: goal.cwd }`), not as a CLI flag.

---

## File Reference

### Client

| File | Purpose |
|------|---------|
| `src/pages/SkillsPage.tsx` | Skills page with 4 tabs, viewer modal, directory management |
| `src/pages/SettingsPage.tsx` | Settings page with hooks, defaults, trace retention |
| `src/components/settings/HookInstallerSection.tsx` | Hook install/uninstall UI with confirmation |
| `src/components/settings/HomeRouteToggle.tsx` | Home route selection |
| `src/components/settings/DataDirSection.tsx` | Data directory display |
| `src/components/kanban/NewGoalModal.tsx` | Goal creation form with model/permission/duplicate handling |
| `src/components/scheduled/ScheduledTaskEditor.tsx` | Scheduled task editor modal |
| `src/stores/useConfigStore.ts` | Zustand store for app configuration |
| `src/shared/types.ts` | Type definitions for `GoalModel`, `PermissionMode`, `AppConfig` |
| `src/shared/schemas.ts` | Zod schemas for `CreateGoalInput` validation |

### Server

| File | Purpose |
|------|---------|
| `server/skill-scanner.ts` | Skill discovery: `scanSkills()` and `scanSkillsForInjection()` |
| `server/services/skill-directory-service.ts` | Database CRUD for skill directories |
| `server/session-runner.ts` | Session spawn, prompt enrichment, MCP/memory/skill injection |
| `server/pty-manager.ts` | Terminal-based session spawn (parallel to SessionRunner) |
| `server/scheduler.ts` | Cron-based scheduler for recurring goal creation |
| `server/services/scheduled-task-service.ts` | Database CRUD for scheduled tasks |
| `server/routes/system.ts` | REST endpoints: skills, agents, extensions, config, hooks |
| `server/routes/scheduled.ts` | REST endpoints for scheduled tasks |
| `server/index.ts` | SkillProvider wiring, session orchestration |
| `server/db/migrations/008_skill_directories.sql` | Skill directories table migration |

### MCP Server

| File | Purpose |
|------|---------|
| `mcp/src/index.ts` | MCP server setup, tool registration, error handling |
| `mcp/src/api-client.ts` | HTTP client for dashboard API with typed errors |
| `mcp/src/tools/create-goal.ts` | `create_goal` tool implementation |
| `mcp/src/tools/create-goal-and-instruct.ts` | Atomic create + instruct tool |
| `mcp/src/tools/send-goal-instruction.ts` | Inter-goal messaging tool |
| `mcp/src/tools/schedule-task.ts` | Scheduled task creation tool |
| `mcp/src/tools/list-goals.ts` | Goal listing tool |
| `mcp/src/tools/get-goal.ts` | Goal detail tool |
| `mcp/src/tools/update-goal.ts` | Goal update tool |
| `mcp/src/tools/send-message.ts` | Session message tool |
| `mcp/src/tools/list-sessions.ts` | Session listing tool |
| `mcp/src/tools/get-session-messages.ts` | Session messages tool |
