import { useCallback, useEffect, useMemo, useState } from 'react';
import { List } from 'lucide-react';
import { apiGet, apiPost, ApiError } from '../lib/api';
import { useSessionsStore } from '../stores/useSessionsStore';
import SessionsTable from '../components/sessions/SessionsTable';
import SessionFilters from '../components/sessions/SessionFilters';
import type { SessionFiltersState, DateRange } from '../components/sessions/SessionFilters';
import type { Session } from '../shared/types';
import type { EnrichedSession } from '../components/sessions/SessionsTable';

// ── Helpers ──────────────────────────────────────────────────────────────────

function getDateRangeStart(range: DateRange): number | null {
  const now = Date.now();
  switch (range) {
    case 'all':
      return null;
    case 'today': {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }
    case '7d':
      return now - 7 * 24 * 60 * 60 * 1000;
    case '30d':
      return now - 30 * 24 * 60 * 60 * 1000;
    default: {
      const _exhaustive: never = range;
      return _exhaustive;
    }
  }
}

function filterByDateRange(sessions: Session[], range: DateRange): Session[] {
  const start = getDateRangeStart(range);
  if (start == null) return sessions;
  return sessions.filter((s) => (s.started_at ?? 0) >= start);
}

// ── Page defaults ────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 50;

const DEFAULT_FILTERS: SessionFiltersState = {
  origin: 'all',
  activeOnly: true,
  dateRange: 'all',
};

// ── Component ────────────────────────────────────────────────────────────────

export default function SessionsListPage() {
  const sessions = useSessionsStore((s) => s.sessions);
  const setSessions = useSessionsStore((s) => s.setSessions);
  const [filters, setFilters] = useState<SessionFiltersState>(DEFAULT_FILTERS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [displayCount, setDisplayCount] = useState(DEFAULT_LIMIT);

  // Fetch sessions from API on mount
  useEffect(() => {
    let cancelled = false;

    async function fetchSessions() {
      try {
        setLoading(true);
        setError(null);
        const data = await apiGet<EnrichedSession[]>('/api/sessions?limit=500').catch(
          (err: unknown) => {
            if (err instanceof ApiError) {
              throw new Error(`Failed to fetch sessions: ${err.status}`);
            }
            throw err;
          },
        );
        if (!cancelled) {
          setSessions(data);
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

    void fetchSessions();
    return () => {
      cancelled = true;
    };
  }, [setSessions]);

  // Apply date range filter before passing to table (table handles origin + active filters)
  const dateFilteredSessions = useMemo(
    () => filterByDateRange(sessions, filters.dateRange),
    [sessions, filters.dateRange],
  );

  // Paginated subset for display
  const displayedSessions = useMemo(
    () => dateFilteredSessions.slice(0, displayCount),
    [dateFilteredSessions, displayCount],
  );

  // Load more handler
  const handleLoadMore = useCallback(() => {
    setDisplayCount((prev) => prev + DEFAULT_LIMIT);
  }, []);

  const hasMore = displayCount < dateFilteredSessions.length;

  // End session handler
  const handleEndSession = useCallback(async (sessionId: string) => {
    try {
      await apiPost(`/api/sessions/${sessionId}/end`, undefined);
      setSessions(
        sessions.map((s) =>
          s.id === sessionId ? { ...s, ended_at: Date.now() } : s,
        ),
      );
    } catch {
      // silently fail
    }
  }, [sessions, setSessions]);

  // Restart session handler
  const handleRestartSession = useCallback(async (sessionId: string) => {
    try {
      await apiPost(`/api/sessions/${sessionId}/restart`, undefined);
      setSessions(
        sessions.map((s) =>
          s.id === sessionId ? { ...s, ended_at: null } : s,
        ),
      );
    } catch {
      // silently fail
    }
  }, [sessions, setSessions]);

  // Filter change handler
  const handleFiltersChange = useCallback((newFilters: SessionFiltersState) => {
    setFilters(newFilters);
    setDisplayCount(DEFAULT_LIMIT);
  }, []);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <List size={24} className="text-deck-accent" />
        <h1 className="text-2xl font-bold text-deck-text">Sessions</h1>
      </div>

      {/* Filters */}
      <SessionFilters
        filters={filters}
        onChange={handleFiltersChange}
        sessionCount={dateFilteredSessions.length}
      />

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-deck-border border-t-deck-accent" />
        </div>
      ) : error != null ? (
        <div className="rounded-lg border border-deck-danger/30 bg-deck-danger/10 p-4 text-sm text-deck-danger">
          {error}
        </div>
      ) : (
        <>
          <SessionsTable
            sessions={displayedSessions}
            originFilter={filters.origin}
            activeOnly={filters.activeOnly}
            onEndSession={handleEndSession}
            onRestartSession={handleRestartSession}
          />

          {/* Load more */}
          {hasMore && (
            <div className="flex justify-center pt-2">
              <button
                onClick={handleLoadMore}
                className="rounded-md border border-deck-border px-4 py-2 text-sm text-deck-muted transition-colors hover:border-deck-accent hover:text-deck-text"
              >
                Load more ({dateFilteredSessions.length - displayCount} remaining)
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
