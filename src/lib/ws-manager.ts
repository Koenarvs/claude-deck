import { useEffect, useRef } from 'react';
import { ServerEventSchema } from '../shared/events';
import type { ServerEvent } from '../shared/events';
import type { Goal, PlanJson, Session } from '../shared/types';
import { useGoalsStore } from '../stores/useGoalsStore';
import { useSessionsStore } from '../stores/useSessionsStore';
import { useMessagesStore } from '../stores/useMessagesStore';
import { usePlanStore } from '../stores/usePlanStore';
import { useConnectionStore } from '../stores/useConnectionStore';
import { useActiveToolStore } from '../stores/useActiveToolStore';
import { emitTerminalData, emitTerminalStarted, emitTerminalExited } from './terminal-events';
import { emitConversationUpdated } from './conversation-events';
import { useOrchestratorStore } from '../stores/useOrchestratorStore';

let ws: WebSocket | null = null;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let initialized = false;

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;

function getWsUrl(): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/ws`;
}

function getReconnectDelay(): number {
  const delay = Math.min(BASE_DELAY_MS * Math.pow(2, reconnectAttempt), MAX_DELAY_MS);
  return delay;
}

/** Dispatches a validated ServerEvent to the appropriate Zustand store. */
function dispatch(event: ServerEvent): void {
  switch (event.type) {
    case 'goal:created':
    case 'goal:updated':
      useGoalsStore.getState().upsertGoal(event.goal as Goal);
      break;

    case 'goal:status': {
      const goals = useGoalsStore.getState().goals;
      const existing = goals.find((g) => g.id === event.id);
      if (existing) {
        useGoalsStore.getState().upsertGoal({
          ...existing,
          status: event.status,
          current_session_id: event.current_session_id,
          updated_at: Date.now(),
        });
      }
      break;
    }

    case 'goal:plan-updated':
      usePlanStore.getState().setPlan(event.id, event.plan_json as PlanJson);
      break;

    case 'message:added':
      useMessagesStore.getState().addMessage(event.goal_id, event.session_id, event.message);
      break;

    case 'session:observed':
      useSessionsStore.getState().upsertSession(event.session as Session);
      break;

    case 'hook:event': {
      const he = event.event;
      if (he.session_id && he.event_type === 'PreToolUse') {
        useActiveToolStore.getState().setActiveTool(he.session_id, he.tool_name);
      } else if (he.session_id && he.event_type === 'PostToolUse') {
        useActiveToolStore.getState().setActiveTool(he.session_id, null);
      }
      break;
    }

    case 'session:ended': {
      const allSessions = useSessionsStore.getState().sessions;
      const endedSession = allSessions.find((s) => s.id === event.id);
      if (endedSession) {
        useSessionsStore.getState().upsertSession({
          ...endedSession,
          ended_at: Date.now(),
        });
      }
      break;
    }

    case 'conversation:updated':
      emitConversationUpdated(event.goal_id);
      break;

    case 'goal:instruction':
      useGoalsStore.getState().addInstruction(event.message);
      break;

    case 'orchestrator:message':
      useOrchestratorStore.getState().addMessage(event.message);
      break;

    case 'orchestrator:status':
      useOrchestratorStore.getState().setStatus(event.status);
      break;

    case 'orchestrator:tool':
      useOrchestratorStore.getState().addTool({ tool: event.tool, summary: event.summary });
      break;

    case 'subprocess:error':
    case 'ping':
      break;

    case 'terminal:data':
      emitTerminalData(event.goal_id, event.data);
      break;

    case 'terminal:started':
      emitTerminalStarted(event.goal_id);
      break;

    case 'terminal:exited':
      emitTerminalExited(event.goal_id, event.exitCode);
      break;
  }
}

function connect(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  useConnectionStore.getState().setStatus('connecting');

  ws = new WebSocket(getWsUrl());

  ws.onopen = () => {
    reconnectAttempt = 0;
    useConnectionStore.getState().setStatus('open');

    // Subscribe to all events
    ws?.send(JSON.stringify({ type: 'subscribe', goals: 'all' }));
  };

  ws.onmessage = (event) => {
    try {
      const data: unknown = JSON.parse(event.data as string);
      const result = ServerEventSchema.safeParse(data);
      if (result.success) {
        dispatch(result.data);
      }
    } catch {
      // Malformed JSON — ignore
    }
  };

  ws.onclose = () => {
    useConnectionStore.getState().setStatus('closed');
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = () => {
    useConnectionStore.getState().setStatus('error');
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;

  const delay = getReconnectDelay();
  reconnectAttempt++;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

export function sendWsMessage(msg: Record<string, unknown>): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

/**
 * React hook that initializes the WebSocket connection on first mount.
 * The connection is a module-level singleton — it persists for the
 * lifetime of the application and is NOT closed on unmount.
 */
export function useWsManager(): void {
  const mountedRef = useRef(false);

  useEffect(() => {
    if (mountedRef.current || initialized) return;
    mountedRef.current = true;
    initialized = true;
    connect();
  }, []);
}
