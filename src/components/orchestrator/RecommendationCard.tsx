import { useState } from 'react';
import type { OrchestratorMessage } from '../../shared/orchestrator';

interface Props {
  message: OrchestratorMessage;
  /** Resolves the approval the orchestrator recommended on. */
  onDecision: (decision: 'approved' | 'denied') => Promise<void>;
}

/**
 * Shown for an orchestrator turn produced by an approval/stall trigger. The orchestrator's
 * text is its recommendation; the owner ratifies (approved) or overrides (denied).
 */
export default function RecommendationCard({ message, onDecision }: Props) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<'approved' | 'denied' | null>(null);

  const decide = async (d: 'approved' | 'denied') => {
    setBusy(true);
    try { await onDecision(d); setDone(d); } finally { setBusy(false); }
  };

  return (
    <div className="rounded-lg border border-deck-accent/30 bg-deck-accent/5 p-3" data-testid="recommendation-card">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-deck-accent">Recommendation</div>
      <div className="whitespace-pre-wrap text-sm text-deck-text">{message.content}</div>
      {done ? (
        <div className="mt-2 text-xs font-medium text-deck-muted">Ratified: {done}</div>
      ) : (
        <div className="mt-3 flex gap-2">
          <button
            type="button" disabled={busy}
            onClick={() => void decide('approved')}
            className="rounded-md bg-deck-success px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >Approve</button>
          <button
            type="button" disabled={busy}
            onClick={() => void decide('denied')}
            className="rounded-md border border-deck-border px-3 py-1.5 text-xs font-medium text-deck-text disabled:opacity-50"
          >Deny</button>
        </div>
      )}
    </div>
  );
}
