import { Play, Pencil, Trash2, Power, PowerOff } from 'lucide-react';
import type { ScheduledTask } from '../../shared/types';

interface ScheduledTasksListProps {
  tasks: ScheduledTask[];
  onEdit: (task: ScheduledTask) => void;
  onDelete: (taskId: string) => void;
  onToggleEnabled: (taskId: string, enabled: boolean) => void;
  onRunNow: (taskId: string) => void;
}

function formatTime(epoch: number | null): string {
  if (epoch === null) return '--';
  return new Date(epoch).toLocaleString();
}

export default function ScheduledTasksList({
  tasks,
  onEdit,
  onDelete,
  onToggleEnabled,
  onRunNow,
}: ScheduledTasksListProps) {
  if (tasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-deck-border py-12">
        <p className="text-sm text-deck-muted">No scheduled tasks yet.</p>
        <p className="mt-1 text-xs text-deck-muted">
          Create one to automate recurring goals.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-deck-border">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-deck-border bg-deck-surface">
            <th className="px-4 py-3 font-medium text-deck-muted">Name</th>
            <th className="px-4 py-3 font-medium text-deck-muted">Schedule</th>
            <th className="px-4 py-3 font-medium text-deck-muted">Next Run</th>
            <th className="px-4 py-3 font-medium text-deck-muted">Last Run</th>
            <th className="px-4 py-3 font-medium text-deck-muted">Status</th>
            <th className="px-4 py-3 text-right font-medium text-deck-muted">Actions</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr
              key={task.id}
              className="border-b border-deck-border last:border-b-0 hover:bg-deck-surface/50"
            >
              <td className="px-4 py-3">
                <span className="font-medium text-deck-text">{task.name}</span>
              </td>
              <td className="px-4 py-3">
                <code className="rounded bg-deck-bg px-1.5 py-0.5 font-mono text-xs text-deck-text">
                  {task.cron_expr}
                </code>
              </td>
              <td className="px-4 py-3 text-xs text-deck-muted">
                {task.enabled ? formatTime(task.next_run_at) : '--'}
              </td>
              <td className="px-4 py-3 text-xs text-deck-muted">
                {formatTime(task.last_run_at)}
              </td>
              <td className="px-4 py-3">
                <button
                  type="button"
                  onClick={() => onToggleEnabled(task.id, !task.enabled)}
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                    task.enabled
                      ? 'bg-deck-success/10 text-deck-success'
                      : 'bg-deck-muted/10 text-deck-muted'
                  }`}
                  title={task.enabled ? 'Click to disable' : 'Click to enable'}
                >
                  {task.enabled ? (
                    <>
                      <Power size={12} /> Enabled
                    </>
                  ) : (
                    <>
                      <PowerOff size={12} /> Disabled
                    </>
                  )}
                </button>
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center justify-end gap-1">
                  <button
                    type="button"
                    onClick={() => onRunNow(task.id)}
                    className="rounded p-1.5 text-deck-muted hover:bg-deck-border hover:text-deck-success"
                    title="Run now"
                    aria-label={`Run ${task.name} now`}
                  >
                    <Play size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => onEdit(task)}
                    className="rounded p-1.5 text-deck-muted hover:bg-deck-border hover:text-deck-text"
                    title="Edit"
                    aria-label={`Edit ${task.name}`}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(task.id)}
                    className="rounded p-1.5 text-deck-muted hover:bg-deck-border hover:text-deck-danger"
                    title="Delete"
                    aria-label={`Delete ${task.name}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
