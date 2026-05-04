import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { ArrowUpDown, ArrowUp, ArrowDown, Square } from 'lucide-react';
import type { Session, SessionOrigin } from '../../shared/types';
import { OriginBadge } from './OriginBadge';

// ── Types ────────────────────────────────────────────────────────────────────

type SortField = 'started_at' | 'duration';
type SortDirection = 'asc' | 'desc';

interface SortConfig {
  field: SortField;
  direction: SortDirection;
}

/** Session with optional enriched fields from the API. */
export interface EnrichedSession extends Session {
  last_event_at?: number | null;
  current_tool?: string | null;
  goal_title?: string | null;
}

export interface SessionsTableProps {
  sessions: EnrichedSession[];
  originFilter: SessionOrigin | 'all';
  activeOnly: boolean;
  onEndSession?: (sessionId: string) => void;
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


function formatRelativeTime(epochMs: number | null | undefined): string {
  if (epochMs == null) return 'idle';
  const diffMs = Date.now() - epochMs;
  if (diffMs < 0) return 'just now';
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// truncateId kept for potential future use
// function truncateId(id: string, len: number = 12): string {
//   if (id.length <= len) return id;
//   return id.slice(0, len) + '...';
// }

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
    default: {
      const _exhaustive: never = field;
      return _exhaustive;
    }
  }
}

// ── Tree Builder ────────────────────────────────────────────────────────────

interface FlattenedSession {
  session: EnrichedSession;
  depth: number;
  hasChildren: boolean;
}

function buildSessionTree(sessions: EnrichedSession[]): FlattenedSession[] {
  // Group children by parent
  const childrenMap = new Map<string, EnrichedSession[]>();
  const roots: EnrichedSession[] = [];

  for (const s of sessions) {
    if (s.parent_session_id) {
      const siblings = childrenMap.get(s.parent_session_id) ?? [];
      siblings.push(s);
      childrenMap.set(s.parent_session_id, siblings);
    } else {
      roots.push(s);
    }
  }

  // Flatten tree with depth
  const result: FlattenedSession[] = [];

  function addNode(session: EnrichedSession, depth: number) {
    const children = childrenMap.get(session.id) ?? [];
    result.push({ session, depth, hasChildren: children.length > 0 });
    // Sort children by started_at
    children.sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0));
    for (const child of children) {
      addNode(child, depth + 1);
    }
  }

  // Sort roots by started_at descending
  roots.sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0));
  for (const root of roots) {
    addNode(root, 0);
  }

  // Add orphaned children (parent not in current set)
  const addedIds = new Set(result.map((r) => r.session.id));
  for (const s of sessions) {
    if (!addedIds.has(s.id)) {
      result.push({ session: s, depth: 0, hasChildren: false });
    }
  }

  return result;
}

function getDisplayName(session: EnrichedSession): string {
  if (session.display_name) return session.display_name;
  if (session.cwd) {
    const parts = session.cwd.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] ?? session.id.slice(0, 12);
  }
  return session.id.slice(0, 12) + '...';
}

// ── Component ────────────────────────────────────────────────────────────────

export default function SessionsTable({ sessions, originFilter, activeOnly, onEndSession }: SessionsTableProps) {
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

  // Build tree from filtered sessions
  const treeRows = useMemo(() => buildSessionTree(filteredAndSorted), [filteredAndSorted]);

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
    <div className="overflow-auto rounded-lg border border-deck-border" style={{ maxHeight: 'calc(100vh - 12rem)' }}>
      <table className="w-full text-sm" role="grid">
        <thead className="sticky top-0 z-10">
          <tr className="border-b border-deck-border bg-deck-surface text-left text-deck-muted">
            <th className="px-4 py-3 font-medium">Origin</th>
            <th className="px-4 py-3 font-medium">Goal</th>
            <th className="px-4 py-3 font-medium">Name</th>
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
            <th className="px-4 py-3 font-medium">Last Event</th>
            <th className="px-4 py-3 font-medium">Current Tool</th>
            <th
              className="cursor-pointer select-none px-4 py-3 font-medium hover:text-deck-text"
              onClick={() => handleSort('duration')}
              role="columnheader"
              aria-sort={sort.field === 'duration' ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
            >
              Duration{renderSortIcon('duration')}
            </th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium w-16"></th>
          </tr>
        </thead>
        <tbody>
          {treeRows.length === 0 ? (
            <tr>
              <td colSpan={11} className="px-4 py-8 text-center text-deck-muted">
                No sessions found.
              </td>
            </tr>
          ) : (
            treeRows.map(({ session, depth }) => (
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
                <td className="px-4 py-3 text-deck-muted text-xs max-w-[10rem] truncate" title={session.goal_title ?? undefined}>
                  {session.goal_title ?? '—'}
                </td>
                <td className="px-4 py-3 text-sm text-deck-text" title={session.id}>
                  <div className="flex items-center gap-1" style={{ paddingLeft: `${depth * 20}px` }}>
                    {depth > 0 && <span className="text-deck-muted text-xs">└</span>}
                    <span className="font-medium">{getDisplayName(session)}</span>
                  </div>
                </td>
                <td className="px-4 py-3 text-deck-muted" title={session.cwd ?? undefined}>
                  {truncatePath(session.cwd)}
                </td>
                <td className="px-4 py-3 text-deck-muted">{session.model ?? '--'}</td>
                <td className="px-4 py-3 text-deck-muted">{formatTimestamp(session.started_at)}</td>
                <td className="px-4 py-3 text-deck-muted">{formatRelativeTime(session.last_event_at)}</td>
                <td className="px-4 py-3 text-deck-muted">
                  {session.current_tool ? (
                    <span className="rounded bg-deck-warning/15 px-1.5 py-0.5 text-xs font-medium text-deck-warning">
                      {session.current_tool}
                    </span>
                  ) : null}
                </td>
                <td className="px-4 py-3 text-deck-muted">{formatDuration(getSessionDuration(session))}</td>
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
                <td className="px-4 py-3">
                  {isSessionActive(session) && onEndSession && (
                    <button
                      title="End session"
                      className="rounded p-1 text-deck-muted hover:bg-deck-error/15 hover:text-deck-error transition-colors"
                      onClick={(e) => {
                        e.stopPropagation();
                        onEndSession(session.id);
                      }}
                    >
                      <Square size={14} />
                    </button>
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
