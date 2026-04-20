import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, FileText, FolderOpen } from 'lucide-react';

interface ClaudeMdContent {
  path: string;
  content: string;
  lastModified: number | null;
}

export default function ClaudeMdPage() {
  const [claudeMdFiles, setClaudeMdFiles] = useState<ClaudeMdContent[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cwdInput, setCwdInput] = useState('');

  const fetchClaudeMd = useCallback(async (cwd?: string) => {
    setLoading(true);
    setError(null);
    try {
      const url = cwd
        ? `/api/directories?path=${encodeURIComponent(cwd)}&claudemd=true`
        : '/api/directories?claudemd=true';
      const res = await fetch(url);
      if (!res.ok) {
        if (res.status === 404) {
          setClaudeMdFiles([]);
          return;
        }
        throw new Error(`Failed to fetch: ${res.statusText}`);
      }
      const data: ClaudeMdContent[] = await res.json();
      setClaudeMdFiles(data);
      if (data.length > 0) {
        setSelectedPath((prev) => prev ?? data[0].path);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load CLAUDE.md files');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchClaudeMd();
  }, [fetchClaudeMd]);

  const selectedFile = claudeMdFiles.find((f) => f.path === selectedPath);

  const handleLoadDirectory = () => {
    if (cwdInput.trim()) {
      setSelectedPath(null);
      void fetchClaudeMd(cwdInput.trim());
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-deck-text">
            <FileText size={24} />
            CLAUDE.md
          </h1>
          <p className="mt-1 text-sm text-deck-muted">
            View CLAUDE.md project instructions and configuration files.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void fetchClaudeMd(cwdInput.trim() || undefined)}
          disabled={loading}
          className="rounded-md border border-deck-border p-2 text-deck-muted hover:bg-deck-border hover:text-deck-text disabled:opacity-50"
          aria-label="Refresh"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Directory input */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <FolderOpen size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-deck-muted" />
          <input
            type="text"
            value={cwdInput}
            onChange={(e) => setCwdInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleLoadDirectory()}
            placeholder="Enter a directory path to scan for CLAUDE.md..."
            className="w-full rounded-md border border-deck-border bg-deck-bg py-2 pl-10 pr-3 text-sm text-deck-text placeholder-deck-muted focus:outline-none focus:ring-2 focus:ring-deck-accent"
          />
        </div>
        <button
          type="button"
          onClick={handleLoadDirectory}
          className="rounded-md bg-deck-accent px-4 py-2 text-sm font-medium text-white hover:bg-deck-accent-hover"
        >
          Load
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-deck-danger/30 bg-deck-danger/10 px-4 py-3 text-sm text-deck-danger">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw size={20} className="animate-spin text-deck-muted" />
          <span className="ml-2 text-sm text-deck-muted">Scanning for CLAUDE.md files...</span>
        </div>
      ) : claudeMdFiles.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-deck-border py-12">
          <FileText size={24} className="text-deck-muted" />
          <p className="mt-2 text-sm text-deck-muted">
            No CLAUDE.md files found. Enter a project directory above to scan.
          </p>
        </div>
      ) : (
        <div className="flex gap-4">
          {/* File list sidebar */}
          {claudeMdFiles.length > 1 && (
            <div className="w-64 shrink-0 space-y-1 rounded-lg border border-deck-border bg-deck-surface p-2">
              {claudeMdFiles.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => setSelectedPath(file.path)}
                  className={`w-full rounded-md px-3 py-2 text-left text-xs transition-colors ${
                    selectedPath === file.path
                      ? 'bg-deck-accent/10 text-deck-accent'
                      : 'text-deck-muted hover:bg-deck-border hover:text-deck-text'
                  }`}
                >
                  <span className="block truncate font-mono">{file.path}</span>
                  {file.lastModified && (
                    <span className="block text-deck-muted">
                      {new Date(file.lastModified).toLocaleDateString()}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* Content viewer */}
          <div className="min-w-0 flex-1 rounded-lg border border-deck-border bg-deck-surface">
            {selectedFile ? (
              <div>
                <div className="border-b border-deck-border px-4 py-2">
                  <span className="font-mono text-xs text-deck-muted">{selectedFile.path}</span>
                </div>
                <pre className="overflow-auto whitespace-pre-wrap p-4 font-mono text-sm text-deck-text">
                  {selectedFile.content}
                </pre>
              </div>
            ) : (
              <div className="flex items-center justify-center py-12">
                <p className="text-sm text-deck-muted">Select a file to view its contents.</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
