import { useState, useCallback } from 'react';
import { useMessagesStore } from '@/stores/useMessagesStore';
import type { GoalStatus, Message } from '@shared/types';
import MessageStream from './MessageStream';
import InputBar from './InputBar';

const EMPTY_MESSAGES: Message[] = [];

interface GoalConversationProps {
  goalId: string;
  goalStatus: GoalStatus;
}

/**
 * Renders the conversation panel: virtualized message list + input bar.
 *
 * Messages are populated into the store by GoalDetailPage on mount.
 * New messages arrive via the WS `message:added` event dispatched by
 * ws-manager into useMessagesStore. No fetch happens here.
 */
export default function GoalConversation({
  goalId,
  goalStatus,
}: GoalConversationProps) {
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const messages = useMessagesStore(
    (state) => state.byGoalId[goalId] ?? EMPTY_MESSAGES,
  );
  // addMessage not needed — server saves + broadcasts user messages

  const handleSend = useCallback(
    async (prompt: string) => {
      setIsSending(true);
      setError(null);

      // User message is saved + broadcast by SessionRunner on the server side.
      // No optimistic add needed — the WS event will update the store.

      try {
        const res = await fetch(`/api/goals/${goalId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt }),
        });
        if (!res.ok) {
          throw new Error(`Failed to send message: ${res.status}`);
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Failed to send message',
        );
      } finally {
        setIsSending(false);
      }
    },
    [goalId],
  );

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden" data-testid="goal-conversation">
      {error && (
        <div className="mx-4 mt-2 rounded-lg border border-deck-danger/30 bg-deck-danger/10 px-4 py-2 text-sm text-deck-danger">
          {error}
        </div>
      )}
      <MessageStream messages={messages} />
      <InputBar
        goalStatus={goalStatus}
        onSend={handleSend}
        isSending={isSending}
      />
    </div>
  );
}
