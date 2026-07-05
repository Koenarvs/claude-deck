import { useState, useEffect, useCallback } from 'react';
import { Shield, ShieldOff, AlertTriangle } from 'lucide-react';
import { apiGet, apiPost, ApiError } from '../../lib/api';

interface HookInstallerSectionProps {
  hooksInstalled: boolean;
  onStatusChange: () => void;
}

export default function HookInstallerSection({
  hooksInstalled,
  onStatusChange,
}: HookInstallerSectionProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [extensionStatus, setExtensionStatus] = useState<{
    hooks: Record<string, unknown>;
  } | null>(null);

  const fetchExtensions = useCallback(async () => {
    try {
      const data = await apiGet<{ hooks: Record<string, unknown> }>('/api/extensions');
      setExtensionStatus(data);
    } catch {
      // Non-critical, status indicator just won't show details
    }
  }, []);

  useEffect(() => {
    void fetchExtensions();
  }, [fetchExtensions, hooksInstalled]);

  const handleInstall = async () => {
    setLoading(true);
    setError(null);
    try {
      await apiPost('/api/system/install-hooks', undefined).catch((err: unknown) => {
        if (err instanceof ApiError) {
          const body = typeof err.body === 'string' ? err.body : JSON.stringify(err.body);
          throw new Error(body || `Install failed: ${err.statusText}`);
        }
        throw err;
      });
      setShowConfirm(false);
      onStatusChange();
      await fetchExtensions();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Install failed');
    } finally {
      setLoading(false);
    }
  };

  const handleUninstall = async () => {
    setLoading(true);
    setError(null);
    try {
      await apiPost('/api/system/uninstall-hooks', undefined).catch((err: unknown) => {
        if (err instanceof ApiError) {
          const body = typeof err.body === 'string' ? err.body : JSON.stringify(err.body);
          throw new Error(body || `Uninstall failed: ${err.statusText}`);
        }
        throw err;
      });
      setShowConfirm(false);
      onStatusChange();
      await fetchExtensions();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Uninstall failed');
    } finally {
      setLoading(false);
    }
  };

  const hookCount = extensionStatus?.hooks
    ? Object.keys(extensionStatus.hooks).length
    : 0;

  return (
    <div className="rounded-lg border border-deck-border bg-deck-surface p-4">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-deck-text">
            {hooksInstalled ? (
              <Shield size={16} className="text-deck-success" />
            ) : (
              <ShieldOff size={16} className="text-deck-muted" />
            )}
            Global Hooks
          </h3>
          <p className="mt-1 text-xs text-deck-muted">
            Hooks in <code className="text-deck-text">~/.claude/settings.json</code> enable
            observer mode, approval gate, and plan pane feed.
          </p>
          {hooksInstalled && hookCount > 0 && (
            <p className="mt-1 text-xs text-deck-success">
              {hookCount} hook type{hookCount !== 1 ? 's' : ''} installed
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
              hooksInstalled
                ? 'bg-deck-success/10 text-deck-success'
                : 'bg-deck-muted/10 text-deck-muted'
            }`}
          >
            {hooksInstalled ? 'Installed' : 'Not installed'}
          </span>
        </div>
      </div>

      {error && (
        <div className="mt-3 flex items-center gap-2 rounded-md border border-deck-danger/30 bg-deck-danger/10 px-3 py-2 text-xs text-deck-danger">
          <AlertTriangle size={14} />
          {error}
        </div>
      )}

      <div className="mt-4">
        {!showConfirm ? (
          <button
            type="button"
            onClick={() => setShowConfirm(true)}
            disabled={loading}
            className={`rounded-md px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${
              hooksInstalled
                ? 'bg-deck-danger hover:bg-deck-danger/80'
                : 'bg-deck-accent hover:bg-deck-accent-hover'
            }`}
          >
            {hooksInstalled ? 'Uninstall Hooks' : 'Install Global Hooks'}
          </button>
        ) : (
          <div className="rounded-md border border-deck-warning/30 bg-deck-warning/10 p-3">
            <p className="text-xs text-deck-warning">
              {hooksInstalled ? (
                <>
                  This will remove claude-deck hooks from{' '}
                  <code>~/.claude/settings.json</code>. External sessions will no longer
                  report to the dashboard.
                </>
              ) : (
                <>
                  This will add hooks to <code>~/.claude/settings.json</code>. All
                  claude sessions on this machine will report events to claude-deck. Your
                  existing hooks will be preserved.
                </>
              )}
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => void (hooksInstalled ? handleUninstall() : handleInstall())}
                disabled={loading}
                className={`rounded-md px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 ${
                  hooksInstalled
                    ? 'bg-deck-danger hover:bg-deck-danger/80'
                    : 'bg-deck-accent hover:bg-deck-accent-hover'
                }`}
              >
                {loading
                  ? 'Working...'
                  : hooksInstalled
                    ? 'Yes, Uninstall'
                    : 'Yes, Install'}
              </button>
              <button
                type="button"
                onClick={() => setShowConfirm(false)}
                disabled={loading}
                className="rounded-md border border-deck-border px-3 py-1.5 text-xs text-deck-muted hover:text-deck-text disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
