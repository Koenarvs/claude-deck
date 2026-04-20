import { Filter, RotateCcw } from 'lucide-react';
import type { SessionOrigin } from '../../shared/types';

// ── Types ────────────────────────────────────────────────────────────────────

export type DateRange = 'today' | '7d' | '30d' | 'all';

export interface SessionFiltersState {
  origin: SessionOrigin | 'all';
  activeOnly: boolean;
  dateRange: DateRange;
}

interface SessionFiltersProps {
  filters: SessionFiltersState;
  onChange: (filters: SessionFiltersState) => void;
  sessionCount: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

const ORIGIN_OPTIONS: Array<{ value: SessionOrigin | 'all'; label: string }> = [
  { value: 'all', label: 'All Origins' },
  { value: 'dashboard', label: 'Dashboard' },
  { value: 'external', label: 'External' },
];

const DATE_RANGE_OPTIONS: Array<{ value: DateRange; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'all', label: 'All time' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_FILTERS: SessionFiltersState = {
  origin: 'all',
  activeOnly: false,
  dateRange: 'all',
};

function hasActiveFilters(filters: SessionFiltersState): boolean {
  return (
    filters.origin !== DEFAULT_FILTERS.origin ||
    filters.activeOnly !== DEFAULT_FILTERS.activeOnly ||
    filters.dateRange !== DEFAULT_FILTERS.dateRange
  );
}

// ── Component ────────────────────────────────────────────────────────────────

export default function SessionFilters({ filters, onChange, sessionCount }: SessionFiltersProps) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-2 text-deck-muted">
        <Filter size={16} />
        <span className="text-sm font-medium">Filters</span>
      </div>

      {/* Origin dropdown */}
      <select
        value={filters.origin}
        onChange={(e) =>
          onChange({ ...filters, origin: e.target.value as SessionOrigin | 'all' })
        }
        className="rounded-md border border-deck-border bg-deck-surface px-3 py-1.5 text-sm text-deck-text outline-none focus:border-deck-accent"
      >
        {ORIGIN_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>

      {/* Date range dropdown */}
      <select
        value={filters.dateRange}
        onChange={(e) => onChange({ ...filters, dateRange: e.target.value as DateRange })}
        className="rounded-md border border-deck-border bg-deck-surface px-3 py-1.5 text-sm text-deck-text outline-none focus:border-deck-accent"
      >
        {DATE_RANGE_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>

      {/* Active-only toggle */}
      <label className="flex cursor-pointer items-center gap-2 text-sm text-deck-muted">
        <input
          type="checkbox"
          checked={filters.activeOnly}
          onChange={(e) => onChange({ ...filters, activeOnly: e.target.checked })}
          className="h-4 w-4 rounded border-deck-border bg-deck-surface accent-deck-accent"
        />
        Active only
      </label>

      {/* Reset */}
      {hasActiveFilters(filters) && (
        <button
          onClick={() => onChange(DEFAULT_FILTERS)}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-deck-muted transition-colors hover:bg-deck-border hover:text-deck-text"
        >
          <RotateCcw size={12} />
          Reset
        </button>
      )}

      {/* Count */}
      <span className="ml-auto text-sm text-deck-muted">
        {sessionCount} session{sessionCount !== 1 ? 's' : ''}
      </span>
    </div>
  );
}
