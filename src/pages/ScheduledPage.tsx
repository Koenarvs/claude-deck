import { useState, useEffect, useCallback } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import ScheduledTasksList from '../components/scheduled/ScheduledTasksList';
import ScheduledTaskEditor from '../components/scheduled/ScheduledTaskEditor';
import type {
  ScheduledTask,
  CreateScheduledTaskInput,
  UpdateScheduledTaskInput,
} from '../shared/types';

export default function ScheduledPage() {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingTask, setEditingTask] = useState<ScheduledTask | null>(null);
  const [showEditor, setShowEditor] = useState(false);

  const fetchTasks = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch('/api/scheduled-tasks');
      if (!res.ok) throw new Error(`Failed to fetch tasks: ${res.statusText}`);
      const data: ScheduledTask[] = await res.json();
      setTasks(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load scheduled tasks');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchTasks();
  }, [fetchTasks]);

  const handleCreate = () => {
    setEditingTask(null);
    setShowEditor(true);
  };

  const handleEdit = (task: ScheduledTask) => {
    setEditingTask(task);
    setShowEditor(true);
  };

  const handleSave = async (
    input: CreateScheduledTaskInput | (UpdateScheduledTaskInput & { id: string }),
  ) => {
    try {
      if ('id' in input) {
        const { id, ...body } = input;
        const res = await fetch(`/api/scheduled-tasks/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`Failed to update task: ${res.statusText}`);
      } else {
        const res = await fetch('/api/scheduled-tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        if (!res.ok) throw new Error(`Failed to create task: ${res.statusText}`);
      }

      setShowEditor(false);
      setEditingTask(null);
      await fetchTasks();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    }
  };

  const handleDelete = async (taskId: string) => {
    if (!confirm('Delete this scheduled task?')) return;

    try {
      const res = await fetch(`/api/scheduled-tasks/${taskId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`Failed to delete task: ${res.statusText}`);
      await fetchTasks();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  const handleToggleEnabled = async (taskId: string, enabled: boolean) => {
    try {
      const res = await fetch(`/api/scheduled-tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error(`Failed to toggle task: ${res.statusText}`);
      await fetchTasks();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Toggle failed');
    }
  };

  const handleRunNow = async (taskId: string) => {
    try {
      const res = await fetch(`/api/scheduled-tasks/${taskId}/run-now`, { method: 'POST' });
      if (!res.ok) throw new Error(`Failed to run task: ${res.statusText}`);
      await res.json(); // Response contains { goal_id } — consumed on refresh
      await fetchTasks();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Run failed');
    }
  };

  const handleCancel = () => {
    setShowEditor(false);
    setEditingTask(null);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-deck-text">Scheduled Tasks</h1>
          <p className="mt-1 text-sm text-deck-muted">
            Automate recurring goals with cron-driven schedules.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void fetchTasks()}
            disabled={loading}
            className="rounded-md border border-deck-border p-2 text-deck-muted hover:bg-deck-border hover:text-deck-text disabled:opacity-50"
            aria-label="Refresh tasks"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            type="button"
            onClick={handleCreate}
            className="flex items-center gap-2 rounded-md bg-deck-accent px-4 py-2 text-sm font-medium text-white hover:bg-deck-accent-hover"
          >
            <Plus size={16} />
            New Task
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-deck-danger/30 bg-deck-danger/10 px-4 py-3 text-sm text-deck-danger">
          {error}
        </div>
      )}

      {loading && tasks.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw size={20} className="animate-spin text-deck-muted" />
          <span className="ml-2 text-sm text-deck-muted">Loading tasks...</span>
        </div>
      ) : (
        <ScheduledTasksList
          tasks={tasks}
          onEdit={handleEdit}
          onDelete={(id) => void handleDelete(id)}
          onToggleEnabled={(id, enabled) => void handleToggleEnabled(id, enabled)}
          onRunNow={(id) => void handleRunNow(id)}
        />
      )}

      {showEditor && (
        <ScheduledTaskEditor
          task={editingTask}
          onSave={(input) => void handleSave(input)}
          onCancel={handleCancel}
        />
      )}
    </div>
  );
}
