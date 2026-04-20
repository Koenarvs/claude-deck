import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import type { Session, SessionOrigin } from '../../shared/types';
import { OriginBadge } from './OriginBadge';

// ── Types ────────────────────────────────────────────────────────────────────

type SortField = 'started_at' | 'duration' | 'total_cost_usd' | 'total_tokens_in' | 'total_tokens_out';
type SortDirection = 'asc' | 'desc';

interface SortConfig {
  field: SortField;
  direction: SortDirection;
}

export interface SessionsTableProps {
  sessions: Session[];
  originFilter: SessionOrigin | 'all';
  activeOnly: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getSessionDuration(session: Session): number | null {
  if (session.started_at == null) return null;
  const end = session.ended_at ?? Date.now();
  return end - session.started_at;
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '--';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatTimestamp(epoch: number | null): string {
  if (epoch == null) return '--';
  const d = new Date(epoch);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
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

function truncateId(id: string, len: number = 12): string {
  if (id.length <= len) return id;
  return id.slice(0, len) + '...';
}

function truncatePath(path: string | null, maxLen: number = 30): string {
  if (path == null) return '--';
  if (path.length <= maxLen) return path;
  return '...' + path.slice(path.length - maxLen + 3);
}

function isSessionActive(session: Session): boolean {
  return session.ended_at == null;
}

// ── Sort Comparator ──────────────────────────────────────────────────────────

function compareByField(a: Session, b: Session, field: SortField): number {
  switch (field) {
    case 'started_at': {
      const av = a.started_at ?? 0;
      const bv = b.started_at ?? 0;
      return av - bv;
    }
    case 'duration': {
      const av = getSessionDuration(a) ?? 0;
      const bv = getSessionDuration(b) ?? 0;
      return av - bv;
    }
    case 'total_cost_usd': {
      const av = a.total_cost_usd ?? 0;
      const bv = b.total_cost_usd ?? 0;
      return av - bv;
    }
    case 'total_tokens_in': {
      const av = a.total_tokens_in ?? 0;
      const bv = b.total_tokens_in ?? 0;
      return av - bv;
    }
    case 'total_tokens_out': {
      const av = a.total_tokens_out ?? 0;
      const bv = b.total_tokens_out ?? 0;
      return av - bv;
    }
    default: {
      const _exhaustive: never = field;
      return _exhaustive;
    }
  }
}

// ── Component ────────────────────────────────────────────────────────────────

export default function SessionsTable({ sessions, originFilter, activeOnly }: SessionsTableProps) {
  const navigate = useNavigate();
  const [sort, setSort] = useState<SortConfig>({ field: 'started_at', direction: 'desc' });

  const filteredAndSorted = useMemo(() => {
    let result = sessions;

    // Apply origin filter
    if (originFilter !== 'all') {
      result = result.filter((s) => s.origin === originFilter);
    }

    // Apply active-only filter
    if (activeOnly) {
      result = result.filter(isSessionActive);
    }

    // Sort
    const sorted = [...result].sort((a, b) => {
      const cmp = compareByField(a, b, sort.field);
      return sort.direction === 'asc' ? cmp : -cmp;
    });

    return sorted;
  }, [sessions, originFilter, activeOnly, sort]);

  const handleSort = useCallback((field: SortField) => {
    setSort((prev) => {
      if (prev.field === field) {
        return { field, direction: prev.direction === 'asc' ? 'desc' : 'asc' };
      }
      return { field, direction: 'desc' };
    });
  }, []);

  const handleRowClick = useCallback(
    (sessionId: string) => {
      navigate(`/sessions/${sessionId}`);
    },
    [navigate],
  );

  const handleRowKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTableRowElement>, sessionId: string) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        navigate(`/sessions/${sessionId}`);
      }
    },
    [navigate],
  );

  const renderSortIcon = (field: SortField) => {
    if (sort.field !== field) {
      return <ArrowUpDown size={14} className="ml-1 inline opacity-40" />;
    }
    return sort.direction === 'asc' ? (
      <ArrowUp size={14} className="ml-1 inline text-deck-accent" />
    ) : (
      <ArrowDown size={14} className="ml-1 inline text-deck-accent" />
    );
  };

  return (
    <div className="overflow-x-auto rounded-lg border border-deck-border">
      <table className="w-full text-sm" role="grid">
        <thead>
          <tr className="border-b border-deck-border bg-deck-surface text-left text-deck-muted">
            <th className="px-4 py-3 font-medium">Origin</th>
            <th className="px-4 py-3 font-medium">Session ID</th>
            <th className="px-4 py-3 font-medium">Working Dir</th>
            <th className="px-4 py-3 font-medium">Model</th>
            <th
              className="cursor-pointer select-none px-4 py-3 font-medium hover:text-deck-text"
              onClick={() => handleSort('started_at')}
              role="columnheader"
              aria-sort={sort.field === 'started_at' ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
            >
              Started{renderSortIcon('started_at')}
            </th>
            <th
              className="cursor-pointer select-none px-4 py-3 font-medium hover:text-deck-text"
              onClick={() => handleSort('duration')}
              role="columnheader"
              aria-sort={sort.field === 'duration' ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
            >
              Duration{renderSortIcon('duration')}
            </th>
            <th
              className="cursor-pointer select-none px-4 py-3 font-medium hover:text-deck-text"
              onClick={() => handleSort('total_tokens_in')}
              role="columnheader"
              aria-sort={sort.field === 'total_tokens_in' ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
            >
              Tokens In{renderSortIcon('total_tokens_in')}
            </th>
            <th
              className="cursor-pointer select-none px-4 py-3 font-medium hover:text-deck-text"
              onClick={() => handleSort('total_tokens_out')}
              role="columnheader"
              aria-sort={sort.field === 'total_tokens_out' ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
            >
              Tokens Out{renderSortIcon('total_tokens_out')}
            </th>
            <th
              className="cursor-pointer select-none px-4 py-3 font-medium hover:text-deck-text"
              onClick={() => handleSort('total_cost_usd')}
              role="columnheader"
              aria-sort={sort.field === 'total_cost_usd' ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
            >
              Cost{renderSortIcon('total_cost_usd')}
            </th>
            <th className="px-4 py-3 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {filteredAndSorted.length === 0 ? (
            <tr>
              <td colSpan={10} className="px-4 py-8 text-center text-deck-muted">
                No sessions found.
              </td>
            </tr>
          ) : (
            filteredAndSorted.map((session) => (
              <tr
                key={session.id}
                className="cursor-pointer border-b border-deck-border transition-colors last:border-b-0 hover:bg-deck-surface"
                onClick={() => handleRowClick(session.id)}
                onKeyDown={(e) => handleRowKeyDown(e, session.id)}
                tabIndex={0}
                role="row"
              >
                <td className="px-4 py-3">
                  <OriginBadge origin={session.origin} />
                </td>
                <td className="px-4 py-3 font-mono text-xs text-deck-text" title={session.id}>
                  {truncateId(session.id)}
                </td>
                <td className="px-4 py-3 text-deck-muted" title={session.cwd ?? undefined}>
                  {truncatePath(session.cwd)}
                </td>
                <td className="px-4 py-3 text-deck-muted">{session.model ?? '--'}</td>
                <td className="px-4 py-3 text-deck-muted">{formatTimestamp(session.started_at)}</td>
                <td className="px-4 py-3 text-deck-muted">{formatDuration(getSessionDuration(session))}</td>
                <td className="px-4 py-3 text-right tabular-nums text-deck-muted">
                  {formatTokens(session.total_tokens_in)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-deck-muted">
                  {formatTokens(session.total_tokens_out)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-deck-muted">
                  {formatCost(session.total_cost_usd)}
                </td>
                <td className="px-4 py-3">
                  {isSessionActive(session) ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-deck-success/15 px-2.5 py-0.5 text-xs font-medium text-deck-success">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-deck-success" />
                      Active
                    </span>
                  ) : (
                    <span className="inline-flex items-center rounded-full bg-deck-muted/15 px-2.5 py-0.5 text-xs font-medium text-deck-muted">
                      Ended
                    </span>
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
