import { useRef, useEffect } from 'react';
import { List, useListRef } from 'react-window';
import type { RowComponentProps } from 'react-window';
import type { Message } from '@shared/types';
import { MessageBubble } from './MessageBubble';

interface MessageStreamProps {
  messages: Message[];
}

/** Custom props passed to each row via `rowProps`. */
interface MessageRowProps {
  messages: Message[];
}

/** Estimated row height for virtualization. Messages vary in height but
 *  react-window v2's List handles this well. A dynamic row height via
 *  `useDynamicRowHeight` is a v1.1 enhancement. */
const ROW_HEIGHT = 120;

function MessageRow({
  index,
  style,
  messages,
}: RowComponentProps<MessageRowProps>) {
  const message = messages[index];
  return (
    <div style={style}>
      <div className="px-1 py-1">
        <MessageBubble message={message} />
      </div>
    </div>
  );
}

export default function MessageStream({ messages }: MessageStreamProps) {
  const listRef = useListRef();
  const prevCountRef = useRef(messages.length);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (messages.length > prevCountRef.current && messages.length > 0) {
      listRef.current?.scrollToRow({
        index: messages.length - 1,
        align: 'end',
      });
    }
    prevCountRef.current = messages.length;
  }, [messages.length, listRef]);

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
      className="flex-1 overflow-hidden"
      data-testid="message-stream"
    >
      <List
        listRef={listRef}
        rowCount={messages.length}
        rowHeight={ROW_HEIGHT}
        rowComponent={MessageRow}
        rowProps={{ messages }}
        overscanCount={5}
        style={{ height: '100%' }}
      />
    </div>
  );
}
