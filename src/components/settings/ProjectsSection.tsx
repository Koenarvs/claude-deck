import { useState, useEffect, useCallback } from 'react';
import type { Project } from '../../shared/types';

/**
 * Settings "Projects" section — manage the project registry (5A). Registered
 * roots double as the cwd allow-list and the markdown-editor document roots, and
 * supply per-project defaults inherited at goal creation.
 */
export default function ProjectsSection() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState('');
  const [rootPath, setRootPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/projects');
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data)) setProjects(data as Project[]);
    } catch {
      /* leave list as-is */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = useCallback(async () => {
    if (!name.trim() || !rootPath.trim()) {
      setError('Name and root path are required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), root_path: rootPath.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Failed (${res.status})`);
        return;
      }
      setName('');
      setRootPath('');
      await load();
    } finally {
      setBusy(false);
    }
  }, [name, rootPath, load]);

  const remove = useCallback(
    async (id: string) => {
      await fetch(`/api/projects/${id}`, { method: 'DELETE' }).catch(() => {});
      await load();
    },
    [load],
  );

  return (
    <div className="rounded-lg border border-deck-border bg-deck-surface p-4">
      <h3 className="text-sm font-semibold text-deck-text">Projects</h3>
      <p className="mt-1 text-xs text-deck-muted">
        Registered repos define the cwd allow-list, editable document roots, and per-project goal
        defaults.
      </p>

      <div className="mt-3 space-y-2">
        {projects.length === 0 ? (
          <p className="text-xs text-deck-muted">No projects registered yet.</p>
        ) : (
          projects.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between gap-3 rounded border border-deck-border px-3 py-2"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-deck-text">{p.name}</div>
                <div className="truncate font-mono text-xs text-deck-muted">{p.root_path}</div>
              </div>
              <button
                type="button"
                onClick={() => void remove(p.id)}
                className="shrink-0 rounded px-2 py-1 text-xs text-deck-muted transition-colors hover:bg-deck-border hover:text-deck-danger"
                aria-label={`Remove ${p.name}`}
              >
                Remove
              </button>
            </div>
          ))
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          aria-label="Project name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
          className="w-32 rounded border border-deck-border bg-deck-bg px-2 py-1 text-sm text-deck-text focus:border-deck-accent focus:outline-none"
        />
        <input
          aria-label="Project root path"
          value={rootPath}
          onChange={(e) => setRootPath(e.target.value)}
          placeholder="/abs/path/to/repo"
          className="min-w-[14rem] flex-1 rounded border border-deck-border bg-deck-bg px-2 py-1 font-mono text-sm text-deck-text focus:border-deck-accent focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void add()}
          disabled={busy}
          className="rounded bg-deck-accent px-3 py-1 text-sm font-medium text-white transition-colors hover:bg-deck-accent-hover disabled:opacity-50"
        >
          Add
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-deck-danger">
          {error}
        </p>
      )}
    </div>
  );
}
