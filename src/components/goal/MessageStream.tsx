import { useRef, useEffect } from 'react';
import type { Message } from '@shared/types';
import { MessageBubble } from './MessageBubble';

interface MessageStreamProps {
  messages: Message[];
}

export default function MessageStream({ messages }: MessageStreamProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(messages.length);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (messages.length > prevCountRef.current && messages.length > 0) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    prevCountRef.current = messages.length;
  }, [messages.length]);

  if (messages.length === 0) {
    return (
      <div
        className="flex flex-1 items-center justify-center text-deck-muted"
        data-testid="message-stream-empty"
      >
        <p className="text-sm">No messages yet. Send a prompt to get started.</p>
      </div>
    );
  }

  return (
    <div
      className="flex-1 overflow-y-auto px-2 py-2 space-y-2"
      data-testid="message-stream"
    >
      {messages.map((message) => (
        <MessageBubble key={message.id} message={message} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
