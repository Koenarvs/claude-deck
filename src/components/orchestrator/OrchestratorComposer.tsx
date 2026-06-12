import { useState, useCallback } from 'react';
import { Send } from 'lucide-react';

export default function OrchestratorComposer({ onSend, disabled }: { onSend: (text: string) => void; disabled: boolean }) {
  const [value, setValue] = useState('');

  const submit = useCallback(() => {
    const t = value.trim();
    if (!t || disabled) return;
    onSend(t);
    setValue('');
  }, [value, disabled, onSend]);

  return (
    <div className="border-t border-deck-border bg-deck-surface px-4 py-3">
      <div className="flex items-end gap-2">
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
          disabled={disabled}
          rows={1}
          placeholder="Message the orchestrator… (Enter to send, Shift+Enter for newline)"
          className="flex-1 resize-none rounded-lg border border-deck-border bg-deck-bg px-3 py-2 text-sm text-deck-text outline-none focus:border-deck-accent disabled:opacity-50"
        />
        <button
          type="button" onClick={submit} disabled={disabled || !value.trim()}
          aria-label="Send message"
          className="flex h-9 w-9 items-center justify-center rounded-lg bg-deck-accent text-white disabled:opacity-30"
        >
          <Send size={16} />
        </button>
      </div>
    </div>
  );
}
