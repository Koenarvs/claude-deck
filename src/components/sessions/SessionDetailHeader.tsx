import { useState, useEffect } from 'react';
import { Link } from 'react-router';
import { ArrowLeft, Clock, Cpu, DollarSign, FolderOpen, Target, Square } from 'lucide-react';
import type { Session } from '../../shared/types';
import { OriginBadge } from './OriginBadge';

interface SessionDetailHeaderProps {
  session: Session;
  onSessionEnded?: () => void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(ms: number | null): string {
  if (ms == null) return '--';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatCost(cost: number | null): string {
  if (cost == null) return '--';
  return `$${cost.toFixed(4)}`;
}

function formatTokens(tokens: number | null): string {
  if (tokens == null) return '--';
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return tokens.toString();
}

function getSessionDuration(session: Session): number | null {
  if (session.started_at == null) return null;
  const end = session.ended_at ?? Date.now();
  return end - session.started_at;
}

// ── Component ────────────────────────────────────────────────────────────────

export default function SessionDetailHeader({ session, onSessionEnded }: SessionDetailHeaderProps) {
  const duration = getSessionDuration(session);
  const isActive = session.ended_at == null;
  const [ending, setEnding] = useState(false);
  const [usage, setUsage] = useState<{ cost: number; tokensIn: number; tokensOut: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/sessions/${session.id}/usage`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: Record<string, number> | null) => {
        if (cancelled || !data) return;
        const tokensIn = (data.inputTokens ?? 0) + (data.cacheCreationTokens ?? 0) + (data.cacheReadTokens ?? 0);
        setUsage({
          cost: data.estimatedCostUsd ?? 0,
          tokensIn,
          tokensOut: data.outputTokens ?? 0,
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [session.id]);

  return (
    <div className="space-y-4">
      {/* Back link + ID */}
      <div className="flex items-center gap-3">
        <Link
          to="/sessions"
          className="flex items-center gap-1 rounded-md px-2 py-1 text-sm text-deck-muted transition-colors hover:bg-deck-border hover:text-deck-text"
        >
          <ArrowLeft size={16} />
          Sessions
        </Link>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          {/* Session ID + badges */}
          <div className="flex items-center gap-3">
            <h1 className="font-mono text-lg font-semibold text-deck-text">{session.id}</h1>
            <OriginBadge origin={session.origin} />
            {isActive && (
              <>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-deck-success/15 px-2.5 py-0.5 text-xs font-medium text-deck-success">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-deck-success" />
                  Active
                </span>
                <button
                  disabled={ending}
                  onClick={async () => {
                    setEnding(true);
                    try {
                      const res = await fetch(`/api/sessions/${session.id}/end`, { method: 'POST' });
                      if (res.ok) onSessionEnded?.();
                    } finally {
                      setEnding(false);
                    }
                  }}
                  className="inline-flex items-center gap-1 rounded-md border border-deck-danger/30 px-2 py-0.5 text-xs text-deck-danger transition-colors hover:bg-deck-danger/10 disabled:opacity-50"
                >
                  <Square size={12} />
                  {ending ? 'Ending...' : 'Mark Ended'}
                </button>
              </>
            )}
          </div>

          {/* Goal link */}
          {session.goal_id != null && (
            <div className="flex items-center gap-2 text-sm text-deck-muted">
              <Target size={14} />
              <span>Goal:</span>
              <Link
                to={`/goals/${session.goal_id}`}
                className="text-deck-accent hover:text-deck-accent-hover hover:underline"
              >
                {session.goal_id}
              </Link>
            </div>
          )}

          {/* Working directory */}
          {session.cwd != null && (
            <div className="flex items-center gap-2 text-sm text-deck-muted">
              <FolderOpen size={14} />
              <span className="font-mono text-xs">{session.cwd}</span>
            </div>
          )}
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
          <StatItem icon={<Cpu size={14} />} label="Model" value={session.model ?? '--'} />
          <StatItem icon={<Clock size={14} />} label="Duration" value={formatDuration(duration)} />
          <StatItem icon={<DollarSign size={14} />} label="Cost" value={formatCost(usage?.cost ?? null)} />
          <StatItem
            label="Tokens"
            value={`${formatTokens(usage?.tokensIn ?? null)} in / ${formatTokens(usage?.tokensOut ?? null)} out`}
          />
        </div>
      </div>
    </div>
  );
}

// ── Sub-component ────────────────────────────────────────────────────────────

interface StatItemProps {
  icon?: React.ReactNode;
  label: string;
  value: string;
}

function StatItem({ icon, label, value }: StatItemProps) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-1 text-xs text-deck-muted">
        {icon}
        {label}
      </div>
      <div className="text-sm font-medium text-deck-text">{value}</div>
    </div>
  );
}
