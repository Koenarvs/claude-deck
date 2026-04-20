import { useRef, useEffect } from 'react';
import { User, Bot, Wrench, Terminal, Info } from 'lucide-react';
import type { Message, MessageRole } from '../../shared/types';

interface MessageStreamProps {
  messages: Message[];
  readOnly: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(epoch: number): string {
  const d = new Date(epoch);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

interface RoleConfig {
  icon: React.ReactNode;
  label: string;
  bgClass: string;
  borderClass: string;
  iconBgClass: string;
}

const ROLE_CONFIG: Record<MessageRole, RoleConfig> = {
  user: {
    icon: <User size={14} />,
    label: 'User',
    bgClass: 'bg-deck-accent/5',
    borderClass: 'border-deck-accent/20',
    iconBgClass: 'bg-deck-accent/15 text-deck-accent',
  },
  assistant: {
    icon: <Bot size={14} />,
    label: 'Assistant',
    bgClass: 'bg-deck-surface',
    borderClass: 'border-deck-border',
    iconBgClass: 'bg-deck-success/15 text-deck-success',
  },
  system: {
    icon: <Info size={14} />,
    label: 'System',
    bgClass: 'bg-deck-warning/5',
    borderClass: 'border-deck-warning/20',
    iconBgClass: 'bg-deck-warning/15 text-deck-warning',
  },
  tool_use: {
    icon: <Wrench size={14} />,
    label: 'Tool Use',
    bgClass: 'bg-deck-bg',
    borderClass: 'border-deck-border',
    iconBgClass: 'bg-deck-muted/15 text-deck-muted',
  },
  tool_result: {
    icon: <Terminal size={14} />,
    label: 'Tool Result',
    bgClass: 'bg-deck-bg',
    borderClass: 'border-deck-border',
    iconBgClass: 'bg-deck-muted/15 text-deck-muted',
  },
};

// ── Component ────────────────────────────────────────────────────────────────

export default function MessageStream({ messages, readOnly: _readOnly }: MessageStreamProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-deck-muted">
        <p className="text-sm">No messages in this session.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-2 overflow-y-auto">
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

// ── MessageBubble ────────────────────────────────────────────────────────────

interface MessageBubbleProps {
  message: Message;
}

function MessageBubble({ message }: MessageBubbleProps) {
  const config = ROLE_CONFIG[message.role];

  return (
    <div className={`rounded-lg border ${config.borderClass} ${config.bgClass} p-3`}>
      {/* Header */}
      <div className="mb-1.5 flex items-center gap-2">
        <span className={`flex h-5 w-5 items-center justify-center rounded ${config.iconBgClass}`}>
          {config.icon}
        </span>
        <span className="text-xs font-medium text-deck-text">{config.label}</span>
        {message.tool_name != null && (
          <span className="rounded bg-deck-border px-1.5 py-0.5 font-mono text-xs text-deck-muted">
            {message.tool_name}
          </span>
        )}
        <span className="ml-auto text-xs text-deck-muted">{formatTime(message.created_at)}</span>
      </div>

      {/* Content */}
      {message.content != null && (
        <div className="whitespace-pre-wrap text-sm text-deck-text">{message.content}</div>
      )}

      {/* Tool args (for tool_use messages) */}
      {message.role === 'tool_use' && message.tool_args != null && (
        <pre className="mt-2 max-h-40 overflow-auto rounded bg-deck-bg p-2 font-mono text-xs text-deck-muted">
          {formatToolArgs(message.tool_args)}
        </pre>
      )}

      {/* Tool result */}
      {message.role === 'tool_result' && message.tool_result != null && (
        <pre className="mt-2 max-h-40 overflow-auto rounded bg-deck-bg p-2 font-mono text-xs text-deck-muted">
          {message.tool_result}
        </pre>
      )}
    </div>
  );
}

function formatToolArgs(argsJson: string): string {
  try {
    const parsed: unknown = JSON.parse(argsJson);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return argsJson;
  }
}
