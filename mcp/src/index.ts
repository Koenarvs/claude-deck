import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DashboardApiClient, ApiError, ApiConnectionError } from './api-client.js';
import { ListGoalsInputSchema, listGoals } from './tools/list-goals.js';
import { GetGoalInputSchema, getGoal } from './tools/get-goal.js';
import { CreateGoalInputSchema, createGoal } from './tools/create-goal.js';
import { SendMessageInputSchema, sendMessage } from './tools/send-message.js';
import { ListSessionsInputSchema, listSessions } from './tools/list-sessions.js';
import { GetSessionMessagesInputSchema, getSessionMessages } from './tools/get-session-messages.js';
import { ScheduleTaskInputSchema, scheduleTask } from './tools/schedule-task.js';

/**
 * MCP server for claude-deck.
 *
 * Exposes 7 tools that proxy to the claude-deck dashboard HTTP API:
 * - list_goals, get_goal, create_goal, send_message
 * - list_sessions, get_session_messages
 * - schedule_task
 *
 * Transport: stdio (registered in user MCP config).
 * All mutations flow through the dashboard API, ensuring WebSocket broadcasts
 * and validation are unified with the UI.
 */

const BASE_URL = process.env['CLAUDE_DECK_URL'] ?? 'http://127.0.0.1:4100';
const client = new DashboardApiClient(BASE_URL);

/**
 * Wraps a tool handler to produce MCP-compliant error responses
 * instead of throwing unhandled exceptions.
 */
async function handleToolCall(
  fn: () => Promise<string>,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const text = await fn();
    return { content: [{ type: 'text' as const, text }] };
  } catch (err) {
    let errorMessage: string;

    if (err instanceof ApiConnectionError) {
      errorMessage = `Dashboard unreachable. Is claude-deck running at ${BASE_URL}? Error: ${err.cause_message}`;
    } else if (err instanceof ApiError) {
      errorMessage = `Dashboard API error (HTTP ${err.statusCode}): ${err.body}`;
    } else if (err instanceof Error) {
      errorMessage = err.message;
    } else {
      errorMessage = String(err);
    }

    return {
      content: [{ type: 'text' as const, text: errorMessage }],
      isError: true,
    };
  }
}

// ── Server setup ─────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'claude-deck',
  version: '0.1.0',
});

// ── Tool registration ────────────────────────────────────────────────────────

server.tool(
  'list_goals',
  'List goals tracked by claude-deck. Optionally filter by status or tag.',
  ListGoalsInputSchema.shape,
  async (input) => handleToolCall(() => listGoals(client, input)),
);

server.tool(
  'get_goal',
  'Get a single goal with its messages and plan.',
  GetGoalInputSchema.shape,
  async (input) => handleToolCall(() => getGoal(client, input)),
);

server.tool(
  'create_goal',
  'Create a new goal in claude-deck. Optionally spawns a Claude session with an initial prompt.',
  CreateGoalInputSchema.shape,
  async (input) => handleToolCall(() => createGoal(client, input)),
);

server.tool(
  'send_message',
  'Send a follow-up message/prompt to an existing goal\'s active session.',
  SendMessageInputSchema.shape,
  async (input) => handleToolCall(() => sendMessage(client, input)),
);

server.tool(
  'list_sessions',
  'List Claude sessions (dashboard-spawned and external). Optionally filter by origin or active status.',
  ListSessionsInputSchema.shape,
  async (input) => handleToolCall(() => listSessions(client, input)),
);

server.tool(
  'get_session_messages',
  'Get all messages for a specific Claude session.',
  GetSessionMessagesInputSchema.shape,
  async (input) => handleToolCall(() => getSessionMessages(client, input)),
);

server.tool(
  'schedule_task',
  'Create a scheduled task that automatically creates goals on a cron schedule.',
  ScheduleTaskInputSchema.shape,
  async (input) => handleToolCall(() => scheduleTask(client, input)),
);

// ── Boot ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server runs until the stdio transport closes (parent process exits).
}

main().catch((err) => {
  process.stderr.write(`claude-deck MCP server fatal error: ${err}\n`);
  process.exit(1);
});
