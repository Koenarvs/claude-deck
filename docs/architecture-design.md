# Claude Deck - System Architecture Design Document

## 1. Overview

Claude Deck is a **control plane and observatory dashboard** for managing multiple concurrent Claude Code sessions. It provides a web-based UI for creating, monitoring, and orchestrating Claude Code CLI invocations through a unified interface.

### What It Does

- **Goal Management**: Organizes work into "goals" tracked across a Kanban board with status lifecycle (planning, active, waiting, complete, archived)
- **Session Spawning**: Launches Claude Code CLI processes via PTY terminals, connecting them to goals with full terminal I/O streaming to the browser
- **Session Observation**: Captures and displays sessions started externally (outside the dashboard) via a hook system installed into `~/.claude/settings.json`
- **Inter-Goal Orchestration**: Enables goals to delegate work to other goals through an instruction-passing system
- **Approval Workflow**: Intercepts tool-use permission requests from supervised sessions and surfaces them in the UI for human review
- **Scheduled Tasks**: Creates goals on cron schedules for recurring autonomous work
- **Analytics**: Tracks token usage, costs, tool frequency, and session activity from Claude Code's JSONL logs
- **MCP Integration**: Exposes dashboard operations as MCP tools so Claude Code sessions can programmatically create goals, send messages, and orchestrate other sessions

### Architecture Pattern

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser (React SPA)                                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────────┐  │
│  │ Kanban   │  │ Goal     │  │ Sessions │  │ Analytics/     │  │
│  │ Board    │  │ Detail + │  │ List     │  │ Settings/      │  │
│  │          │  │ Terminal │  │          │  │ Scheduled      │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────────┬───────┘  │
│       │              │              │                 │          │
│       └──────────────┴──────────────┴─────────────────┘          │
│                          │ REST + WebSocket                      │
└──────────────────────────┼───────────────────────────────────────┘
                           │
┌──────────────────────────┼───────────────────────────────────────┐
│  Express v5 Server       │                                       │
│  ┌───────────────────────┴────────────────────────────────┐      │
│  │  HTTP API (/api/*)     WebSocket (/ws)                 │      │
│  │  ┌─────────┐ ┌──────────┐ ┌────────────┐ ┌─────────┐  │      │
│  │  │ Goals   │ │ Sessions │ │ Hooks      │ │ System  │  │      │
│  │  │ Router  │ │ Router   │ │ Router     │ │ Router  │  │      │
│  │  └────┬────┘ └────┬─────┘ └─────┬──────┘ └────┬────┘  │      │
│  │       └───────────┴─────────────┴──────────────┘       │      │
│  │                        │                               │      │
│  │  ┌─────────────────────┼───────────────────────────┐   │      │
│  │  │            Service Layer                        │   │      │
│  │  │  GoalService  SessionService  MessageService    │   │      │
│  │  │  InterGoalMessageService  ApprovalCoordinator   │   │      │
│  │  │  ScheduledTaskService  HookIngest  UsageService │   │      │
│  │  └─────────────────────┬───────────────────────────┘   │      │
│  │                        │                               │      │
│  │  ┌─────────────────────┼───────────────────────────┐   │      │
│  │  │         SQLite (better-sqlite3, WAL mode)       │   │      │
│  │  └─────────────────────────────────────────────────┘   │      │
│  └────────────────────────────────────────────────────────┘      │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  Process Management                                      │    │
│  │  ┌────────────┐  ┌────────────┐  ┌─────────────────┐    │    │
│  │  │ PtyManager │  │ Session    │  │ Process         │    │    │
│  │  │ (node-pty) │  │ Runner     │  │ Registry        │    │    │
│  │  │            │  │ (stream-   │  │                 │    │    │
│  │  │            │  │  json)     │  │                 │    │    │
│  │  └──────┬─────┘  └──────┬─────┘  └────────┬────────┘    │    │
│  │         └───────────────┴──────────────────┘             │    │
│  │                  spawns Claude CLI                        │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌────────────────────────┐  ┌────────────────────────────────┐  │
│  │  Scheduler (node-cron) │  │  MCP Server (stdio transport) │  │
│  │  Fires goal creation   │  │  10 tools proxying to HTTP API│  │
│  └────────────────────────┘  └────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘

  External Claude Code sessions ──── hooks/client.js ──── POST /api/hook/*
```

---

## 2. Tech Stack

### Frontend

| Technology | Version | Purpose |
|---|---|---|
| React | 19 | UI framework |
| React Router | 7 | Client-side routing |
| Vite | 6 | Dev server and build tooling |
| Tailwind CSS | 4 | Utility-first CSS |
| Zustand | 5 | Client state management |
| xterm.js | 6 | Terminal emulator in browser |
| @dnd-kit | 6/8 | Drag-and-drop for Kanban board |
| Recharts | 2 | Analytics charts |
| Lucide React | 0.474 | Icon library |
| react-markdown | 10.1 | Markdown rendering |
| react-window | 2 | Virtualized lists |
| zod | 3.23 | Schema validation (shared with server) |

### Backend

| Technology | Version | Purpose |
|---|---|---|
| Express | 5 | HTTP framework |
| ws | 8 | WebSocket server |
| better-sqlite3 | 12.9 | Embedded SQLite database |
| node-pty | 1.1 | Pseudo-terminal for Claude CLI |
| node-cron | 4 | Cron scheduler |
| pino | 10 | Structured logging |
| uuid | 11 | UUID generation |
| zod | 3.23 | Request validation |

### MCP Server

| Technology | Version | Purpose |
|---|---|---|
| @modelcontextprotocol/sdk | 1 | MCP protocol implementation |
| zod | 3.23 | Input schema validation |

### Dev Dependencies

| Technology | Purpose |
|---|---|
| TypeScript 5.5 | Static typing |
| Vitest 3 | Test runner |
| @testing-library/react 16 | React component testing |
| jsdom 27 | DOM environment for tests |
| tsx 4 | TypeScript execution |
| Prettier 3 | Code formatting |
| concurrently 9 | Parallel dev server startup |

---

## 3. Directory Structure

```
claude-deck/
├── docs/                          # Documentation
│   ├── architecture-design.md     # This document
│   ├── PROJECT.md                 # Project overview
│   ├── flow-*.md                  # Flow diagrams
│   └── ui-*.md                    # UI specifications
│
├── hooks/
│   └── client.js                  # Hook client script (Node.js stdlib only)
│                                  # Installed into ~/.claude/settings.json
│                                  # POSTs hook payloads to the server
│
├── mcp/                           # MCP server (separate package)
│   ├── package.json               # claude-deck-mcp v0.1.0
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   ├── src/
│   │   ├── index.ts               # MCP server entry — registers 10 tools
│   │   ├── api-client.ts          # Typed HTTP client for dashboard API
│   │   └── tools/                 # One file per MCP tool
│   │       ├── create-goal.ts
│   │       ├── create-goal-and-instruct.ts
│   │       ├── get-goal.ts
│   │       ├── get-session-messages.ts
│   │       ├── list-goals.ts
│   │       ├── list-sessions.ts
│   │       ├── schedule-task.ts
│   │       ├── send-goal-instruction.ts
│   │       ├── send-message.ts
│   │       └── update-goal.ts
│   └── tests/
│       ├── api-client.test.ts
│       └── tools.test.ts
│
├── scripts/
│   ├── install-hooks.ts           # CLI: installs hooks into ~/.claude/settings.json
│   ├── uninstall-hooks.ts         # CLI: removes hooks
│   └── generate-icons.ts          # Generates app icons
│
├── server/                        # Express backend
│   ├── index.ts                   # Server entry — wires all services, starts HTTP
│   ├── app.ts                     # Express app factory (CORS, JSON, error handling)
│   ├── env.ts                     # Environment variable loading
│   ├── logger.ts                  # Pino logger configuration
│   ├── ws.ts                      # WebSocket server (subscribe/broadcast model)
│   ├── session-runner.ts          # Manages Claude CLI via stream-json (legacy mode)
│   ├── pty-manager.ts             # Manages Claude CLI via node-pty (primary mode)
│   ├── stream-parser.ts           # Parses line-delimited JSON from CLI stdout
│   ├── process-registry.ts        # Tracks all active CLI subprocesses
│   ├── approval-coordinator.ts    # Deferred promise-based approval workflow
│   ├── hook-ingest.ts             # Processes incoming hook events
│   ├── scheduler.ts               # Cron job manager for scheduled tasks
│   ├── skill-scanner.ts           # Discovers .md skill/agent files on disk
│   ├── trace-pruner.ts            # Prunes old trace data
│   ├── trace-writer.ts            # Writes trace data to disk
│   ├── tar-utils.ts               # Tar archive utilities for trace export
│   │
│   ├── state-machine/
│   │   └── goal-status.ts         # Goal status transition rules
│   │
│   ├── middleware/
│   │   └── validate.ts            # Zod-based request validation middleware
│   │
│   ├── db/
│   │   ├── connection.ts          # SQLite connection factory (WAL mode)
│   │   ├── migrate.ts             # Sequential migration runner
│   │   └── migrations/            # 001-011 SQL migration files
│   │
│   ├── routes/
│   │   ├── goals.ts               # /api/goals/* — CRUD + actions
│   │   ├── sessions.ts            # /api/sessions/* — list, detail, messages
│   │   ├── hooks.ts               # /api/hook/* — hook event ingestion
│   │   ├── approvals.ts           # /api/approvals/* — approval resolution
│   │   ├── scheduled.ts           # /api/scheduled-tasks/* — CRUD + run-now
│   │   ├── system.ts              # /api/system/*, /api/config, /api/analytics/*
│   │   ├── health.ts              # /api/health
│   │   └── trace.ts               # /api/trace/* — trace download
│   │
│   └── services/
│       ├── goal-service.ts        # Goal CRUD with WS broadcast
│       ├── session-service.ts     # Session CRUD with WS broadcast
│       ├── message-service.ts     # Message persistence with WS broadcast
│       ├── inter-goal-message-service.ts  # Goal-to-goal messaging
│       ├── scheduled-task-service.ts      # Scheduled task CRUD
│       ├── hook-installer-service.ts      # Install/uninstall hooks in settings.json
│       ├── skill-directory-service.ts     # Skill directory CRUD
│       ├── trace-service.ts       # Trace file management
│       ├── usage-service.ts       # Token/cost aggregation from JSONL logs
│       ├── conversation-logger.ts # Conversation log file management
│       └── transcript-service.ts  # JSONL transcript file discovery
│
├── src/                           # React frontend
│   ├── main.tsx                   # React entry point
│   ├── main.css                   # Tailwind CSS entry
│   ├── App.tsx                    # Root component (WS init + AppShell + Outlet)
│   ├── routes.tsx                 # Route definitions
│   │
│   ├── shared/                    # Shared types (used by both client and server)
│   │   ├── types.ts               # TypeScript interfaces
│   │   ├── schemas.ts             # Zod schemas
│   │   └── events.ts              # WebSocket event schemas
│   │
│   ├── stores/                    # Zustand state stores
│   │   ├── useGoalsStore.ts       # Goals list + upsert/remove
│   │   ├── useSessionsStore.ts    # Sessions list + upsert
│   │   ├── useMessagesStore.ts    # Per-goal/session message lists
│   │   ├── useApprovalsStore.ts   # Pending approval queue
│   │   ├── useConnectionStore.ts  # WebSocket connection status
│   │   ├── useConfigStore.ts      # App configuration
│   │   ├── useActiveToolStore.ts  # Currently executing tool per session
│   │   ├── usePlanStore.ts        # Per-goal plan data
│   │   ├── useSessionHealthStore.ts # Session health metrics
│   │   └── useUIConfigStore.ts    # UI preferences (theme, layout)
│   │
│   ├── lib/                       # Client utilities
│   │   ├── api.ts                 # fetch()-based API client
│   │   ├── ws-manager.ts          # WebSocket singleton with reconnect
│   │   ├── format.ts              # Formatting helpers
│   │   ├── notifications.ts       # Browser notification helpers
│   │   ├── tab-badge.ts           # Browser tab badge management
│   │   ├── toast-store.ts         # Toast notification state
│   │   ├── terminal-events.ts     # Terminal data event bus
│   │   └── conversation-events.ts # Conversation update event bus
│   │
│   ├── hooks/                     # React hooks
│   │   ├── useApplyUIConfig.ts    # Applies UI config on mount
│   │   └── useKeyboardShortcuts.ts # Global keyboard shortcut handler
│   │
│   ├── pages/                     # Route pages
│   │   ├── KanbanPage.tsx         # Kanban board (default home)
│   │   ├── DashboardPage.tsx      # Summary dashboard
│   │   ├── GoalDetailPage.tsx     # Goal detail + terminal + plan
│   │   ├── SessionsListPage.tsx   # All sessions list
│   │   ├── SessionDetailPage.tsx  # Session detail with messages
│   │   ├── AnalyticsPage.tsx      # Usage analytics + charts
│   │   ├── ScheduledPage.tsx      # Scheduled tasks management
│   │   ├── SkillsPage.tsx         # Skills/agents browser
│   │   ├── ClaudeMdPage.tsx       # CLAUDE.md viewer
│   │   └── SettingsPage.tsx       # Settings management
│   │
│   └── components/
│       ├── AppShell.tsx           # Layout shell (sidebar + topbar + content)
│       ├── Sidebar.tsx            # Navigation sidebar
│       ├── dashboard/             # Dashboard page components
│       ├── global/                # Global UI (approvals, command palette, toast)
│       ├── goal/                  # Goal detail components (terminal, messages, plan)
│       ├── kanban/                # Kanban board components
│       ├── scheduled/             # Scheduled task components
│       ├── sessions/              # Session list/detail components
│       └── settings/              # Settings page components
│
├── tests/                         # Test files (mirrors src/ structure)
│   ├── setup.ts                   # Server test setup
│   ├── setup-dom.ts               # DOM test setup
│   ├── fixtures/
│   │   └── mock-cli.js            # Mock Claude CLI for testing
│   ├── client/                    # React component + store tests
│   ├── server/                    # Server route + service tests
│   ├── shared/                    # Shared type/schema tests
│   ├── hooks/                     # Hook client tests
│   └── scripts/                   # Install script tests
│
├── package.json                   # Root package (monolith)
├── tsconfig.json                  # Client TypeScript config
├── tsconfig.server.json           # Server TypeScript config
├── vite.config.ts                 # Vite + Tailwind + test config
└── .prettierrc.json               # Prettier config
```

---

## 4. Database Schema

Claude Deck uses **SQLite** via `better-sqlite3` with WAL mode and foreign keys enabled. The database file is stored at `<dataDir>/claude-deck.db` (default: `~/.claude-deck/claude-deck.db`).

### 4.1 Migration History

| Migration | Description |
|---|---|
| **001_init** | Creates all initial tables: `schema_migrations`, `goals`, `sessions`, `messages`, `hook_events`, `approvals`, `scheduled_tasks` |
| **002_add_permission_request** | Adds `PermissionRequest` to `hook_events.event_type` CHECK constraint |
| **003_session_hierarchy** | Adds `display_name` and `parent_session_id` columns to `sessions` |
| **004_subagent_event_types** | Adds `SubagentStart`/`SubagentStop` to `hook_events.event_type` CHECK |
| **005_relax_model_check** | Removes the enum CHECK on `goals.model`, allowing arbitrary model strings |
| **006_drop_dead_token_columns** | Drops `total_cost_usd`, `total_tokens_in`, `total_tokens_out` from sessions; drops `token_in`, `token_out` from messages (data now sourced from JSONL logs) |
| **007_inter_goal_messages** | Creates the `inter_goal_messages` table for goal-to-goal orchestration |
| **008_skill_directories** | Creates the `skill_directories` table for custom skill path configuration |
| **009_fix_inter_goal_messages_columns** | Backfill placeholder for `delivered_at`/`acknowledged_at` columns |
| **010_goal_initial_prompt** | Adds `initial_prompt` column to `goals` |
| **011_unique_goal_title** | Creates unique index `idx_goals_title_active` on `goals(title COLLATE NOCASE)` where `status != 'archived'` |

### 4.2 Table Definitions

#### `goals`

The central entity representing a unit of work.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | UUID |
| `title` | TEXT | NOT NULL | Goal title (unique among non-archived, case-insensitive) |
| `description` | TEXT | | Optional description |
| `cwd` | TEXT | NOT NULL | Working directory for Claude CLI |
| `status` | TEXT | NOT NULL, CHECK | One of: `planning`, `active`, `waiting`, `complete`, `archived` |
| `priority` | INTEGER | DEFAULT 0 | Priority ordering |
| `tags` | TEXT | | JSON array of strings |
| `current_session_id` | TEXT | | FK to active session |
| `model` | TEXT | | Claude model override (arbitrary string after migration 005) |
| `permission_mode` | TEXT | NOT NULL, DEFAULT 'supervised', CHECK | `autonomous` or `supervised` |
| `plan_json` | TEXT | | JSON: `PlanJson` with todos and raw_content |
| `initial_prompt` | TEXT | | Initial prompt to send when goal opens |
| `kanban_order` | REAL | NOT NULL | Ordering within Kanban column |
| `created_at` | INTEGER | NOT NULL | Unix timestamp (ms) |
| `updated_at` | INTEGER | NOT NULL | Unix timestamp (ms) |
| `completed_at` | INTEGER | | Unix timestamp (ms), set on completion |

**Indexes**: `idx_goals_status_kanban(status, kanban_order)`, `idx_goals_title_active(title COLLATE NOCASE) WHERE status != 'archived'`

#### `sessions`

Each Claude Code invocation, whether spawned by the dashboard or observed externally.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | Session UUID (matches Claude Code's session ID) |
| `goal_id` | TEXT | | FK to `goals.id` (nullable for external sessions) |
| `origin` | TEXT | CHECK | `dashboard` or `external` |
| `cwd` | TEXT | | Working directory |
| `model` | TEXT | | Claude model used |
| `display_name` | TEXT | | Human-readable name |
| `parent_session_id` | TEXT | | FK to parent session (for subagents) |
| `trace_dir` | TEXT | | Path to trace files |
| `stream_event_count` | INTEGER | DEFAULT 0 | Number of stream JSON events |
| `hook_event_count` | INTEGER | DEFAULT 0 | Number of hook events |
| `stderr_bytes` | INTEGER | DEFAULT 0 | Bytes of stderr output |
| `started_at` | INTEGER | | Unix timestamp (ms) |
| `ended_at` | INTEGER | | Unix timestamp (ms), null while running |

**Indexes**: `idx_sessions_status_kanban(origin, started_at)`, `idx_sessions_goal(goal_id, started_at)`, `idx_sessions_parent(parent_session_id)`

#### `messages`

Per-session chat log of user/assistant/tool exchanges.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | UUID |
| `session_id` | TEXT | NOT NULL, FK | References `sessions.id` |
| `role` | TEXT | CHECK | `user`, `assistant`, `system`, `tool_use`, `tool_result` |
| `content` | TEXT | | Message text content |
| `tool_name` | TEXT | | Tool name for tool_use messages |
| `tool_args` | TEXT | | JSON tool arguments |
| `tool_result` | TEXT | | Tool result text (truncated to 4000 chars) |
| `tool_use_id` | TEXT | | Correlation ID between tool_use and tool_result |
| `created_at` | INTEGER | | Unix timestamp (ms) |

**Index**: `idx_messages_session_created(session_id, created_at)`

#### `hook_events`

Raw log of every hook fire from Claude Code sessions.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | UUID |
| `session_id` | TEXT | | Session that fired the hook |
| `event_type` | TEXT | CHECK | `SessionStart`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `SubagentStart`, `SubagentStop`, `UserPromptSubmit`, `Stop` |
| `tool_name` | TEXT | | Tool name (for tool-related events) |
| `payload_json` | TEXT | | Full JSON payload from the hook |
| `created_at` | INTEGER | | Unix timestamp (ms) |

**Indexes**: `idx_hook_events_type_created(event_type, created_at)`, `idx_hook_events_session_created(session_id, created_at)`

#### `approvals`

Pending and resolved tool-use approval decisions.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | UUID |
| `session_id` | TEXT | | Session requesting approval |
| `goal_id` | TEXT | | Goal associated with the session |
| `tool_name` | TEXT | | Tool requiring approval |
| `tool_args` | TEXT | | JSON tool arguments |
| `status` | TEXT | NOT NULL, CHECK | `pending`, `approved`, `denied`, `timeout` |
| `decided_reason` | TEXT | | Human-provided reason for decision |
| `requested_at` | INTEGER | | Unix timestamp (ms) |
| `resolved_at` | INTEGER | | Unix timestamp (ms) |

**Index**: `idx_approvals_status_requested(status, requested_at)`

#### `scheduled_tasks`

Cron-driven goal creation templates.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | UUID |
| `name` | TEXT | NOT NULL | Human-readable task name |
| `cron_expr` | TEXT | NOT NULL | Standard 5-field cron expression |
| `goal_template_json` | TEXT | NOT NULL | JSON `GoalTemplate` (title, cwd, model, initialPrompt, tags) |
| `enabled` | INTEGER | DEFAULT 1, CHECK 0/1 | Whether the task is active |
| `last_run_at` | INTEGER | | Unix timestamp (ms) of last execution |
| `next_run_at` | INTEGER | | Computed next fire time |
| `created_at` | INTEGER | | Unix timestamp (ms) |

#### `inter_goal_messages`

Messages exchanged between goals for orchestration.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | UUID |
| `from_goal_id` | TEXT | NOT NULL, FK | Sending goal |
| `to_goal_id` | TEXT | NOT NULL, FK | Receiving goal |
| `content` | TEXT | NOT NULL | Message content |
| `message_type` | TEXT | NOT NULL, CHECK | `instruction`, `result`, `status_update`, `context` |
| `status` | TEXT | NOT NULL, DEFAULT 'pending', CHECK | `pending`, `delivered`, `acknowledged` |
| `created_at` | INTEGER | NOT NULL | Unix timestamp (ms) |
| `delivered_at` | INTEGER | | When the message was delivered to the target session |
| `acknowledged_at` | INTEGER | | When the target acknowledged receipt |

**Indexes**: `idx_igm_to_goal(to_goal_id, created_at)`, `idx_igm_from_goal(from_goal_id, created_at)`

#### `skill_directories`

Custom directories to scan for Claude Code skills.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | |
| `path` | TEXT | NOT NULL, UNIQUE | Filesystem path to skill directory |
| `label` | TEXT | | Human-readable label |
| `enabled` | INTEGER | NOT NULL, DEFAULT 1, CHECK 0/1 | Whether to include in scans |
| `created_at` | TEXT | DEFAULT datetime('now') | ISO timestamp |

---

## 5. API Layer

All API endpoints are mounted under `/api`. The server listens on port 4100 (configurable via `PORT` env var). CORS is restricted to `localhost:5173` and `localhost:4100`.

### 5.1 Goals

| Method | Path | Description | Request Body | Response |
|---|---|---|---|---|
| `POST` | `/api/goals` | Create a new goal | `CreateGoalInput` | `201` Goal (+ optional `session_id` if `initialPrompt` provided) |
| `POST` | `/api/goals/create-and-instruct` | Atomic create + instruct + optional spawn | `CreateGoalAndInstructInput` | `201` `{ goal, instruction, session_id }` |
| `GET` | `/api/goals` | List goals | Query: `?status=&tag=` | `200` Goal[] |
| `GET` | `/api/goals/:id` | Get goal detail | | `200` GoalDetail `{ goal, messages, plan }` |
| `PATCH` | `/api/goals/:id` | Update goal | `UpdateGoalInput` | `200` Goal |
| `DELETE` | `/api/goals/:id` | Archive (soft-delete) | | `200` `{ archived: true }` |
| `POST` | `/api/goals/:id/messages` | Send message / spawn terminal | `{ prompt, modelOverride? }` | `200` `{ session_id }` |
| `POST` | `/api/goals/:id/terminal` | Spawn PTY terminal | `{ prompt? }` | `200` `{ session_id, status }` |
| `POST` | `/api/goals/:id/interrupt` | Interrupt active session | | `200` `{ killed: true }` |
| `POST` | `/api/goals/:id/adopt-session` | Link external session | `{ session_id }` | `200` Goal |
| `POST` | `/api/goals/:id/instruct/:targetId` | Send inter-goal instruction | `{ content, message_type? }` | `201` InterGoalMessage |
| `GET` | `/api/goals/:id/instructions` | Get pending instructions | | `200` InterGoalMessage[] |
| `POST` | `/api/goals/:id/instructions/:messageId/acknowledge` | Acknowledge instruction | | `200` InterGoalMessage |

### 5.2 Sessions

| Method | Path | Description | Query / Body | Response |
|---|---|---|---|---|
| `GET` | `/api/sessions` | List sessions | Query: `?origin=&active=&limit=&offset=&goal_id=` | `200` Session[] (enriched with `last_event_at`, `current_tool`, `goal_title`) |
| `GET` | `/api/sessions/:id` | Get session detail | | `200` Session |
| `GET` | `/api/sessions/:id/messages` | List session messages | Query: `?limit=&before=` | `200` Message[] |
| `GET` | `/api/sessions/:id/events` | List hook events | Query: `?limit=&offset=` | `200` HookEvent[] |
| `GET` | `/api/sessions/:id/usage` | Get token usage | | `200` UsageData |
| `POST` | `/api/sessions/:id/end` | Manually end session | | `200` `{ ok, ended_at }` |
| `POST` | `/api/sessions/:id/restart` | Restart ended session | | `200` `{ ok, session_id }` |

### 5.3 Hooks (Ingestion from Claude Code)

All hook endpoints use **fail-open semantics**: server errors return `{ ok: true }` or `{ decision: "allow" }`.

| Method | Path | Event Type | Blocking? | Description |
|---|---|---|---|---|
| `POST` | `/api/hook/session-start` | SessionStart | No | Creates session row, broadcasts `session:observed` |
| `POST` | `/api/hook/user-prompt-submit` | UserPromptSubmit | No | Logs prompt submission event |
| `POST` | `/api/hook/pre-tool-use` | PreToolUse | Yes (30min) | Blocks until approval resolution (supervised) or auto-allows (autonomous) |
| `POST` | `/api/hook/post-tool-use` | PostToolUse | No | Processes tool result, extracts plan from TodoWrite |
| `POST` | `/api/hook/permission-request` | PermissionRequest | Yes (30min) | 3-option permission dialog, broadcasts for UI indicators |
| `POST` | `/api/hook/subagent-start` | SubagentStart | No | Links child session to parent |
| `POST` | `/api/hook/subagent-stop` | SubagentStop | No | Marks child session as ended |
| `POST` | `/api/hook/stop` | Stop | No | Marks session as ended |

### 5.4 Approvals

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/approvals?status=pending` | List pending approvals |
| `POST` | `/api/approvals/:id/resolve` | Resolve an approval: `{ decision: "approved"|"denied", reason? }` |

### 5.5 Scheduled Tasks

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/scheduled-tasks` | List all scheduled tasks |
| `POST` | `/api/scheduled-tasks` | Create: `{ name, cron_expr, goal_template_json, enabled? }` |
| `PATCH` | `/api/scheduled-tasks/:id` | Update task fields |
| `DELETE` | `/api/scheduled-tasks/:id` | Delete task and unregister cron |
| `POST` | `/api/scheduled-tasks/:id/run-now` | Fire task immediately |

### 5.6 System & Analytics

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/config` | Get app configuration |
| `PUT` | `/api/config` | Update configuration |
| `GET` | `/api/skills` | Scan for Claude Code skills |
| `GET` | `/api/agents` | Scan for Claude Code agent definitions |
| `GET` | `/api/skill-content?path=` | Read skill/agent .md file content |
| `GET` | `/api/extensions` | List MCP servers, plugins, hooks from settings |
| `GET` | `/api/hook-events?limit=` | Recent hook events |
| `POST` | `/api/system/install-hooks` | Install hooks into `~/.claude/settings.json` |
| `POST` | `/api/system/uninstall-hooks` | Uninstall hooks |
| `GET` | `/api/system/hook-status` | Check if hooks are installed |
| `GET` | `/api/skill-directories` | List configured skill directories |
| `POST` | `/api/skill-directories` | Add skill directory: `{ path, label? }` |
| `DELETE` | `/api/skill-directories/:id` | Remove skill directory |
| `GET` | `/api/analytics/totals` | Aggregate totals from JSONL logs |
| `GET` | `/api/analytics/tool-usage` | Tool usage counts from hook events |
| `GET` | `/api/analytics/daily-costs` | Daily cost aggregates (last 90 days) |
| `GET` | `/api/analytics/activity-heatmap` | Session counts per day (last 90 days) |
| `GET` | `/api/analytics/sessions-per-day` | Daily session counts (last 30 days) |
| `GET` | `/api/analytics/session-durations` | Session duration distribution |
| `GET` | `/api/goals/:id/documents` | List .md files in goal's cwd |
| `GET` | `/api/goals/:id/document?name=&tail=&offset=` | Read document from goal's cwd |
| `GET` | `/api/trace/sessions/:id/download` | Download session trace archive |

---

## 6. WebSocket Protocol

The WebSocket server runs at path `/ws` on the same HTTP server (port 4100). It uses a **subscribe/broadcast** model with goal-scoped filtering.

### 6.1 Client → Server Messages

All client messages are validated against `ClientMessageSchema` (discriminated union on `type`).

| Type | Payload | Description |
|---|---|---|
| `subscribe` | `{ goals: string[] \| "all" }` | Subscribe to events for specific goals or all goals |
| `unsubscribe` | `{}` | Clear all subscriptions |
| `ping` | `{}` | Keep-alive; server echoes `{ type: "ping" }` |
| `terminal:input` | `{ goal_id, data }` | Forward keyboard input to the goal's PTY |
| `terminal:resize` | `{ goal_id, cols, rows }` | Resize the goal's PTY |

### 6.2 Server → Client Events

All server events are validated against `ServerEventSchema` (discriminated union on `type`). Events are filtered by goal ID — clients only receive events for their subscribed goals.

| Type | Payload | When |
|---|---|---|
| `goal:created` | `{ goal: Goal }` | New goal created |
| `goal:updated` | `{ goal: Goal }` | Goal fields updated |
| `goal:status` | `{ id, status, current_session_id }` | Goal status changed |
| `goal:plan-updated` | `{ id, plan_json: PlanJson }` | Goal plan updated via TodoWrite hook |
| `message:added` | `{ goal_id, session_id, message: Message }` | New message in a session |
| `approval:pending` | `{ approval: Approval, goal_id }` | New approval request awaiting decision |
| `approval:resolved` | `{ id, decision }` | Approval resolved (approved/denied/timeout) |
| `session:observed` | `{ session: Session }` | New session detected (via hook or spawn) |
| `session:ended` | `{ id }` | Session ended |
| `hook:event` | `{ event: HookEvent }` | Hook event received |
| `subprocess:error` | `{ goal_id, error }` | CLI subprocess error |
| `terminal:data` | `{ goal_id, data }` | Raw terminal output from PTY |
| `terminal:started` | `{ goal_id }` | PTY terminal process started |
| `terminal:exited` | `{ goal_id, exitCode }` | PTY terminal process exited |
| `goal:instruction` | `{ message: InterGoalMessage }` | Inter-goal instruction sent |
| `conversation:updated` | `{ goal_id }` | Conversation log file changed |
| `ping` | `{}` | Keep-alive response |

### 6.3 Connection Management

The client (`ws-manager.ts`) implements:

- **Singleton connection**: One WebSocket per browser tab, persists for app lifetime
- **Auto-reconnect**: Exponential backoff starting at 1s, capping at 30s
- **Subscribe on connect**: Sends `{ type: "subscribe", goals: "all" }` on open
- **Event dispatch**: Validated events are routed to the appropriate Zustand store

### 6.4 Broadcast Filtering

The server tracks per-client subscription state:

- `subscribed: Set<string>` — specific goal IDs
- `subscribed: "all"` — receive everything

Events with a `goal_id` are only sent to clients subscribed to that goal (or `"all"`). Events without a `goal_id` go to any client with at least one subscription.

---

## 7. MCP Server

The MCP server (`mcp/`) is a separate Node.js package that exposes 10 tools via the Model Context Protocol (stdio transport). It is injected into Claude Code sessions spawned by the dashboard via the `--mcp-config` flag, enabling those sessions to programmatically interact with the dashboard.

### 7.1 Architecture

```
Claude Code Session
  └── MCP Client (built into Claude Code)
        └── stdio pipes ──── claude-deck MCP Server (node process)
                                └── HTTP client ──── Dashboard API (localhost:4100)
```

The MCP server is a thin proxy: each tool validates input via zod, calls the dashboard REST API via `DashboardApiClient`, and returns formatted text results.

### 7.2 Tools

#### `list_goals`

List goals tracked by claude-deck. Optionally filter by status or tag.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `status` | enum | No | Filter: `planning`, `active`, `waiting`, `complete`, `archived` |
| `tag` | string | No | Filter by tag |

Returns: Formatted list of goals with ID, title, status, tags.

#### `get_goal`

Get a single goal with its messages and plan.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string (UUID) | Yes | Goal ID |

Returns: Goal details including description, status, plan JSON, recent messages.

#### `create_goal`

Create a new goal. Optionally spawns a Claude session with an initial prompt.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `title` | string | Yes | Goal title |
| `cwd` | string | Yes | Working directory (absolute path) |
| `model` | enum | No | `opus`, `sonnet`, `haiku`, `default` |
| `permission_mode` | enum | No | `autonomous`, `supervised` (default) |
| `tags` | string[] | No | Tags for categorization |
| `initialPrompt` | string | No | Spawns a session immediately if provided |

Returns: Created goal with ID.

#### `update_goal`

Update an existing goal's status, title, description, or tags.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `goal_id` | string (UUID) | Yes | Goal ID |
| `status` | enum | No | New status |
| `title` | string | No | New title |
| `description` | string | No | New description (null to clear) |
| `tags` | string[] | No | New tags (replaces existing) |

Returns: Updated goal.

#### `send_message`

Send a follow-up message/prompt to an existing goal's active session.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `goal_id` | string (UUID) | Yes | Goal ID |
| `prompt` | string | Yes | Message to send |

Returns: Session ID of the receiving session.

#### `list_sessions`

List Claude sessions (dashboard-spawned and external).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `origin` | enum | No | `dashboard` or `external` |
| `active` | string | No | `true` for running, `false` for ended |

Returns: Formatted session list with ID, origin, model, status.

#### `get_session_messages`

Get all messages for a specific Claude session.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session_id` | string | Yes | Session ID |

Returns: Formatted message history.

#### `schedule_task`

Create a scheduled task that automatically creates goals on a cron schedule.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Human-readable task name |
| `cron_expr` | string | Yes | 5-field cron expression |
| `goal_template.title` | string | Yes | Template goal title |
| `goal_template.cwd` | string | Yes | Template working directory |
| `goal_template.model` | enum | No | Model override |
| `goal_template.initialPrompt` | string | No | Prompt for auto-spawned sessions |
| `goal_template.tags` | string[] | No | Tags |

Returns: Created scheduled task with ID and next run time.

#### `send_goal_instruction`

Send an instruction or result to another goal.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `from_goal_id` | string (UUID) | Yes | Sending goal |
| `target_goal_id` | string (UUID) | Yes | Receiving goal |
| `content` | string | Yes | Instruction content |
| `message_type` | enum | No | `instruction` (default), `result`, `status_update`, `context` |

Returns: Created inter-goal message with delivery status.

#### `create_goal_and_instruct`

Atomically create a new goal, send an instruction to it, and optionally spawn a session.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `title` | string | Yes | Goal title |
| `cwd` | string | Yes | Working directory |
| `instruction` | string | Yes | Instruction to send |
| `source_goal_id` | string (UUID) | Yes | Sending goal |
| `description` | string | No | Goal description |
| `model` | enum | No | Model override |
| `tags` | string[] | No | Tags |
| `spawn_session` | boolean | No | Whether to spawn immediately (default: true) |

Returns: Created goal, instruction message, and optional session ID.

---

## 8. State Management

The client uses **Zustand** for state management with 10 stores, each responsible for a specific domain. Stores are updated both by REST API responses and by real-time WebSocket events dispatched through `ws-manager.ts`.

### 8.1 Store Architecture

```
WebSocket Events (ws-manager.ts dispatch)
    │
    ├──> useGoalsStore       ← goal:created, goal:updated, goal:status, goal:instruction
    ├──> useSessionsStore    ← session:observed, session:ended
    ├──> useMessagesStore    ← message:added
    ├──> usePlanStore        ← goal:plan-updated
    ├──> useApprovalsStore   ← approval:pending, approval:resolved
    ├──> useConnectionStore  ← WS open/close/error state
    ├──> useActiveToolStore  ← hook:event (PreToolUse/PostToolUse)
    └──> (terminal events)   ← terminal:data/started/exited (via EventTarget bus)

REST API calls (api.ts)
    │
    ├──> Pages fetch initial data and set store state
    └──> Mutations call API then rely on WS events for store updates
```

### 8.2 Store Descriptions

| Store | State Shape | Purpose |
|---|---|---|
| **useGoalsStore** | `goals: Goal[]`, `pendingInstructions: Map<string, InterGoalMessage[]>` | Goal list with upsert/remove. `goalsByStatus()` sorts by kanban_order for board columns. |
| **useSessionsStore** | `sessions: Session[]` | Session list with upsert. Used by sessions page and session detail. |
| **useMessagesStore** | Per-goal and per-session message maps | Stores messages keyed by goal ID and session ID. `addMessage()` appends to both maps. |
| **useApprovalsStore** | `pending: Approval[]` | Queue of approvals awaiting UI decision. `addPending()` / `markResolved()`. Drives the global approval badge and approval cards. |
| **useConnectionStore** | `status: 'connecting' \| 'open' \| 'closed' \| 'error'` | WebSocket connection state. Drives the connection indicator in the top bar. |
| **useConfigStore** | `config: AppConfig \| null` | App configuration (home route, data dir, hooks status). |
| **useActiveToolStore** | `activeTools: Map<string, string \| null>` | Currently executing tool per session ID. Set on `PreToolUse`, cleared on `PostToolUse`. Shown as status in session list. |
| **usePlanStore** | `plans: Map<string, PlanJson>` | Per-goal plan data. Updated via `goal:plan-updated` WS event. Rendered in the plan pane of goal detail. |
| **useSessionHealthStore** | `health: Map<string, SessionHealth>` | Per-session health metrics (token usage, context size). |
| **useUIConfigStore** | `uiConfig: UIConfig` | UI preferences (sidebar collapsed, theme, etc.). Persisted to localStorage. |

### 8.3 Data Flow Patterns

**Optimistic updates**: The client does NOT do optimistic updates. All mutations go through the REST API, and the resulting state changes arrive via WebSocket broadcast events, which update the stores. This ensures consistency when multiple clients are connected.

**Initial data loading**: Pages fetch data on mount via `api.ts` and populate stores. WebSocket events keep stores in sync after initial load.

**Terminal I/O**: Terminal data flows through a custom `EventTarget` bus (`terminal-events.ts`) rather than Zustand, because xterm.js operates outside React's render cycle. The `TerminalPanel` component subscribes directly to `terminal:data` events and writes to the xterm instance.

---

## 9. Testing

### 9.1 Infrastructure

| Tool | Purpose |
|---|---|
| **Vitest 3** | Test runner with globals enabled |
| **jsdom 27** | DOM environment for React component tests |
| **@testing-library/react 16** | React component testing utilities |
| **@testing-library/jest-dom 6** | Custom DOM matchers |
| **@testing-library/user-event 14** | User interaction simulation |
| **better-sqlite3 :memory:** | In-memory databases for isolated server tests |

### 9.2 Test Configuration

Two test environments are configured:

- **Server tests** (`tests/setup.ts`): Node environment, no DOM. Each test gets a fresh in-memory SQLite database with migrations applied.
- **Client tests** (`tests/setup-dom.ts`): jsdom environment with `@testing-library/jest-dom` matchers. Vitest globals (`describe`, `it`, `expect`) are enabled.

The `vite.config.ts` test section excludes `.claude/worktrees/`, `node_modules/`, and `dist/` from test discovery.

### 9.3 Test Distribution

**58 test files, ~992 test cases** across 265 describe blocks.

| Category | Files | Coverage Area |
|---|---|---|
| **Server routes** | 6 | goals, sessions, hooks, scheduled, system, trace |
| **Server services** | 7 | goal-service, session-service, message-service, scheduled-task-service, hook-installer-service, skill-directory-service, trace-service |
| **Server core** | 11 | app, ws, session-runner, stream-parser, process-registry, approval-coordinator, hook-ingest, scheduler, skill-scanner, state-machine, trace-pruner, trace-writer, tar-utils |
| **Server DB** | 1 | migrate |
| **Client pages** | 2 | SettingsPage, SkillsPage |
| **Client components** | 6 | AppShell, GoalPlanPane, KanbanBoard, KanbanCard, PlanRenderer, Sidebar |
| **Client stores** | 7 | useActiveToolStore, useApprovalsStore, useGoalsStore, usePlanStore, useSessionHealthStore, useSessionsStore, useUIConfigStore |
| **Client hooks** | 2 | useApplyUIConfig, useKeyboardShortcuts |
| **Client integration** | 6 | dashboard, global-ux, goal-detail, kanban, scheduled, sessions |
| **Shared** | 3 | events, schemas, types |
| **MCP** | 2 | api-client, tools |
| **Hooks/scripts** | 2 | client hook, install-hooks |

### 9.4 Testing Patterns

**Server tests** follow a dependency injection pattern. Route tests create a fresh in-memory database, instantiate services, and pass them to route factory functions:

```typescript
const db = createTestDb();      // :memory: with migrations
const goalService = createGoalService(db);
const router = createGoalsRouter(goalService);
const app = createApp({ apiRouters: [router] });
// Test via supertest-like request helpers
```

**Client store tests** test Zustand stores in isolation by calling store actions directly and asserting state changes.

**Client component tests** render components with `@testing-library/react` and assert DOM state. WebSocket and API calls are mocked.

**MCP tests** mock the `DashboardApiClient` and verify that tool handlers produce correct formatted output and error messages.

---

## 10. Key Design Decisions

### 10.1 Two Session Modes

Claude Deck supports two modes for running Claude Code:

1. **PTY Mode** (primary, `PtyManager`): Spawns Claude Code via `node-pty`, providing a full interactive terminal experience streamed to the browser via xterm.js. This is what users interact with on the Goal Detail page.

2. **Stream-JSON Mode** (legacy, `SessionRunner`): Spawns Claude Code with `--output-format stream-json --input-format stream-json`, parsing structured events. This mode is used when goals are interacted with via the MCP server (programmatic, non-interactive use).

### 10.2 Hook Architecture (Fail-Open)

The hook system follows **fail-open semantics**: if the dashboard is unreachable, Claude Code continues unimpeded. The hook client (`hooks/client.js`) uses zero external dependencies (Node.js stdlib only) and exits 0 on any error.

Blocking hooks (`pre-tool-use`, `permission-request`) have a 30-minute timeout to allow ample time for human review. Non-blocking hooks timeout at 15 seconds.

### 10.3 Goal Status State Machine

```
planning ──> active ──> waiting ──> complete
    │            │          │           │
    │            │          │           └──> active (reopen)
    │            └──────────┘
    │                 ↕
    └──── any (except archived) ──> archived (terminal)
```

`archived` is a terminal state — no transitions out. The state machine is enforced at the service layer via `canTransition()`.

### 10.4 Unique Goal Titles

Goal titles must be unique among non-archived goals (case-insensitive). This is enforced both at the application layer (`DuplicateGoalTitleError`) and at the database layer (unique partial index on `title COLLATE NOCASE WHERE status != 'archived'`).

### 10.5 Session Resume

When a user opens a goal that had a previous session, the dashboard checks for an existing JSONL file (Claude Code's own session storage) and resumes the session with `--resume <session_id>` rather than starting fresh. This preserves conversation context across dashboard restarts.

### 10.6 MCP Self-Registration

When the dashboard spawns a Claude Code session (either PTY or stream-json mode), it injects the Claude Deck MCP server into the session's configuration via `--mcp-config`. This gives the spawned session access to all 10 MCP tools, enabling it to create child goals, delegate work, and report results back — forming the basis of multi-agent orchestration.

---

## 11. Configuration

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4100` | Server HTTP/WS port |
| `CLAUDE_DECK_DATA_DIR` | `~/.claude-deck` | SQLite database and data directory |
| `CLAUDE_DECK_PORT` | `4100` | Used by `hooks/client.js` |
| `CLAUDE_DECK_HOST` | `127.0.0.1` | Used by `hooks/client.js` |
| `CLAUDE_DECK_URL` | `http://127.0.0.1:4100` | Used by MCP server to connect to dashboard API |

### npm Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start both server (tsx watch) and client (vite) concurrently |
| `npm run dev:server` | Start server only with hot reload |
| `npm run dev:client` | Start Vite dev server only |
| `npm run build` | Build client (vite) and server (tsc) |
| `npm start` | Run production server |
| `npm run typecheck` | Type-check client and server configs |
| `npm test` | Run all tests (vitest run) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run format` | Format code with Prettier |
