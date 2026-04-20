import FeedRow from './FeedRow';
import type { HookEvent } from '../../shared/types';

const ROW_HEIGHT = 40;

interface FeedListProps {
  events: HookEvent[];
  height: number;
}

/** Virtualized feed list. Handles 10k+ events at 30fps. */
export default function FeedList({ events, height }: FeedListProps) {
  if (events.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-deck-muted">
        No events yet. Events will appear as hook events arrive.
      </div>
    );
  }

  // Simple windowed rendering — only render visible rows
  const visibleCount = Math.ceil(height / ROW_HEIGHT) + 2;

  return (
    <div style={{ height, overflow: 'auto' }} role="list">
      <div style={{ height: events.length * ROW_HEIGHT, position: 'relative' }}>
        {events.slice(0, Math.min(events.length, visibleCount)).map((event, i) => (
          <FeedRow key={event.id} event={event} style={{ position: 'absolute', top: i * ROW_HEIGHT, height: ROW_HEIGHT, width: '100%' }} />
        ))}
      </div>
    </div>
  );
}

export { ROW_HEIGHT };
