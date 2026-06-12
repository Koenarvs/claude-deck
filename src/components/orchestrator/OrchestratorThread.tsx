import type { OrchestratorMessage } from '../../shared/orchestrator';
import type { ToolLogEntry } from '../../stores/useOrchestratorStore';
import RecommendationCard from './RecommendationCard';

interface Props {
  messages: OrchestratorMessage[];
  liveToolLog: ToolLogEntry[];
  onDecision: (approvalish: OrchestratorMessage, decision: 'approved' | 'denied') => Promise<void>;
}

/** Parses persisted tool calls; tolerant of null/invalid JSON. */
function parseTools(json: string | null): ToolLogEntry[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json) as Array<{ tool: string; summary: string }>;
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function ToolCalls({ tools }: { tools: ToolLogEntry[] }) {
  if (tools.length === 0) return null;
  return (
    <div className="mt-2 space-y-1" data-testid="tool-calls">
      {tools.map((t, i) => (
        <div key={i} className="mono-tabular rounded border border-deck-border bg-deck-bg px-2 py-1 text-[11px] text-deck-muted">
          <span className="font-semibold text-deck-text">{t.tool}</span>{' '}
          <span className="truncate">{t.summary}</span>
        </div>
      ))}
    </div>
  );
}

export default function OrchestratorThread({ messages, liveToolLog, onDecision }: Props) {
  return (
    <div className="flex flex-col gap-3 p-4" data-testid="orchestrator-thread">
      {messages.map((m) => {
        const isOwner = m.role === 'owner';
        const isRecommendation =
          m.role === 'orchestrator' && (m.trigger_kind === 'approval' || m.trigger_kind === 'session_ended');
        if (isRecommendation) {
          return <RecommendationCard key={m.id} message={m} onDecision={(d) => onDecision(m, d)} />;
        }
        return (
          <div key={m.id} className={`flex ${isOwner ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[80%] rounded-lg px-3 py-2 ${isOwner ? 'bg-deck-accent/10' : 'bg-deck-surface border border-deck-border'}`}>
              <div className="mb-0.5 flex items-center gap-2 text-[10px] uppercase tracking-wide text-deck-muted">
                <span>{m.role}</span>
                {m.channel === 'discord' && <span className="rounded bg-deck-border px-1">discord</span>}
              </div>
              <div className="whitespace-pre-wrap text-sm text-deck-text">{m.content}</div>
              <ToolCalls tools={parseTools(m.tool_calls_json)} />
            </div>
          </div>
        );
      })}
      {liveToolLog.length > 0 && (
        <div className="rounded-lg border border-dashed border-deck-border p-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-deck-muted">Live activity</div>
          <ToolCalls tools={liveToolLog} />
        </div>
      )}
    </div>
  );
}
