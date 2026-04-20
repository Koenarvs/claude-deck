import { useEffect, useState, useCallback } from 'react';
import { Activity, Filter, RotateCcw } from 'lucide-react';
import { useFeedStore } from '../stores/useFeedStore';
import FeedList, { ROW_HEIGHT } from '../components/feed/FeedList';
import type { HookEventType } from '../shared/types';

const EVENT_TYPES: HookEventType[] = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
];

export default function FeedPage() {
  const events = useFeedStore((s) => s.events);
  const setEvents = useFeedStore((s) => s.setEvents);
  const [filterType, setFilterType] = useState<HookEventType | 'all'>('all');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/hook-events?limit=500')
      .then((res) => (res.ok ? res.json() : []))
      .then((data: unknown) => {
        if (Array.isArray(data)) setEvents(data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [setEvents]);

  const filtered = filterType === 'all'
    ? events
    : events.filter((e) => e.event_type === filterType);

  const handleClear = useCallback(() => {
    useFeedStore.setState({ events: [] });
  }, []);

  const listHeight = Math.max(400, Math.min(filtered.length * ROW_HEIGHT, 800));

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Activity className="h-6 w-6 animate-pulse text-deck-muted" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-deck-text">Activity Feed</h1>
        <span className="text-sm text-deck-muted">{filtered.length} events</span>
      </div>

      <div className="flex items-center gap-3">
        <Filter size={16} className="text-deck-muted" />
        <select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value as HookEventType | 'all')}
          className="rounded border border-deck-border bg-deck-surface px-2 py-1 text-sm text-deck-text"
        >
          <option value="all">All Events</option>
          {EVENT_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <button
          onClick={handleClear}
          className="flex items-center gap-1 rounded border border-deck-border px-2 py-1 text-sm text-deck-muted hover:text-deck-text"
        >
          <RotateCcw size={14} />
          Clear
        </button>
      </div>

      <div className="rounded-lg border border-deck-border bg-deck-surface">
        <FeedList events={filtered} height={listHeight} />
      </div>
    </div>
  );
}
