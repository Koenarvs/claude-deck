import {
  Play,
  Wrench,
  MessageSquare,
  Square,
  CircleDot,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { HookEvent, HookEventType } from '../../shared/types';

const MAX_DISPLAY = 20;

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

interface ActivityRowProps {
  event: HookEvent;
}

function ActivityRow({ event }: ActivityRowProps) {
  return (
    <div className="flex items-center gap-3 border-b border-deck-border px-3 py-2 last:border-b-0">
      <span className="shrink-0">{eventIcon(event.event_type)}</span>
      <span className="w-16 shrink-0 font-mono text-xs text-deck-muted">
        {formatTimestamp(event.created_at)}
      </span>
      <span className="w-16 shrink-0 font-mono text-xs text-deck-muted">
        {shortSessionId(event.session_id)}
      </span>
      <span className="text-xs font-medium text-deck-text">
        {event.event_type}
      </span>
      {event.tool_name && (
        <span className="rounded bg-deck-border px-1.5 py-0.5 text-xs text-deck-muted">
          {event.tool_name}
        </span>
      )}
    </div>
  );
}

export interface RecentActivityFeedProps {
  events: HookEvent[];
}

export default function RecentActivityFeed({ events }: RecentActivityFeedProps) {
  const displayed = events.slice(0, MAX_DISPLAY);

  if (displayed.length === 0) {
    return (
      <div className="rounded-lg border border-deck-border bg-deck-surface p-6 text-center text-sm text-deck-muted">
        No activity yet. Events will appear as hook events arrive.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-deck-border bg-deck-surface">
      <div className="border-b border-deck-border px-3 py-2">
        <h3 className="text-sm font-medium text-deck-text">Recent Activity</h3>
      </div>
      <div className="max-h-[400px] overflow-y-auto">
        {displayed.map((event) => (
          <ActivityRow key={event.id} event={event} />
        ))}
      </div>
    </div>
  );
}
