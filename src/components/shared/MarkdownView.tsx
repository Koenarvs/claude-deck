import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { PROSE_CLASSES } from './markdownProse';

export interface MarkdownViewProps {
  content: string;
  /** Shown in the header. */
  fileName?: string;
  /** Initial read rendering. Defaults to 'md' (pretty). */
  defaultView?: 'md' | 'txt';
  /**
   * Persist handler. Omit ⇒ read-only (no Edit button). The caller bakes any
   * conflict-detection (loaded mtime → 409) into this closure; MarkdownView only
   * hands back the next content and surfaces a thrown error inline.
   */
  onSave?: (next: string) => Promise<void>;
}

const TOGGLE_BTN =
  'px-2 py-0.5 text-xs font-medium transition-colors';
const TOGGLE_ON = 'bg-deck-accent text-white';
const TOGGLE_OFF = 'text-deck-muted hover:text-deck-text';
const ACTION_BTN =
  'rounded px-2 py-0.5 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

/**
 * Shared markdown renderer with a md/txt read toggle and a distinct edit mode
 * (Edit → textarea → Save/Cancel). Read-only when `onSave` is omitted — the
 * reuse-ready viewer mode (e.g. orchestrator memory.md later).
 */
export default function MarkdownView({
  content,
  fileName,
  defaultView = 'md',
  onSave,
}: MarkdownViewProps) {
  const [view, setView] = useState<'md' | 'txt'>(defaultView);
  const [editing, setEditing] = useState(false);
  const [buffer, setBuffer] = useState(content);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startEdit() {
    setBuffer(content);
    setError(null);
    setEditing(true);
  }

  function cancelEdit() {
    if (buffer !== content && !window.confirm('Discard unsaved changes?')) return;
    setEditing(false);
    setError(null);
  }

  async function save() {
    if (!onSave) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(buffer);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-deck-border px-2 py-1 shrink-0">
        <span className="truncate text-xs text-deck-muted">{fileName}</span>
        <div className="flex items-center gap-1.5">
          {!editing ? (
            <>
              <div className="flex overflow-hidden rounded border border-deck-border">
                <button
                  type="button"
                  aria-pressed={view === 'md'}
                  onClick={() => setView('md')}
                  className={`${TOGGLE_BTN} ${view === 'md' ? TOGGLE_ON : TOGGLE_OFF}`}
                >
                  md
                </button>
                <button
                  type="button"
                  aria-pressed={view === 'txt'}
                  onClick={() => setView('txt')}
                  className={`${TOGGLE_BTN} ${view === 'txt' ? TOGGLE_ON : TOGGLE_OFF}`}
                >
                  txt
                </button>
              </div>
              {onSave && (
                <button
                  type="button"
                  onClick={startEdit}
                  className={`${ACTION_BTN} border border-deck-border text-deck-text hover:bg-deck-border`}
                >
                  Edit
                </button>
              )}
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={cancelEdit}
                disabled={saving}
                className={`${ACTION_BTN} text-deck-muted hover:bg-deck-border hover:text-deck-text`}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className={`${ACTION_BTN} bg-deck-accent text-white hover:bg-deck-accent-hover`}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          )}
        </div>
      </div>

      {error && (
        <p role="alert" className="border-b border-deck-border px-3 py-1.5 text-xs text-deck-danger">
          {error}
        </p>
      )}

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {editing ? (
          <textarea
            aria-label="Edit content"
            value={buffer}
            onChange={(e) => setBuffer(e.target.value)}
            spellCheck={false}
            className="h-full min-h-[12rem] w-full resize-none rounded border border-deck-border bg-deck-bg p-3 font-mono text-sm text-deck-text focus:border-deck-accent focus:outline-none"
          />
        ) : view === 'md' ? (
          <div className={PROSE_CLASSES}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </div>
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-sm text-deck-text/80">
            {content}
          </pre>
        )}
      </div>
    </div>
  );
}
