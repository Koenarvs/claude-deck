import { useEffect, useState, useCallback, useRef } from 'react';
import { Bot, RefreshCw } from 'lucide-react';
import { apiGet, apiPost, ApiError } from '../lib/api';
import { useOrchestratorStore } from '../stores/useOrchestratorStore';
import OrchestratorThread from '../components/orchestrator/OrchestratorThread';
import OrchestratorComposer from '../components/orchestrator/OrchestratorComposer';
import OrchestratorStatusPill from '../components/orchestrator/OrchestratorStatusPill';
import type { OrchestratorMessage, OrchestratorStateRecord } from '../shared/orchestrator';

interface OrchestratorGetResponse {
  state: OrchestratorStateRecord;
  messages: OrchestratorMessage[];
}

export default function OrchestratorPage() {
  const messages = useOrchestratorStore((s) => s.messages);
  const status = useOrchestratorStore((s) => s.status);
  const toolLog = useOrchestratorStore((s) => s.toolLog);
  const hydrate = useOrchestratorStore((s) => s.hydrate);

  const [persona, setPersona] = useState('Hawat');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const data = await apiGet<OrchestratorGetResponse>('/api/orchestrator').catch(
        (err: unknown) => {
          if (err instanceof ApiError) {
            throw new Error(`Failed to load orchestrator: ${err.statusText}`);
          }
          throw err;
        },
      );
      setPersona(data.state.config.persona_name);
      hydrate(data.messages, data.state.status);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [hydrate]);

  useEffect(() => { void load(); }, [load]);

  // Autoscroll on new turns. (Guarded: jsdom elements lack scrollTo.)
  useEffect(() => {
    const el = scrollRef.current;
    if (el && typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight });
    }
  }, [messages.length, toolLog.length]);

  const send = useCallback((text: string) => {
    void apiPost('/api/orchestrator/messages', { text }).catch((err: unknown) => {
      // HTTP errors were silently ignored before; other failures still surface.
      if (!(err instanceof ApiError)) throw err;
    });
    // The owner turn + reply arrive via WS (orchestrator:message); no optimistic insert needed.
  }, []);

  const decide = useCallback(async (msg: OrchestratorMessage, decision: 'approved' | 'denied') => {
    // The approval id is not on the message; the orchestrator references it in its text and via
    // the persisted approval. v1 posts the decision keyed by the most recent pending approval the
    // recommendation concerns — the Core's POST /decision validates pending-ness and 409s if stale.
    await apiPost('/api/orchestrator/decision', { messageId: msg.id, decision }).catch(
      (err: unknown) => {
        // HTTP errors were silently ignored before; other failures still surface.
        if (!(err instanceof ApiError)) throw err;
      },
    );
  }, []);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-deck-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Bot size={20} className="text-deck-accent" />
          <h1 className="text-lg font-semibold text-deck-text">{persona}</h1>
          <OrchestratorStatusPill status={status} />
        </div>
        <button
          type="button" onClick={() => void load()} aria-label="Reload thread"
          className="rounded-md border border-deck-border p-2 text-deck-muted hover:text-deck-text"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </header>

      {error && (
        <div className="m-4 rounded-md border border-deck-danger/30 bg-deck-danger/10 px-4 py-3 text-sm text-deck-danger">
          {error}
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <OrchestratorThread messages={messages} liveToolLog={toolLog} onDecision={decide} />
      </div>

      <OrchestratorComposer onSend={send} disabled={loading} />
    </div>
  );
}
