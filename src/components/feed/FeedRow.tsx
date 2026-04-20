import {
  Play,
  Wrench,
  MessageSquare,
  Square,
  CircleDot,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { HookEvent, HookEventType } from '../../shared/types';

/** Icon by event type, consistent with RecentActivityFeed in dashboard. */
function eventIcon(eventType: HookEventType): ReactNode {
  switch (eventType) {
    case 'SessionStart':
      return <Play size={14} className="text-deck-success" />;
    case 'PreToolUse':
      return <Wrench size={14} className="text-deck-warning" />;
    case 'PostToolUse':
      return <Wrench size={14} className="text-deck-accent" />;
    case 'UserPromptSubmit':
      return <MessageSquare size={14} className="text-deck-text" />;
    case 'Stop':
      return <Square size={14} className="text-deck-danger" />;
    default:
      return <CircleDot size={14} className="text-deck-muted" />;
  }
}

/** Chip color class for event type badges. */
function chipColor(eventType: HookEventType): string {
  switch (eventType) {
    case 'SessionStart':
      return 'bg-deck-success/20 text-deck-success';
    case 'PreToolUse':
      return 'bg-deck-warning/20 text-deck-warning';
    case 'PostToolUse':
      return 'bg-deck-accent/20 text-deck-accent';
    case 'UserPromptSubmit':
      return 'bg-deck-text/10 text-deck-text';
    case 'Stop':
      return 'bg-deck-danger/20 text-deck-danger';
    default:
      return 'bg-deck-muted/20 text-deck-muted';
  }
}

function formatTimestamp(epochMs: number): string {
  const date = new Date(epochMs);
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function shortSessionId(id: string | null): string {
  if (!id) return '---';
  return id.slice(0, 8);
}

export interface FeedRowProps {
  event: HookEvent;
  style?: React.CSSProperties;
}

/** A single feed row. Designed for use inside react-window FixedSizeList. */
export default function FeedRow({ event, style }: FeedRowProps) {
  return (
    <div
      style={style}
      className="flex items-center gap-3 border-b border-deck-border px-4 py-0"
      role="row"
    >
      <span className="shrink-0">{eventIcon(event.event_type)}</span>
      <span className="w-16 shrink-0 font-mono text-xs text-deck-muted">
        {formatTimestamp(event.created_at)}
      </span>
      <span
        className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ${chipColor(event.event_type)}`}
      >
        {event.event_type}
      </span>
      {event.tool_name && (
        <span className="rounded bg-deck-border px-1.5 py-0.5 text-xs text-deck-muted">
          {event.tool_name}
        </span>
      )}
      <span className="ml-auto shrink-0 font-mono text-xs text-deck-muted">
        {shortSessionId(event.session_id)}
      </span>
    </div>
  );
}
