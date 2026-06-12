import { useEffect, useState, useCallback } from 'react';
import type { OrchestratorConfig, OrchestratorStateRecord } from '../../shared/orchestrator';
import type { ModelOption } from '../../shared/agents/types';

interface Props {
  /** From the Phase 1 provider catalog (modelOptionsFromCatalog). Cost-effective tier first. */
  modelOptions: ModelOption[];
}

/**
 * Settings section for the orchestrator persona + governance. Reads/writes the Core's
 * OrchestratorConfig (GET /api/orchestrator, PUT /api/orchestrator/config). Model choices
 * come from the catalog (provider-pluggable brain; default a cost-effective tier).
 */
export default function OrchestratorSection({ modelOptions }: Props) {
  const [config, setConfig] = useState<OrchestratorConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/orchestrator');
        if (!res.ok) throw new Error(res.statusText);
        const data = (await res.json()) as { state: OrchestratorStateRecord };
        setConfig(data.state.config);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load orchestrator config');
      }
    })();
  }, []);

  const save = useCallback(async (patch: Partial<OrchestratorConfig>) => {
    try {
      const res = await fetch('/api/orchestrator/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(res.statusText);
      const next = (await res.json()) as OrchestratorConfig;
      setConfig(next);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    }
  }, []);

  if (!config) {
    return (
      <div className="rounded-lg border border-deck-border bg-deck-surface p-4 text-sm text-deck-muted">
        {error ?? 'Loading orchestrator…'}
      </div>
    );
  }

  // Local draft so text inputs commit on blur (avoids a PUT per keystroke).
  const update = <K extends keyof OrchestratorConfig>(key: K, value: OrchestratorConfig[K]) =>
    setConfig({ ...config, [key]: value });

  const options = modelOptions.length ? modelOptions : [{ value: config.model, label: config.model }];

  return (
    <div className="rounded-lg border border-deck-border bg-deck-surface p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-deck-text">Orchestrator</h3>
        {saved && <span className="text-xs text-deck-success">Saved</span>}
      </div>
      <p className="mt-1 text-xs text-deck-muted">
        Your always-on assistant. It wakes on triggers, reasons via a cost-effective model, and is reachable in the Orchestrator tab and on Discord.
      </p>

      <div className="mt-4 space-y-4">
        {/* Enabled */}
        <label className="flex items-center gap-3 text-sm text-deck-text">
          <input
            type="checkbox" checked={config.enabled}
            onChange={(e) => void save({ enabled: e.target.checked })}
          />
          <span>Enabled</span>
        </label>

        <div className="grid grid-cols-2 gap-4">
          {/* Persona name */}
          <div>
            <label htmlFor="persona-name" className="mb-1 block text-xs font-medium text-deck-muted">Persona name</label>
            <input
              id="persona-name" type="text" value={config.persona_name}
              onChange={(e) => update('persona_name', e.target.value)}
              onBlur={(e) => void save({ persona_name: e.target.value.trim() || 'Hawat' })}
              className="w-full rounded-md border border-deck-border bg-deck-bg px-3 py-2 text-sm text-deck-text focus:border-deck-accent focus:outline-none"
            />
          </div>

          {/* Model (catalog-driven) */}
          <div>
            <label htmlFor="orch-model" className="mb-1 block text-xs font-medium text-deck-muted">Brain model</label>
            <select
              id="orch-model" value={config.model}
              onChange={(e) => void save({ model: e.target.value })}
              className="w-full rounded-md border border-deck-border bg-deck-bg px-3 py-2 text-sm text-deck-text focus:border-deck-accent focus:outline-none"
            >
              {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>

          {/* Idle timeout (minutes) */}
          <div>
            <label htmlFor="idle-timeout" className="mb-1 block text-xs font-medium text-deck-muted">Idle timeout (minutes)</label>
            <input
              id="idle-timeout" type="number" min={1} max={120}
              defaultValue={Math.round(config.idle_timeout_ms / 60000)}
              onBlur={(e) => {
                const min = Math.max(1, parseInt(e.target.value, 10) || 10);
                void save({ idle_timeout_ms: min * 60000 });
              }}
              className="w-full rounded-md border border-deck-border bg-deck-bg px-3 py-2 text-sm text-deck-text focus:border-deck-accent focus:outline-none"
            />
          </div>

          {/* Discord owner id */}
          <div>
            <label htmlFor="discord-owner" className="mb-1 block text-xs font-medium text-deck-muted">Paired Discord user id</label>
            <input
              id="discord-owner" type="text" defaultValue={config.discord_owner_id ?? ''}
              placeholder="unpaired"
              onBlur={(e) => void save({ discord_owner_id: e.target.value.trim() || null })}
              className="w-full rounded-md border border-deck-border bg-deck-bg px-3 py-2 text-sm text-deck-text focus:border-deck-accent focus:outline-none"
            />
          </div>

          {/* Governance caps */}
          <div>
            <label htmlFor="max-children" className="mb-1 block text-xs font-medium text-deck-muted">Max concurrent children</label>
            <input
              id="max-children" type="number" min={0} max={20}
              defaultValue={config.max_concurrent_children}
              onBlur={(e) => void save({ max_concurrent_children: Math.max(0, parseInt(e.target.value, 10) || 0) })}
              className="w-full rounded-md border border-deck-border bg-deck-bg px-3 py-2 text-sm text-deck-text focus:border-deck-accent focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="max-depth" className="mb-1 block text-xs font-medium text-deck-muted">Max orchestration depth</label>
            <input
              id="max-depth" type="number" min={0} max={10}
              defaultValue={config.max_depth}
              onBlur={(e) => void save({ max_depth: Math.max(0, parseInt(e.target.value, 10) || 0) })}
              className="w-full rounded-md border border-deck-border bg-deck-bg px-3 py-2 text-sm text-deck-text focus:border-deck-accent focus:outline-none"
            />
          </div>
        </div>
      </div>

      {error && <div className="mt-3 text-xs text-deck-danger">{error}</div>}
    </div>
  );
}
