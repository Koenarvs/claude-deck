import type { AgentCatalogEntry } from '../../shared/agents/types';

interface Props {
  providers: AgentCatalogEntry[];
  onToggle: (enabledIds: string[]) => void;
}

/**
 * Settings "Agents" section — one row per provider in the catalog. Claude Code
 * is always on (its toggle is disabled). Toggling another provider emits the new
 * enabled-id list. In the Foundation the catalog is Claude-only; other providers
 * appear when their adapter lands (Phase 3).
 */
export default function AgentsSection({ providers, onToggle }: Props) {
  const enabledIds = providers.filter((p) => p.enabled).map((p) => p.id);

  function toggle(id: string, next: boolean) {
    const set = new Set(enabledIds);
    if (next) set.add(id);
    else set.delete(id);
    set.add('claude'); // claude is always on
    onToggle([...set]);
  }

  if (providers.length === 0) return null;

  return (
    <div className="rounded-lg border border-deck-border bg-deck-surface p-4">
      <h3 className="text-sm font-semibold text-deck-text">Agents</h3>
      <p className="mt-1 text-xs text-deck-muted">
        Enable the LLM CLIs available when creating goals. Claude Code is always on.
      </p>
      <div className="mt-3 space-y-2">
        {providers.map((p) => {
          const isClaude = p.id === 'claude';
          return (
            <label key={p.id} className="flex items-center gap-3 text-sm text-deck-text">
              <input
                type="checkbox"
                aria-label={p.label}
                checked={p.enabled}
                disabled={isClaude}
                onChange={(e) => toggle(p.id, e.target.checked)}
              />
              <span className="font-medium">
                {p.label}
                {isClaude && <span className="ml-2 text-xs text-deck-muted">(default)</span>}
              </span>
              {p.enabled && p.authHint && (
                <span className="text-xs text-deck-muted">— {p.authHint}</span>
              )}
            </label>
          );
        })}
      </div>
    </div>
  );
}
