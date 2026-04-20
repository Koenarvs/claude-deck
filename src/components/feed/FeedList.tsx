import { useCallback } from 'react';
import { FixedSizeList } from 'react-window';
import type { ListChildComponentProps } from 'react-window';
import FeedRow from './FeedRow';
import type { HookEvent } from '../../shared/types';

const ROW_HEIGHT = 40;

interface FeedListProps {
  events: HookEvent[];
  height: number;
}

/** Virtualized feed list using react-window FixedSizeList. Handles 10k+ events at 30fps. */
export default function FeedList({ events, height }: FeedListProps) {
  const Row = useCallback(
    ({ index, style }: ListChildComponentProps) => {
      const event = events[index];
      if (!event) return null;
      return <FeedRow event={event} style={style} />;
    },
    [events],
  );

  if (events.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-deck-muted">
        No events yet. Events will appear as hook events arrive.
      </div>
    );
  }

  return (
    <FixedSizeList
      height={height}
      width="100%"
      itemCount={events.length}
      itemSize={ROW_HEIGHT}
      overscanCount={20}
    >
      {Row}
    </FixedSizeList>
  );
}

export { ROW_HEIGHT };
