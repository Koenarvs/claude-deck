import { useState, useCallback } from 'react';
import { useMessagesStore } from '@/stores/useMessagesStore';
import type { GoalStatus, Message } from '@shared/types';
import MessageStream from './MessageStream';
import InputBar from './InputBar';

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
    (state) => state.byGoalId[goalId] ?? [],
  );
  const addMessage = useMessagesStore((state) => state.addMessage);

  const handleSend = useCallback(
    async (prompt: string) => {
      setIsSending(true);
      setError(null);

      // Optimistic: add user message immediately
      const optimisticMessage: Message = {
        id: `optimistic-${Date.now()}`,
        session_id: '',
        role: 'user',
        content: prompt,
        tool_name: null,
        tool_args: null,
        tool_result: null,
        tool_use_id: null,
        token_in: null,
        token_out: null,
        created_at: Date.now(),
      };
      addMessage(goalId, '', optimisticMessage);

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
    [goalId, addMessage],
  );

  return (
    <div className="flex flex-1 flex-col" data-testid="goal-conversation">
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
