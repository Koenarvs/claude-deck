import { FolderOpen } from 'lucide-react';

interface DataDirSectionProps {
  dataDir: string;
}

export default function DataDirSection({ dataDir }: DataDirSectionProps) {
  return (
    <div className="rounded-lg border border-deck-border bg-deck-surface p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-deck-text">
        <FolderOpen size={16} className="text-deck-accent" />
        Data Directory
      </h3>
      <p className="mt-1 text-xs text-deck-muted">
        SQLite database, traces, and config are stored here.
      </p>

      <div className="mt-3 flex items-center gap-2 rounded-md border border-deck-border bg-deck-bg px-3 py-2">
        <code className="flex-1 truncate font-mono text-sm text-deck-text">{dataDir}</code>
      </div>

      <div className="mt-2 text-xs text-deck-muted">
        <p>
          Contains: <code>claude-deck.db</code>, <code>config.json</code>,{' '}
          <code>traces/</code>
        </p>
      </div>
    </div>
  );
}
