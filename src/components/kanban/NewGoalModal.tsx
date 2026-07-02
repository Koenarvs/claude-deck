import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { X } from 'lucide-react';
import { CreateGoalInputSchema } from '../../shared/schemas';
import type { Goal, GoalModel, PermissionMode, CreateGoalInput } from '../../shared/types';
import { GoalSchema } from '../../shared/schemas';
import { apiPost, ApiError } from '../../lib/api';
import { useGoalsStore } from '../../stores/useGoalsStore';
import { useModelOptions } from '../../lib/useModelOptions';

interface DuplicateInfo {
  existing_goal_id: string;
  existing_title: string;
}

interface NewGoalModalProps {
  open: boolean;
  onClose: () => void;
}

const PERMISSION_OPTIONS: { value: PermissionMode; label: string }[] = [
  { value: 'supervised', label: 'Supervised' },
  { value: 'autonomous', label: 'Autonomous' },
];

export default function NewGoalModal({ open, onClose }: NewGoalModalProps) {
  const navigate = useNavigate();
  const upsertGoal = useGoalsStore((s) => s.upsertGoal);
  const modelOptions = useModelOptions();
  const backdropRef = useRef<HTMLDivElement>(null);

  const [title, setTitle] = useState('');
  const [cwd, setCwd] = useState('');
  const [model, setModel] = useState<GoalModel>('default');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('supervised');
  const [agentType, setAgentType] = useState('');
  const [initialPrompt, setInitialPrompt] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicateInfo | null>(null);

  const resetForm = useCallback(() => {
    setTitle('');
    setCwd('');
    setModel('default');
    setPermissionMode('supervised');
    setAgentType('');
    setInitialPrompt('');
    setTagsInput('');
    setError(null);
    setDuplicate(null);
    setSubmitting(false);
  }, []);

  const handleClose = useCallback(() => {
    resetForm();
    onClose();
  }, [resetForm, onClose]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === backdropRef.current) {
        handleClose();
      }
    },
    [handleClose],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
      }
    },
    [handleClose],
  );

  const handleResumeExisting = useCallback(() => {
    if (!duplicate) return;
    handleClose();
    navigate(`/goals/${duplicate.existing_goal_id}`);
  }, [duplicate, handleClose, navigate]);

  const handleUseNewName = useCallback(() => {
    setDuplicate(null);
    setError(null);
    const titleInput = document.getElementById('goal-title');
    if (titleInput) titleInput.focus();
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      setDuplicate(null);

      const tags = tagsInput
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);

      const input: CreateGoalInput = {
        title: title.trim(),
        cwd: cwd.trim(),
        model: model !== 'default' ? model : undefined,
        permission_mode: permissionMode,
        tags: tags.length > 0 ? tags : undefined,
        initialPrompt: initialPrompt.trim() || undefined,
        agent_type: agentType || undefined,
      };

      // Client-side validation
      const validation = CreateGoalInputSchema.safeParse(input);
      if (!validation.success) {
        const firstError = validation.error.errors[0];
        setError(firstError ? firstError.message : 'Invalid input');
        return;
      }

      setSubmitting(true);

      // Optimistic insert with temporary ID
      const tempId = `temp-${Date.now()}`;
      const optimisticGoal: Goal = {
        id: tempId,
        title: input.title,
        description: input.description ?? null,
        cwd: input.cwd,
        status: 'planning',
        priority: 0,
        tags: tags,
        current_session_id: null,
        model: input.model ?? null,
        permission_mode: input.permission_mode ?? 'supervised',
        plan_json: null,
        kanban_order: Date.now(),
        created_at: Date.now(),
        updated_at: Date.now(),
        completed_at: null,
      };
      upsertGoal(optimisticGoal);

      try {
        const created = await apiPost('/api/goals', input, GoalSchema);
        // Remove optimistic, insert real
        useGoalsStore.getState().removeGoal(tempId);
        upsertGoal(created as Goal);
        handleClose();
      } catch (err) {
        // Rollback optimistic insert
        useGoalsStore.getState().removeGoal(tempId);
        if (err instanceof ApiError && err.status === 409) {
          const body = err.body as Record<string, unknown>;
          if (body && typeof body.existing_goal_id === 'string') {
            setDuplicate({
              existing_goal_id: body.existing_goal_id,
              existing_title: (body.existing_title as string) ?? title.trim(),
            });
            setSubmitting(false);
            return;
          }
        }
        if (err instanceof Error) {
          setError(err.message);
        } else {
          setError('Failed to create goal');
        }
        setSubmitting(false);
      }
    },
    [title, cwd, model, permissionMode, initialPrompt, tagsInput, upsertGoal, handleClose],
  );

  if (!open) return null;

  return (
    <div
      ref={backdropRef}
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-modal="true"
      aria-label="Create new goal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="w-full max-w-lg rounded-xl border border-deck-border bg-deck-surface shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-deck-border px-5 py-4">
          <h2 className="text-lg font-semibold text-deck-text">New Goal</h2>
          <button
            type="button"
            onClick={handleClose}
            className="rounded p-1 text-deck-muted transition-colors hover:bg-deck-border hover:text-deck-text
              focus:outline-none focus:ring-2 focus:ring-deck-accent"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Duplicate goal resolution */}
        {duplicate ? (
          <div className="space-y-4 px-5 py-4">
            <p className="text-sm text-deck-text">
              A goal named <strong>&ldquo;{duplicate.existing_title}&rdquo;</strong> already exists.
            </p>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={handleResumeExisting}
                className="rounded-md bg-deck-accent px-4 py-2 text-sm font-medium text-white transition-colors
                  hover:bg-deck-accent-hover focus:outline-none focus:ring-2 focus:ring-deck-accent focus:ring-offset-1 focus:ring-offset-deck-bg"
              >
                Resume existing goal
              </button>
              <button
                type="button"
                onClick={handleUseNewName}
                className="rounded-md border border-deck-border px-4 py-2 text-sm font-medium text-deck-text transition-colors
                  hover:bg-deck-border focus:outline-none focus:ring-2 focus:ring-deck-accent"
              >
                Use a different name
              </button>
              <button
                type="button"
                onClick={handleClose}
                className="rounded-md px-4 py-2 text-sm font-medium text-deck-muted transition-colors
                  hover:bg-deck-border hover:text-deck-text focus:outline-none focus:ring-2 focus:ring-deck-accent"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
        /* Form */
        <form onSubmit={handleSubmit} className="space-y-4 px-5 py-4">
          {/* Title */}
          <div>
            <label htmlFor="goal-title" className="mb-1 block text-sm font-medium text-deck-text">
              Title <span className="text-deck-danger">*</span>
            </label>
            <input
              id="goal-title"
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What do you want to accomplish?"
              className="w-full rounded-md border border-deck-border bg-deck-bg px-3 py-2 text-sm text-deck-text
                placeholder:text-deck-muted focus:border-deck-accent focus:outline-none focus:ring-1 focus:ring-deck-accent"
              autoFocus
            />
          </div>

          {/* Working Directory */}
          <div>
            <label htmlFor="goal-cwd" className="mb-1 block text-sm font-medium text-deck-text">
              Working Directory <span className="text-deck-danger">*</span>
            </label>
            <input
              id="goal-cwd"
              type="text"
              required
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="/path/to/project"
              className="w-full rounded-md border border-deck-border bg-deck-bg px-3 py-2 text-sm font-mono text-deck-text
                placeholder:text-deck-muted focus:border-deck-accent focus:outline-none focus:ring-1 focus:ring-deck-accent"
            />
          </div>

          {/* Model + Permission + Agent row */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label htmlFor="goal-model" className="mb-1 block text-sm font-medium text-deck-text">
                Model
              </label>
              <select
                id="goal-model"
                value={model}
                onChange={(e) => setModel(e.target.value as GoalModel)}
                className="w-full rounded-md border border-deck-border bg-deck-bg px-3 py-2 text-sm text-deck-text
                  focus:border-deck-accent focus:outline-none focus:ring-1 focus:ring-deck-accent"
              >
                {modelOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="goal-permission" className="mb-1 block text-sm font-medium text-deck-text">
                Permission
              </label>
              <select
                id="goal-permission"
                value={permissionMode}
                onChange={(e) => setPermissionMode(e.target.value as PermissionMode)}
                className="w-full rounded-md border border-deck-border bg-deck-bg px-3 py-2 text-sm text-deck-text
                  focus:border-deck-accent focus:outline-none focus:ring-1 focus:ring-deck-accent"
              >
                {PERMISSION_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="goal-agent" className="mb-1 block text-sm font-medium text-deck-text">
                Agent
              </label>
              <select
                id="goal-agent"
                value={agentType}
                onChange={(e) => setAgentType(e.target.value)}
                className="w-full rounded-md border border-deck-border bg-deck-bg px-3 py-2 text-sm text-deck-text
                  focus:border-deck-accent focus:outline-none focus:ring-1 focus:ring-deck-accent"
              >
                <option value="">Default (none)</option>
                <option value="orchestrator">Orchestrator</option>
                <option value="orchestrator-lite">Orchestrator Lite</option>
                <option value="dev-looker">Dev Looker</option>
                <option value="dev-dataform">Dev Dataform</option>
                <option value="dev-claude-deck">Dev Claude Deck</option>
                <option value="research">Research</option>
                <option value="eval">Eval</option>
                <option value="scorer">Scorer</option>
              </select>
            </div>
          </div>

          {/* Tags */}
          <div>
            <label htmlFor="goal-tags" className="mb-1 block text-sm font-medium text-deck-text">
              Tags
            </label>
            <input
              id="goal-tags"
              type="text"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="comma-separated (e.g. frontend, bugfix)"
              className="w-full rounded-md border border-deck-border bg-deck-bg px-3 py-2 text-sm text-deck-text
                placeholder:text-deck-muted focus:border-deck-accent focus:outline-none focus:ring-1 focus:ring-deck-accent"
            />
          </div>

          {/* Initial Prompt */}
          <div>
            <label htmlFor="goal-prompt" className="mb-1 block text-sm font-medium text-deck-text">
              Initial Prompt
            </label>
            <textarea
              id="goal-prompt"
              value={initialPrompt}
              onChange={(e) => setInitialPrompt(e.target.value)}
              placeholder="What should Claude work on first?"
              rows={3}
              className="w-full resize-y rounded-md border border-deck-border bg-deck-bg px-3 py-2 text-sm text-deck-text
                placeholder:text-deck-muted focus:border-deck-accent focus:outline-none focus:ring-1 focus:ring-deck-accent"
            />
          </div>

          {/* Error */}
          {error && (
            <p className="text-sm text-deck-danger" role="alert">
              {error}
            </p>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={handleClose}
              className="rounded-md px-4 py-2 text-sm font-medium text-deck-muted transition-colors
                hover:bg-deck-border hover:text-deck-text focus:outline-none focus:ring-2 focus:ring-deck-accent"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-md bg-deck-accent px-4 py-2 text-sm font-medium text-white transition-colors
                hover:bg-deck-accent-hover disabled:cursor-not-allowed disabled:opacity-50
                focus:outline-none focus:ring-2 focus:ring-deck-accent focus:ring-offset-1 focus:ring-offset-deck-bg"
            >
              {submitting ? 'Creating...' : 'Create Goal'}
            </button>
          </div>
        </form>
        )}
      </div>
    </div>
  );
}
