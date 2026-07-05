import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'react-router';
import {
  ChevronDown,
  ChevronRight,
  Play,
  Wrench,
  MessageSquare,
  Square,
  CircleDot,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { apiGet, apiGetSafe, ApiError } from '../lib/api';
import { useMessagesStore } from '../stores/useMessagesStore';
import { useSessionsStore } from '../stores/useSessionsStore';
import SessionDetailHeader from '../components/sessions/SessionDetailHeader';
import TraceDownloadPanel from '../components/sessions/TraceDownloadPanel';
import MessageStream from '../components/sessions/MessageStream';
import type { Session, Message, HookEvent, HookEventType } from '../shared/types';

// ── Hook Events helpers ─────────────────────────────────────────────────────

function eventIcon(eventType: HookEventType): ReactNode {
  switch (eventType) {
    case 'SessionStart':
      return <Play size={14} className="text-deck-success" />;
    case 'PreToolUse':
      return <Wrench size={14} className="text-deck-warning" />;
    case 'PostToolUse':
      return <Wrench size={14} className="text-deck-accent" />;
    case 'UserPromptSubmit':
      return <MessageSquare size={14} className="text-deck-text" />;
    case 'Stop':
      return <Square size={14} className="text-deck-danger" />;
    default:
      return <CircleDot size={14} className="text-deck-muted" />;
  }
}

function chipColor(eventType: HookEventType): string {
  switch (eventType) {
    case 'SessionStart':
      return 'bg-deck-success/20 text-deck-success';
    case 'PreToolUse':
      return 'bg-deck-warning/20 text-deck-warning';
    case 'PostToolUse':
      return 'bg-deck-accent/20 text-deck-accent';
    case 'UserPromptSubmit':
      return 'bg-deck-text/10 text-deck-text';
    case 'Stop':
      return 'bg-deck-danger/20 text-deck-danger';
    default:
      return 'bg-deck-muted/20 text-deck-muted';
  }
}

function formatEventTimestamp(epochMs: number): string {
  const date = new Date(epochMs);
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function HookEventsSection({ sessionId }: { sessionId: string }) {
  const [events, setEvents] = useState<HookEvent[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);

  const toggleExpanded = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  // Fetch events when expanded for the first time
  useEffect(() => {
    if (!expanded || events.length > 0) return;
    let cancelled = false;

    setLoading(true);
    apiGetSafe<unknown>(`/api/sessions/${sessionId}/events?limit=200`, [])
      .then((data: unknown) => {
        if (!cancelled && Array.isArray(data)) {
          setEvents(data as HookEvent[]);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [expanded, sessionId, events.length]);

  return (
    <div className="rounded-lg border border-deck-border bg-deck-surface">
      <button
        onClick={toggleExpanded}
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium text-deck-text hover:bg-deck-border/30"
      >
        {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        Hook Events
        {events.length > 0 && (
          <span className="ml-1 text-xs text-deck-muted">({events.length})</span>
        )}
      </button>

      {expanded && (
        <div className="border-t border-deck-border">
          {loading ? (
            <div className="flex items-center justify-center py-6">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-deck-border border-t-deck-accent" />
            </div>
          ) : events.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-deck-muted">
              No hook events for this session.
            </div>
          ) : (
            <div className="max-h-[400px] overflow-y-auto">
              {events.map((event) => (
                <div
                  key={event.id}
                  className="flex items-center gap-3 border-b border-deck-border px-4 py-2 last:border-b-0"
                >
                  <span className="shrink-0">{eventIcon(event.event_type)}</span>
                  <span className="w-16 shrink-0 font-mono text-xs text-deck-muted">
                    {formatEventTimestamp(event.created_at)}
                  </span>
                  <span
                    className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ${chipColor(event.event_type)}`}
                  >
                    {event.event_type}
                  </span>
                  {event.tool_name && (
                    <span className="rounded bg-deck-border px-1.5 py-0.5 text-xs text-deck-muted">
                      {event.tool_name}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Component ────────────────────────────────────────────────────────────────

export default function SessionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const upsertSession = useSessionsStore((s) => s.upsertSession);
  const storeMessages = useMessagesStore((s) => (id != null ? s.bySessionId[id] : undefined));
  const setMessagesForSession = useMessagesStore((s) => s.setMessagesForSession);

  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Use store messages if available (for live updates via WS), otherwise use fetched
  const displayMessages = storeMessages != null && storeMessages.length > 0 ? storeMessages : messages;

  // Fetch session + messages on mount
  useEffect(() => {
    if (id == null) return;
    const sessionId = id;
    let cancelled = false;

    async function fetchData() {
      try {
        setLoading(true);
        setError(null);

        const [sessionData, messagesData] = await Promise.all([
          apiGet<Session>(`/api/sessions/${sessionId}`).catch((err: unknown) => {
            if (err instanceof ApiError) {
              throw new Error(`Failed to fetch session: ${err.status}`);
            }
            throw err;
          }),
          apiGet<Message[]>(`/api/sessions/${sessionId}/messages`).catch((err: unknown) => {
            if (err instanceof ApiError) {
              throw new Error(`Failed to fetch messages: ${err.status}`);
            }
            throw err;
          }),
        ]);

        if (!cancelled) {
          setSession(sessionData);
          upsertSession(sessionData);
          setMessages(messagesData);
          setMessagesForSession(sessionId, messagesData);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Unknown error');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void fetchData();
    return () => {
      cancelled = true;
    };
  }, [id, upsertSession, setMessagesForSession]);

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-deck-border border-t-deck-accent" />
      </div>
    );
  }

  // Error state
  if (error != null) {
    return (
      <div className="rounded-lg border border-deck-danger/30 bg-deck-danger/10 p-4 text-sm text-deck-danger">
        {error}
      </div>
    );
  }

  // Missing session
  if (session == null) {
    return (
      <div className="rounded-lg border border-deck-border bg-deck-surface p-4 text-sm text-deck-muted">
        Session not found.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4">
      {/* Header with session metadata */}
      <SessionDetailHeader session={session} onSessionEnded={() => {
        setSession({ ...session, ended_at: Date.now() });
      }} />

      {/* Divider */}
      <div className="border-t border-deck-border" />

      {/* Message stream (read-only) */}
      <div className="flex-1 overflow-hidden">
        <MessageStream messages={displayMessages} readOnly />
      </div>

      {/* Hook events (collapsible) */}
      <HookEventsSection sessionId={session.id} />

      {/* Trace downloads */}
      <TraceDownloadPanel session={session} />
    </div>
  );
}
