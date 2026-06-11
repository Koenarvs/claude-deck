import { useState, useEffect } from 'react';

interface DiffData {
  branch: string | null;
  dirty: boolean;
  diff: string;
}

function lineClass(line: string): string {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'text-deck-success';
  if (line.startsWith('-') && !line.startsWith('---')) return 'text-deck-danger';
  if (line.startsWith('@@')) return 'text-deck-accent';
  if (
    line.startsWith('diff ') ||
    line.startsWith('index ') ||
    line.startsWith('+++') ||
    line.startsWith('---')
  ) {
    return 'text-deck-muted';
  }
  return 'text-deck-text/80';
}

/**
 * Renders the git diff of a goal's isolated workspace (5B) vs its base ref, with
 * branch + dirty state. Empty state when the goal has no provisioned workspace
 * (its cwd isn't under a registered project).
 */
export default function WorkspaceDiff({ goalId }: { goalId: string }) {
  const [data, setData] = useState<DiffData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/goals/${goalId}/diff`)
      .then((r) => (r.ok ? (r.json() as Promise<DiffData>) : null))
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setData(null);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [goalId]);

  if (loading) {
    return <div className="p-4 text-xs text-deck-muted">Loading diff…</div>;
  }
  if (!data || !data.branch) {
    return (
      <div className="p-4 text-xs text-deck-muted">
        No isolated workspace for this goal. Register its project in Settings → Projects to run it
        on its own branch.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-deck-border px-3 py-2 text-xs">
        <span className="mono-tabular font-mono text-deck-accent">⎇ {data.branch}</span>
        <span className={data.dirty ? 'text-deck-warning' : 'text-deck-muted'}>
          {data.dirty ? '● uncommitted changes' : 'clean'}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {data.diff.trim() ? (
          <pre className="font-mono text-xs leading-relaxed">
            {data.diff.split('\n').map((line, i) => (
              <div key={i} className={lineClass(line)}>
                {line || ' '}
              </div>
            ))}
          </pre>
        ) : (
          <div className="text-xs text-deck-muted">No changes yet on this branch.</div>
        )}
      </div>
    </div>
  );
}
