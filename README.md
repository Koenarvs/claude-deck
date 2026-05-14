# Claude Deck

A control plane and observatory dashboard for managing multiple concurrent Claude Code sessions. Claude Deck organizes work into goals, tracks them on a Kanban board, spawns and monitors terminal sessions, and enables inter-goal orchestration — all through a browser UI.

## What It Does

- **Goal-Driven Workflow** — Create goals, track them through planning → active → waiting → complete → archived on a drag-and-drop Kanban board
- **Terminal Sessions** — Spawn Claude Code CLI processes via PTY terminals with full I/O streaming to the browser, or observe sessions started externally via hooks
- **Inter-Goal Orchestration** — Goals can delegate work to other goals through an instruction-passing system, enabling multi-agent coordination
- **Approval Workflow** — Intercept tool-use permission requests from supervised sessions and surface them in the UI for human review
- **Scheduled Tasks** — Create goals on cron schedules for recurring autonomous work
- **Analytics** — Track token usage, costs, tool frequency, and session activity from Claude Code's JSONL logs
- **MCP Integration** — 10 MCP tools let Claude Code sessions programmatically create goals, send messages, and orchestrate other sessions

## Architecture

```
Browser (React 19 + Vite)
  │  Kanban Board, Goal Detail + Terminal, Sessions, Analytics, Skills
  │
  │ REST + WebSocket
  │
Express v5 Server
  ├── Routes → Service Layer → SQLite (WAL mode)
  ├── PtyManager (node-pty) → spawns Claude Code CLI
  ├── Hook Ingest ← external Claude Code sessions
  ├── MCP Server (stdio) → 10 tools proxying to HTTP API
  └── Scheduler (node-cron) → goal creation on schedule
```

| Layer | Stack |
|-------|-------|
| Frontend | React 19, Vite 6, Tailwind CSS v4, Zustand v5, React Router v7, Recharts, @dnd-kit, @xterm/xterm, react-markdown |
| Backend | Express v5, better-sqlite3, ws, node-pty, node-cron, Pino, Zod |
| Build | TypeScript 5.5 (strict), Vitest, Prettier |
| Deploy | Docker (Alpine Node 22), PM2 |

## MCP Tools

Claude Deck exposes these tools so Claude Code sessions can interact with the dashboard programmatically:

| Tool | Purpose |
|------|---------|
| `create_goal` | Create a new goal, optionally spawn a session |
| `create_goal_and_instruct` | Create a goal and send it an instruction atomically |
| `update_goal` | Change status, title, description, or tags |
| `get_goal` | Retrieve goal details, messages, and plan |
| `list_goals` | List goals with optional status/tag filters |
| `send_message` | Send a follow-up prompt to a goal's active session |
| `send_goal_instruction` | Send an instruction from one goal to another |
| `list_sessions` | List sessions with optional origin/active filters |
| `get_session_messages` | Retrieve all messages for a session |
| `schedule_task` | Create a cron-triggered goal template |

## UI Tabs

- **Board** — Kanban columns (planning, active, waiting, complete, archived) with drag-and-drop, goal cards showing status/model/usage
- **Goal Detail** — Tabbed view with plan, research, notes, handoff, todo, and agents sub-tabs, plus an embedded terminal
- **Sessions** — List of all sessions (dashboard-spawned and external) with End/Restart controls
- **Skills** — Browse available skills, agents, routines, and extensions with .md viewer
- **Analytics** — Token usage, cost tracking, tool frequency charts
- **Settings** — Configuration and scheduled task management

## Daily Skills

Claude Deck ships with six skills for daily workflow automation. These are Claude Code slash commands that integrate with the dashboard, Jira, Outlook, and Teams.

| Skill | Command | Purpose |
|-------|---------|---------|
| Good Morning | `/goodmorning` | Daily planning — calendar, Jira sprint, email, Teams, and last session handoff review |
| Good Night | `/goodnight` | Session close-out — capture state, log time, update Jira |
| Pickup | `/pickup` | Quick session start — reload context from latest handoff and git state |
| Plan Sprint | `/plan-sprint` | Sprint planning — research stories via sub-agents, generate implementation plans |
| Start Sprint | `/start-sprint` | Sprint kickoff — validate stories, create goals per story with autonomous research |
| Sprint Close | `/sprint-close` | Sprint close-out — transition tickets, roll incomplete work, generate summary |

### Installing Skills

Copy the skills into your Claude Code user directory:

```bash
cp -r skills/* ~/.claude/skills/
```

After copying, the skills are available as slash commands in any Claude Code session. They require the Claude Deck MCP server to be configured (for goal creation and orchestration) and the Playwright MCP server (for `/goodmorning` calendar/email/Teams access).

### Playwright MCP (required for /goodmorning)

The `/goodmorning` skill reads Outlook calendar, inbox, and Teams via Playwright. Configure with a browser profile that has M365 auth cookies:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": [
        "@playwright/mcp@latest",
        "--user-data-dir",
        "<path-to-playwright-profile>"
      ]
    }
  }
}
```

### Atlassian MCP (required for Jira integration)

All skills that interact with Jira require the Atlassian MCP plugin. See the [Atlassian MCP documentation](https://github.com/anthropics/claude-code-plugins) for setup.

## Getting Started

### Prerequisites

- Node.js 22+
- A working Claude Code CLI installation (`claude` command available)

### Install and Run

```bash
git clone https://github.com/Koenarvs/claude-deck.git
cd claude-deck
npm install
npm run dev
```

The dashboard opens at `http://localhost:5173` with the API server on port `4100`.

### Hook Setup

To observe external Claude Code sessions, install the hooks into `~/.claude/settings.json`:

```bash
node scripts/install-hooks.js
```

### MCP Configuration

Add Claude Deck's MCP server to your Claude Code config to enable goal management from any session:

```json
{
  "mcpServers": {
    "claude-deck": {
      "command": "node",
      "args": ["<path-to-claude-deck>/mcp/dist/index.js"],
      "env": {
        "CLAUDE_DECK_URL": "http://localhost:4100"
      }
    }
  }
}
```

### Docker

```bash
docker-compose up
```

## Development

```bash
npm run dev          # Start server + client with hot reload
npm test             # Run all tests (Vitest)
npm run typecheck    # TypeScript check (client + server)
npm run build        # Production build
npm run format       # Prettier formatting
```

## Project Structure

```
claude-deck/
├── src/               # React frontend (components, pages, stores, hooks)
├── server/            # Express backend (routes, services, db, migrations)
├── mcp/               # MCP server (tools, client)
├── hooks/             # Claude Code hook scripts
├── scripts/           # Setup and utility scripts
├── tests/             # Test files (Vitest)
├── skills/            # Daily workflow skills (goodmorning, goodnight, etc.)
├── docs/              # Architecture docs, flow diagrams, UI guides
├── public/            # Static assets
├── Dockerfile         # Production container
└── docker-compose.yml # Docker orchestration
```

## License

Private repository. Not licensed for external use.
