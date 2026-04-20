import { useState, useCallback, useRef, useEffect } from 'react';
import {
  StopCircle,
  Download,
  FolderOpen,
  Check,
  X,
  Pencil,
} from 'lucide-react';
import type { Goal, GoalModel, GoalStatus } from '@shared/types';

interface GoalHeaderProps {
  goal: Goal;
  onTitleUpdate: (title: string) => void;
  onModelChange: (model: GoalModel) => void;
  onInterrupt: () => void;
  isInterrupting: boolean;
}

const statusColors: Record<GoalStatus, string> = {
  planning: 'bg-deck-warning/20 text-deck-warning',
  active: 'bg-deck-success/20 text-deck-success',
  waiting: 'bg-deck-accent/20 text-deck-accent',
  complete: 'bg-deck-muted/20 text-deck-muted',
  archived: 'bg-deck-muted/20 text-deck-muted/60',
};

const modelOptions: { value: GoalModel; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
];

export default function GoalHeader({
  goal,
  onTitleUpdate,
  onModelChange,
  onInterrupt,
  isInterrupting,
}: GoalHeaderProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(goal.title);
  const inputRef = useRef<HTMLInputElement>(null);

  const canInterrupt = goal.status === 'active' && goal.current_session_id !== null;
  const isTerminal = goal.status === 'complete' || goal.status === 'archived';

  const startEditing = useCallback(() => {
    setEditValue(goal.title);
    setIsEditing(true);
  }, [goal.title]);

  const commitEdit = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== goal.title) {
      onTitleUpdate(trimmed);
    }
    setIsEditing(false);
  }, [editValue, goal.title, onTitleUpdate]);

  const cancelEdit = useCallback(() => {
    setEditValue(goal.title);
    setIsEditing(false);
  }, [goal.title]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        commitEdit();
      } else if (e.key === 'Escape') {
        cancelEdit();
      }
    },
    [commitEdit, cancelEdit],
  );

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  return (
    <header
      className="flex flex-wrap items-center gap-3 border-b border-deck-border bg-deck-surface px-4 py-3"
      data-testid="goal-header"
    >
      {/* Title (inline-editable) */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {isEditing ? (
          <div className="flex items-center gap-1">
            <input
              ref={inputRef}
              type="text"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={commitEdit}
              className="rounded border border-deck-accent bg-deck-bg px-2 py-1 text-lg font-semibold text-deck-text outline-none"
              data-testid="goal-title-input"
            />
            <button
              type="button"
              onClick={commitEdit}
              className="rounded p-1 text-deck-success hover:bg-deck-border transition-colors"
              aria-label="Save title"
            >
              <Check size={14} />
            </button>
            <button
              type="button"
              onClick={cancelEdit}
              className="rounded p-1 text-deck-danger hover:bg-deck-border transition-colors"
              aria-label="Cancel editing"
            >
              <X size={14} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={startEditing}
            className="group flex items-center gap-2 text-left"
            data-testid="goal-title-display"
          >
            <h1 className="truncate text-lg font-semibold text-deck-text">
              {goal.title}
            </h1>
            <Pencil
              size={14}
              className="text-deck-muted opacity-0 group-hover:opacity-100 transition-opacity"
            />
          </button>
        )}
      </div>

      {/* Status badge */}
      <span
        className={`rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${statusColors[goal.status]}`}
        data-testid="goal-status-badge"
      >
        {goal.status}
      </span>

      {/* CWD */}
      <div
        className="hidden items-center gap-1 text-xs text-deck-muted sm:flex"
        title={goal.cwd}
      >
        <FolderOpen size={12} />
        <span className="max-w-[200px] truncate">{goal.cwd}</span>
      </div>

      {/* Model picker */}
      <select
        value={goal.model ?? 'default'}
        onChange={(e) => onModelChange(e.target.value as GoalModel)}
        disabled={isTerminal}
        className="rounded border border-deck-border bg-deck-bg px-2 py-1 text-xs text-deck-text outline-none focus:border-deck-accent disabled:opacity-50"
        data-testid="goal-model-picker"
        aria-label="Model selection"
      >
        {modelOptions.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>

      {/* Interrupt button */}
      <button
        type="button"
        onClick={onInterrupt}
        disabled={!canInterrupt || isInterrupting}
        className="flex items-center gap-1 rounded border border-deck-danger/30 px-2.5 py-1 text-xs text-deck-danger hover:bg-deck-danger/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        data-testid="goal-interrupt-btn"
        title={canInterrupt ? 'Interrupt current session' : 'No active session'}
      >
        <StopCircle size={14} />
        {isInterrupting ? 'Interrupting...' : 'Interrupt'}
      </button>

      {/* Trace download */}
      <a
        href={`/api/goals/${goal.id}/trace`}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1 rounded border border-deck-border px-2.5 py-1 text-xs text-deck-muted hover:bg-deck-border hover:text-deck-text transition-colors"
        data-testid="goal-trace-download"
        title="Download trace bundle"
      >
        <Download size={14} />
        Trace
      </a>
    </header>
  );
}
