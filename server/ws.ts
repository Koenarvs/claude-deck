import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer } from 'node:http';
import { ClientMessageSchema } from '../src/shared/events';
import type { ServerEvent } from '../src/shared/events';
import logger from './logger';

export interface TerminalHandler {
  onInput(goalId: string, data: string): void;
  onResize(goalId: string, cols: number, rows: number): void;
}

let terminalHandler: TerminalHandler | null = null;

export function setTerminalHandler(handler: TerminalHandler): void {
  terminalHandler = handler;
}

interface ClientState {
  subscribed: Set<string> | 'all';
}

const clients = new Map<WebSocket, ClientState>();

/**
 * Attaches a WebSocketServer to the given HTTP server at path /ws.
 * Handles subscribe, unsubscribe, and ping inbound messages.
 * Returns the WebSocketServer instance.
 */
export function setupWss(httpServer: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws) => {
    clients.set(ws, { subscribed: new Set() });
    logger.debug('WebSocket client connected');

    ws.on('message', (raw) => {
      try {
        const data: unknown = JSON.parse(raw.toString());
        const result = ClientMessageSchema.safeParse(data);

        if (!result.success) {
          logger.warn({ issues: result.error.issues }, 'Invalid WS message from client');
          return;
        }

        const msg = result.data;
        const state = clients.get(ws);
        if (!state) return;

        switch (msg.type) {
          case 'subscribe':
            if (msg.goals === 'all') {
              state.subscribed = 'all';
            } else {
              state.subscribed = new Set(msg.goals);
            }
            logger.debug({ subscribed: msg.goals }, 'Client subscribed');
            break;

          case 'unsubscribe':
            state.subscribed = new Set();
            logger.debug('Client unsubscribed');
            break;

          case 'ping':
            ws.send(JSON.stringify({ type: 'ping' }));
            break;

          case 'terminal:input':
            terminalHandler?.onInput(msg.goal_id, msg.data);
            break;

          case 'terminal:resize':
            terminalHandler?.onResize(msg.goal_id, msg.cols, msg.rows);
            break;
        }
      } catch (err) {
        logger.warn({ err }, 'Failed to parse WS message');
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      logger.debug('WebSocket client disconnected');
    });

    ws.on('error', (err) => {
      logger.error({ err }, 'WebSocket client error');
      clients.delete(ws);
    });
  });

  return wss;
}

/**
 * Extracts the goal_id from a ServerEvent, if present.
 */
function getEventGoalId(event: ServerEvent): string | null {
  switch (event.type) {
    case 'goal:created':
    case 'goal:updated':
      return event.goal.id;
    case 'goal:status':
    case 'goal:plan-updated':
      return event.id;
    case 'message:added':
      return event.goal_id;
    case 'approval:pending':
      return event.goal_id;
    case 'subprocess:error':
    case 'terminal:data':
    case 'terminal:started':
    case 'terminal:exited':
      return event.goal_id;
    case 'goal:instruction':
      return event.message.to_goal_id;
    case 'conversation:updated':
      return event.goal_id;
    default:
      return null;
  }
}

/**
 * Broadcasts a ServerEvent to all connected clients whose subscription matches.
 * Events with a goal_id only go to clients subscribed to that goal (or "all").
 * Events without a goal_id go to all subscribed clients.
 */
export function broadcast(event: ServerEvent): void {
  const payload = JSON.stringify(event);
  const goalId = getEventGoalId(event);

  for (const [ws, state] of clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;

    if (state.subscribed === 'all') {
      ws.send(payload);
      continue;
    }

    // No goal_id means broadcast to everyone who is subscribed to anything
    if (goalId === null) {
      if (state.subscribed.size > 0) {
        ws.send(payload);
      }
      continue;
    }

    // Goal-specific event: only to subscribers of that goal
    if (state.subscribed.has(goalId)) {
      ws.send(payload);
    }
  }
}
