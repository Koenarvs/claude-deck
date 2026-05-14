# Claude Deck Documentation

Reference documentation for the Claude Deck control plane and observatory dashboard.

## Reading Order

Start with the architecture design document for a complete system overview, then dive into specific areas as needed.

### System Architecture

| Document | Description |
|----------|-------------|
| [Architecture Design](architecture-design.md) | Full system design: tech stack, directory structure, database schema, API endpoints, WebSocket protocol, MCP server, state management, testing |

### UI Reference

| Document | Description |
|----------|-------------|
| [Board & Navigation](ui-board-navigation.md) | Kanban board, drag-and-drop, goal cards, sidebar, command palette, keyboard shortcuts, theming |
| [Goal Detail View](ui-goal-detail.md) | Split-pane layout, terminal panel, plan/health/documents/agents tabs, inter-goal messaging |
| [Sessions & Terminal](ui-sessions-terminal.md) | Sessions list, xterm.js terminal, PTY manager, session runner, transcript replay, token/cost display |
| [Skills & Configuration](ui-skills-configuration.md) | Skills browser, skill/memory/MCP injection, scheduled tasks, settings page |

### Process Flows (Mermaid Diagrams)

| Document | Description |
|----------|-------------|
| [Goal Lifecycle](flow-goal-lifecycle.md) | Goal creation, state machine, session spawn, goal-to-session linking, scheduled tasks |
| [Communication & Orchestration](flow-communication-orchestration.md) | Inter-goal messaging, MCP tool request flow, WebSocket events, multi-agent fan-out/fan-in |
| [Resilience & Recovery](flow-resilience-recovery.md) | Session failure, server restart, WS reconnection, error propagation, idle detection, known limitations |

## Key Concepts

- **Goal**: A unit of work tracked on the Kanban board. Has a lifecycle: planning > active > waiting > complete > archived.
- **Session**: A Claude Code CLI invocation, either spawned by the dashboard (PTY or stream-json) or observed externally via hooks.
- **PtyManager**: Spawns Claude CLI via node-pty for interactive terminal use (primary mode).
- **SessionRunner**: Spawns Claude CLI with stream-json I/O for programmatic use (MCP/API mode).
- **Inter-goal message**: Asynchronous message between goals for orchestration (instruction, result, status_update, context).
- **MCP Server**: 10 tools exposed via Model Context Protocol, injected into every dashboard-spawned session.

## Generated

This documentation was generated on 2026-05-12 by 8 autonomous Claude Deck agents reading the codebase at `C:\Claude-Deck`.
