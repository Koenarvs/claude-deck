import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { useMessagesStore } from '../stores/useMessagesStore';
import { useSessionsStore } from '../stores/useSessionsStore';
import SessionDetailHeader from '../components/sessions/SessionDetailHeader';
import TraceDownloadPanel from '../components/sessions/TraceDownloadPanel';
import MessageStream from '../components/sessions/MessageStream';
import type { Session, Message } from '../shared/types';

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

        const [sessionRes, messagesRes] = await Promise.all([
          fetch(`/api/sessions/${sessionId}`),
          fetch(`/api/sessions/${sessionId}/messages`),
        ]);

        if (!sessionRes.ok) {
          throw new Error(`Failed to fetch session: ${sessionRes.status}`);
        }
        if (!messagesRes.ok) {
          throw new Error(`Failed to fetch messages: ${messagesRes.status}`);
        }

        const sessionData: Session = await sessionRes.json() as Session;
        const messagesData: Message[] = await messagesRes.json() as Message[];

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
      <SessionDetailHeader session={session} />

      {/* Divider */}
      <div className="border-t border-deck-border" />

      {/* Message stream (read-only) */}
      <div className="flex-1 overflow-hidden">
        <MessageStream messages={displayMessages} readOnly />
      </div>

      {/* Trace downloads */}
      <TraceDownloadPanel session={session} />
    </div>
  );
}
