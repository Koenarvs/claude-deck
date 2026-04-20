# claude-deck MCP Server

Standalone MCP server that exposes claude-deck operations as tools for any Claude Code session.

## Prerequisites

- claude-deck dashboard running at `http://127.0.0.1:4100` (or custom URL via `CLAUDE_DECK_URL`)
- Node.js >= 22

## Install

```bash
cd mcp
npm install
npm run build
```

## Claude Code MCP Config

Add to `~/.claude/settings.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "claude-deck": {
      "command": "node",
      "args": ["/absolute/path/to/claude-deck/mcp/dist/index.js"],
      "env": {}
    }
  }
}
```

Or if the dashboard runs on a non-default URL:

```json
{
  "mcpServers": {
    "claude-deck": {
      "command": "node",
      "args": ["/absolute/path/to/claude-deck/mcp/dist/index.js"],
      "env": {
        "CLAUDE_DECK_URL": "http://127.0.0.1:9999"
      }
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `list_goals` | List goals with optional `status` and `tag` filters |
| `get_goal` | Get a single goal with its messages and plan |
| `create_goal` | Create a new goal; optionally spawn a session with `initialPrompt` |
| `send_message` | Send a follow-up prompt to an existing goal's session |
| `list_sessions` | List Claude sessions (dashboard-spawned and external) |
| `get_session_messages` | Get all messages for a specific session |
| `schedule_task` | Create a cron-scheduled task that creates goals automatically |

## Architecture

All tools call the dashboard HTTP API rather than reading SQLite directly. This ensures:

- Mutations flow through the same validation as UI writes
- WebSocket broadcasts fire (e.g., `goal:created`) so the UI updates live
- Business logic stays centralized in the dashboard server

## Development

```bash
npm run dev        # Run with tsx (hot reload)
npm run typecheck  # Type check without emitting
npm test           # Run tests
npm run build      # Compile to dist/
npm start          # Run compiled output
```

## Verify with MCP Inspector

```bash
npx @modelcontextprotocol/inspector node mcp/dist/index.js
```

Should list all 7 tools with their input schemas.
