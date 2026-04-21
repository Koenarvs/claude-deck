import { Activity } from 'lucide-react';

interface ContextHealthProps {
  tokensIn: number;
  tokensOut: number;
  cost: number;
  turnCount: number;
}

const CONTEXT_WINDOW = 200_000;

function getHealthColor(pct: number): string {
  if (pct < 50) return 'text-deck-success';
  if (pct < 75) return 'text-deck-warning';
  return 'text-deck-danger';
}

function getBarColor(pct: number): string {
  if (pct < 50) return 'bg-deck-success';
  if (pct < 75) return 'bg-deck-warning';
  return 'bg-deck-danger';
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export default function ContextHealth({ tokensIn, tokensOut, cost, turnCount }: ContextHealthProps) {
  const totalTokens = tokensIn + tokensOut;
  const contextPct = Math.min(100, Math.round((totalTokens / CONTEXT_WINDOW) * 100));

  return (
    <div className="rounded-lg border border-deck-border bg-deck-surface p-3 space-y-3">
      <div className="flex items-center gap-2">
        <Activity size={14} className={getHealthColor(contextPct)} />
        <span className="text-xs font-medium text-deck-text">Session Health</span>
      </div>

      {/* Context window bar */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] text-deck-muted">Context Window</span>
          <span className={`text-[10px] font-mono ${getHealthColor(contextPct)}`}>{contextPct}%</span>
        </div>
        <div className="h-2 w-full rounded-full bg-deck-bg overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${getBarColor(contextPct)}`}
            style={{ width: `${contextPct}%` }}
          />
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-2 text-[10px]">
        <div>
          <span className="text-deck-muted">Tokens In</span>
          <p className="font-mono text-deck-text">{formatTokens(tokensIn)}</p>
        </div>
        <div>
          <span className="text-deck-muted">Tokens Out</span>
          <p className="font-mono text-deck-text">{formatTokens(tokensOut)}</p>
        </div>
        <div>
          <span className="text-deck-muted">Cost</span>
          <p className="font-mono text-deck-text">${cost.toFixed(4)}</p>
        </div>
        <div>
          <span className="text-deck-muted">Turns</span>
          <p className="font-mono text-deck-text">{turnCount}</p>
        </div>
      </div>
    </div>
  );
}
