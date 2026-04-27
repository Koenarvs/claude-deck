import { useState, memo } from 'react';
import {
  User,
  Bot,
  Terminal,
  ChevronDown,
  ChevronRight,
  Brain,
  Wrench,
} from 'lucide-react';
import type { Message, MessageRole } from '@shared/types';

interface MessageBubbleProps {
  message: Message;
}

const roleConfig: Record<
  MessageRole,
  { icon: typeof User; label: string; bgClass: string; borderClass: string }
> = {
  user: {
    icon: User,
    label: 'You',
    bgClass: 'bg-deck-accent/10',
    borderClass: 'border-deck-accent/30',
  },
  assistant: {
    icon: Bot,
    label: 'Claude',
    bgClass: 'bg-deck-surface',
    borderClass: 'border-deck-border',
  },
  system: {
    icon: Terminal,
    label: 'System',
    bgClass: 'bg-deck-warning/10',
    borderClass: 'border-deck-warning/30',
  },
  tool_use: {
    icon: Wrench,
    label: 'Tool Call',
    bgClass: 'bg-deck-surface',
    borderClass: 'border-deck-border',
  },
  tool_result: {
    icon: Terminal,
    label: 'Tool Result',
    bgClass: 'bg-deck-bg',
    borderClass: 'border-deck-border',
  },
};

function formatTimestamp(epoch: number): string {
  const date = new Date(epoch);
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function ToolUseContent({ message }: { message: Message }) {
  const [expanded, setExpanded] = useState(false);

  let parsedArgs: Record<string, unknown> | null = null;
  if (message.tool_args) {
    try {
      parsedArgs = JSON.parse(message.tool_args) as Record<string, unknown>;
    } catch {
      // Display raw string on parse failure
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex items-center gap-1 text-sm text-deck-muted hover:text-deck-text transition-colors"
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Wrench size={14} />
        <span className="font-mono">{message.tool_name ?? 'unknown'}</span>
      </button>
      {expanded && parsedArgs && (
        <pre className="mt-2 rounded-md bg-deck-bg p-3 text-xs text-deck-muted overflow-x-auto max-h-96 overflow-y-auto">
          {JSON.stringify(parsedArgs, null, 2)}
        </pre>
      )}
      {expanded && !parsedArgs && message.tool_args && (
        <pre className="mt-2 rounded-md bg-deck-bg p-3 text-xs text-deck-muted overflow-x-auto max-h-96 overflow-y-auto">
          {message.tool_args}
        </pre>
      )}
    </div>
  );
}

function ToolResultContent({ message }: { message: Message }) {
  const [expanded, setExpanded] = useState(false);
  const resultText = message.tool_result ?? message.content ?? '';
  const isLong = resultText.length > 200;

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex items-center gap-1 text-sm text-deck-muted hover:text-deck-text transition-colors"
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Terminal size={14} />
        <span className="font-mono">{message.tool_name ?? 'result'}</span>
        {!expanded && isLong && (
          <span className="text-xs text-deck-muted ml-1">
            ({resultText.length} chars)
          </span>
        )}
      </button>
      {expanded && (
        <pre className="mt-2 rounded-md bg-deck-bg p-3 text-xs text-deck-muted overflow-x-auto max-h-96 overflow-y-auto whitespace-pre-wrap break-words">
          {resultText}
        </pre>
      )}
    </div>
  );
}

function ThinkingContent({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex items-center gap-1 text-sm text-deck-muted hover:text-deck-text transition-colors"
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Brain size={14} />
        <span className="italic">Thinking...</span>
      </button>
      {expanded && (
        <pre className="mt-2 rounded-md bg-deck-bg/50 border border-deck-border p-3 text-xs text-deck-muted overflow-x-auto max-h-96 overflow-y-auto whitespace-pre-wrap break-words">
          {text}
        </pre>
      )}
    </div>
  );
}

function AssistantContent({ content }: { content: string }) {
  // Check if content contains thinking blocks encoded as markers
  // In the DB, thinking blocks may be embedded with markers or stored as separate messages.
  // For a simple assistant message, just render the text content.
  return (
    <div className="text-sm text-deck-text whitespace-pre-wrap break-words leading-relaxed">
      {content}
    </div>
  );
}

function MessageBubbleInner({ message }: MessageBubbleProps) {
  const config = roleConfig[message.role];
  const Icon = config.icon;

  // Detect if this assistant message contains thinking markers
  const hasThinking =
    message.role === 'assistant' &&
    message.content &&
    message.content.includes('[thinking]');

  let thinkingText = '';
  let displayContent = message.content ?? '';

  if (hasThinking && message.content) {
    const thinkingMatch = message.content.match(
      /\[thinking\]([\s\S]*?)\[\/thinking\]/,
    );
    if (thinkingMatch) {
      thinkingText = thinkingMatch[1];
      displayContent = message.content
        .replace(/\[thinking\][\s\S]*?\[\/thinking\]/, '')
        .trim();
    }
  }

  return (
    <div
      className={`flex gap-3 rounded-lg border px-4 py-3 ${config.bgClass} ${config.borderClass}`}
      data-testid={`message-bubble-${message.role}`}
      data-message-id={message.id}
    >
      <div className="mt-0.5 flex-shrink-0">
        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-deck-border">
          <Icon size={14} className="text-deck-text" />
        </div>
      </div>

      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-xs font-medium text-deck-muted">
            {config.label}
          </span>
          <span className="text-xs text-deck-muted/60">
            {formatTimestamp(message.created_at)}
          </span>
        </div>

        {message.role === 'tool_use' && <ToolUseContent message={message} />}

        {message.role === 'tool_result' && (
          <ToolResultContent message={message} />
        )}

        {message.role === 'assistant' && (
          <>
            {thinkingText && <ThinkingContent text={thinkingText} />}
            <AssistantContent content={displayContent} />
          </>
        )}

        {message.role === 'user' && (
          <div className="text-sm text-deck-text whitespace-pre-wrap break-words">
            {message.content}
          </div>
        )}

        {message.role === 'system' && (
          <div className="text-sm text-deck-warning/80 italic whitespace-pre-wrap break-words">
            {message.content}
          </div>
        )}
      </div>
    </div>
  );
}

export const MessageBubble = memo(MessageBubbleInner);
