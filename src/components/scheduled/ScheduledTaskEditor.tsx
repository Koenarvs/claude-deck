import { useState, useEffect, useCallback } from 'react';
import { X } from 'lucide-react';
import CronPicker, { parseNextFireTimes } from './CronPicker';
import { useModelOptions } from '../../lib/useModelOptions';
import type {
  ScheduledTask,
  GoalTemplate,
  GoalModel,
  CreateScheduledTaskInput,
  UpdateScheduledTaskInput,
} from '../../shared/types';

interface ScheduledTaskEditorProps {
  task: ScheduledTask | null;
  onSave: (input: CreateScheduledTaskInput | (UpdateScheduledTaskInput & { id: string })) => void;
  onCancel: () => void;
}

export default function ScheduledTaskEditor({ task, onSave, onCancel }: ScheduledTaskEditorProps) {
  const MODEL_OPTIONS = useModelOptions();
  const [name, setName] = useState('');
  const [cronExpr, setCronExpr] = useState('');
  const [title, setTitle] = useState('');
  const [cwd, setCwd] = useState('');
  const [model, setModel] = useState<GoalModel>('default');
  const [initialPrompt, setInitialPrompt] = useState('');
  const [tags, setTags] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (task) {
      setName(task.name);
      setCronExpr(task.cron_expr);
      setEnabled(task.enabled);

      try {
        const template: GoalTemplate = JSON.parse(task.goal_template_json);
        setTitle(template.title);
        setCwd(template.cwd);
        setModel(template.model ?? 'default');
        setInitialPrompt(template.initialPrompt ?? '');
        setTags(template.tags?.join(', ') ?? '');
      } catch {
        // If template JSON is invalid, leave fields empty
      }
    }
  }, [task]);

  const validate = useCallback((): boolean => {
    const newErrors: Record<string, string> = {};

    if (!name.trim()) newErrors['name'] = 'Task name is required';
    if (!cronExpr.trim()) newErrors['cron'] = 'Cron expression is required';
    if (!title.trim()) newErrors['title'] = 'Goal title is required';
    if (!cwd.trim()) newErrors['cwd'] = 'Working directory is required';

    // Validate cron expression
    if (cronExpr.trim()) {
      const nextTimes = parseNextFireTimes(cronExpr, 1);
      if (nextTimes === null) {
        newErrors['cron'] = 'Invalid cron expression';
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }, [name, cronExpr, title, cwd]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!validate()) return;

    const parsedTags = tags
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    const goalTemplate: GoalTemplate = {
      title: title.trim(),
      cwd: cwd.trim(),
      model: model !== 'default' ? model : undefined,
      initialPrompt: initialPrompt.trim() || undefined,
      tags: parsedTags.length > 0 ? parsedTags : undefined,
    };

    if (task) {
      onSave({
        id: task.id,
        name: name.trim(),
        cron_expr: cronExpr.trim(),
        goal_template_json: goalTemplate,
        enabled,
      });
    } else {
      onSave({
        name: name.trim(),
        cron_expr: cronExpr.trim(),
        goal_template_json: goalTemplate,
        enabled,
      });
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-lg rounded-lg border border-deck-border bg-deck-surface shadow-xl">
        <div className="flex items-center justify-between border-b border-deck-border px-4 py-3">
          <h2 className="text-lg font-semibold text-deck-text">
            {task ? 'Edit Scheduled Task' : 'New Scheduled Task'}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            className="rounded p-1 text-deck-muted hover:bg-deck-border hover:text-deck-text"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 p-4">
          {/* Task name */}
          <div>
            <label htmlFor="task-name" className="mb-1 block text-sm font-medium text-deck-text">
              Task Name
            </label>
            <input
              id="task-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Daily cleanup"
              className={`w-full rounded-md border bg-deck-bg px-3 py-2 text-sm text-deck-text placeholder-deck-muted focus:outline-none focus:ring-2 ${
                errors['name']
                  ? 'border-deck-danger focus:ring-deck-danger'
                  : 'border-deck-border focus:ring-deck-accent'
              }`}
            />
            {errors['name'] && (
              <p className="mt-1 text-xs text-deck-danger">{errors['name']}</p>
            )}
          </div>

          {/* Cron expression */}
          <div>
            <label className="mb-1 block text-sm font-medium text-deck-text">
              Schedule (Cron)
            </label>
            <CronPicker value={cronExpr} onChange={setCronExpr} error={errors['cron']} />
          </div>

          {/* Goal title */}
          <div>
            <label htmlFor="goal-title" className="mb-1 block text-sm font-medium text-deck-text">
              Goal Title
            </label>
            <input
              id="goal-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., Run nightly checks"
              className={`w-full rounded-md border bg-deck-bg px-3 py-2 text-sm text-deck-text placeholder-deck-muted focus:outline-none focus:ring-2 ${
                errors['title']
                  ? 'border-deck-danger focus:ring-deck-danger'
                  : 'border-deck-border focus:ring-deck-accent'
              }`}
            />
            {errors['title'] && (
              <p className="mt-1 text-xs text-deck-danger">{errors['title']}</p>
            )}
          </div>

          {/* Working directory */}
          <div>
            <label htmlFor="goal-cwd" className="mb-1 block text-sm font-medium text-deck-text">
              Working Directory
            </label>
            <input
              id="goal-cwd"
              type="text"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="/home/user/project"
              className={`w-full rounded-md border bg-deck-bg px-3 py-2 font-mono text-sm text-deck-text placeholder-deck-muted focus:outline-none focus:ring-2 ${
                errors['cwd']
                  ? 'border-deck-danger focus:ring-deck-danger'
                  : 'border-deck-border focus:ring-deck-accent'
              }`}
            />
            {errors['cwd'] && (
              <p className="mt-1 text-xs text-deck-danger">{errors['cwd']}</p>
            )}
          </div>

          {/* Model + Enabled row */}
          <div className="flex items-end gap-4">
            <div className="flex-1">
              <label htmlFor="goal-model" className="mb-1 block text-sm font-medium text-deck-text">
                Model
              </label>
              <select
                id="goal-model"
                value={model}
                onChange={(e) => setModel(e.target.value as GoalModel)}
                className="w-full rounded-md border border-deck-border bg-deck-bg px-3 py-2 text-sm text-deck-text focus:outline-none focus:ring-2 focus:ring-deck-accent"
              >
                {MODEL_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <label className="flex items-center gap-2 pb-2">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="h-4 w-4 rounded border-deck-border bg-deck-bg text-deck-accent focus:ring-deck-accent"
              />
              <span className="text-sm text-deck-text">Enabled</span>
            </label>
          </div>

          {/* Initial prompt */}
          <div>
            <label
              htmlFor="goal-prompt"
              className="mb-1 block text-sm font-medium text-deck-text"
            >
              Initial Prompt
            </label>
            <textarea
              id="goal-prompt"
              value={initialPrompt}
              onChange={(e) => setInitialPrompt(e.target.value)}
              placeholder="The prompt to send when the task fires..."
              rows={3}
              className="w-full rounded-md border border-deck-border bg-deck-bg px-3 py-2 text-sm text-deck-text placeholder-deck-muted focus:outline-none focus:ring-2 focus:ring-deck-accent"
            />
          </div>

          {/* Tags */}
          <div>
            <label htmlFor="goal-tags" className="mb-1 block text-sm font-medium text-deck-text">
              Tags (comma-separated)
            </label>
            <input
              id="goal-tags"
              type="text"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="scheduled, cleanup"
              className="w-full rounded-md border border-deck-border bg-deck-bg px-3 py-2 text-sm text-deck-text placeholder-deck-muted focus:outline-none focus:ring-2 focus:ring-deck-accent"
            />
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2 border-t border-deck-border pt-4">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-md border border-deck-border px-4 py-2 text-sm text-deck-muted hover:bg-deck-border hover:text-deck-text"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-md bg-deck-accent px-4 py-2 text-sm font-medium text-white hover:bg-deck-accent-hover"
            >
              {task ? 'Save Changes' : 'Create Task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
