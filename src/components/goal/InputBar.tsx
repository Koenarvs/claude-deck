import { useState, useRef, useCallback } from 'react';
import { Send } from 'lucide-react';
import type { GoalStatus } from '@shared/types';

interface InputBarProps {
  goalStatus: GoalStatus;
  onSend: (prompt: string) => void;
  isSending: boolean;
}

export default function InputBar({
  goalStatus,
  onSend,
  isSending,
}: InputBarProps) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isDisabled =
    goalStatus === 'complete' ||
    goalStatus === 'archived' ||
    isSending;

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || isDisabled) return;
    onSend(trimmed);
    setValue('');
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [value, isDisabled, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Submit on Enter without Shift
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const handleInput = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    // Auto-resize up to 6 lines
    textarea.style.height = 'auto';
    const maxHeight = 6 * 24; // ~6 lines at 24px line height
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
  }, []);

  return (
    <div
      className="border-t border-deck-border bg-deck-surface px-4 py-3"
      data-testid="input-bar"
    >
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            handleInput();
          }}
          onKeyDown={handleKeyDown}
          disabled={isDisabled}
          placeholder={
            isDisabled
              ? goalStatus === 'complete' || goalStatus === 'archived'
                ? 'Goal is complete'
                : 'Sending...'
              : 'Send a follow-up message... (Enter to send, Shift+Enter for newline)'
          }
          rows={1}
          className="flex-1 resize-none rounded-lg border border-deck-border bg-deck-bg px-3 py-2 text-sm text-deck-text placeholder:text-deck-muted/50 outline-none focus:border-deck-accent disabled:opacity-50 disabled:cursor-not-allowed"
          data-testid="input-textarea"
        />
        <button
          type="button"
          onClick={handleSubmit}
          disabled={isDisabled || !value.trim()}
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-deck-accent text-white transition-colors hover:bg-deck-accent-hover disabled:opacity-30 disabled:cursor-not-allowed"
          aria-label="Send message"
          data-testid="input-send-btn"
        >
          <Send size={16} />
        </button>
      </div>
    </div>
  );
}
