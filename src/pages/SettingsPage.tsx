import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Settings } from 'lucide-react';
import HookInstallerSection from '../components/settings/HookInstallerSection';
import DataDirSection from '../components/settings/DataDirSection';
import HomeRouteToggle from '../components/settings/HomeRouteToggle';
import AgentsSection from '../components/settings/AgentsSection';
import ProjectsSection from '../components/settings/ProjectsSection';
import OrchestratorSection from '../components/settings/OrchestratorSection';
import { useConfigStore } from '../stores/useConfigStore';
import { modelOptionsFromCatalog } from '../shared/agents/catalog-client';
import type { AgentCatalogEntry } from '../shared/agents/types';
import type { AppConfig, GoalModel, PermissionMode } from '../shared/types';

type ConfigResponse = AppConfig & { catalog?: AgentCatalogEntry[] };

const MODEL_OPTIONS: Array<{ value: GoalModel; label: string }> = [
  { value: 'default', label: 'Default' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
];

const PERMISSION_OPTIONS: Array<{ value: PermissionMode; label: string; description: string }> = [
  {
    value: 'supervised',
    label: 'Supervised',
    description: 'Tools require approval via the dashboard',
  },
  {
    value: 'autonomous',
    label: 'Autonomous',
    description: 'Tools are auto-approved',
  },
];

export default function SettingsPage() {
  const config = useConfigStore((s) => s.config);
  const setConfig = useConfigStore((s) => s.setConfig);
  // The catalog lives in the store (App.tsx boot-loads it). Sourcing it from the
  // store — rather than local state filled only by this page's own fetch — means
  // the Agents section and model dropdowns render even when `config` was already
  // cached (in which case the effect below skips fetchConfig). Previously the
  // local catalog stayed [] in that common case, hiding the Agents section.
  const catalog = useConfigStore((s) => s.catalog);
  const setCatalog = useConfigStore((s) => s.setCatalog);
  const [loading, setLoading] = useState(!config);
  const [error, setError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);

  const fetchConfig = useCallback(async () => {
    try {
      // Only show the full-page spinner on the initial load (no config yet). A
      // background catalog top-up (config cached, catalog empty) must not flash it.
      if (useConfigStore.getState().config === null) setLoading(true);
      setError(null);
      const res = await fetch('/api/config');
      if (!res.ok) throw new Error(`Failed to fetch config: ${res.statusText}`);
      const data: ConfigResponse = await res.json();
      setConfig(data);
      if (data.catalog) setCatalog(data.catalog);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load config');
    } finally {
      setLoading(false);
    }
  }, [setConfig]);

  useEffect(() => {
    // Fetch if config is missing OR the catalog hasn't been loaded yet — the
    // latter guards the case where config was boot-loaded but the catalog is
    // empty, which would otherwise hide the Agents section + provider models.
    if (!config || catalog.length === 0) {
      void fetchConfig();
    }
  }, [config, catalog.length, fetchConfig]);

  const updateConfig = async (updates: Partial<AppConfig>) => {
    try {
      setSaveStatus(null);
      const res = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error(`Failed to save: ${res.statusText}`);
      const data: ConfigResponse = await res.json();
      setConfig(data);
      if (data.catalog) setCatalog(data.catalog);
      setSaveStatus('Saved');
      setTimeout(() => setSaveStatus(null), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw size={20} className="animate-spin text-deck-muted" />
        <span className="ml-2 text-sm text-deck-muted">Loading settings...</span>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="rounded-md border border-deck-danger/30 bg-deck-danger/10 px-4 py-3 text-sm text-deck-danger">
        {error ?? 'Unable to load configuration.'}
      </div>
    );
  }

  const modelOptions = catalog.length > 0 ? modelOptionsFromCatalog(catalog) : MODEL_OPTIONS;
  const updateHeadroom = (updates: Partial<AppConfig['headroom']>) => {
    const nextHeadroom = { ...config.headroom, ...updates };
    setConfig({ ...config, headroom: nextHeadroom });
    void updateConfig({ headroom: nextHeadroom });
  };

  return (
    <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-deck-text">
            <Settings size={24} />
            Settings
          </h1>
          <p className="mt-1 text-sm text-deck-muted">
            Application configuration and hook management.
          </p>
        </div>
        {saveStatus && (
          <span className="rounded-full bg-deck-success/10 px-3 py-1 text-xs font-medium text-deck-success">
            {saveStatus}
          </span>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-deck-danger/30 bg-deck-danger/10 px-4 py-3 text-sm text-deck-danger">
          {error}
        </div>
      )}

      {/* Hook Installation */}
      <HookInstallerSection
        hooksInstalled={config.hooksInstalled}
        onStatusChange={() => void fetchConfig()}
      />

      {/* Home Route */}
      <HomeRouteToggle
        currentRoute={config.homeRoute}
        onRouteChange={(route) => {
          setConfig({ ...config, homeRoute: route });
        }}
      />

      {/* Data Directory */}
      <DataDirSection dataDir={config.dataDir} />

      {/* Defaults */}
      <div className="rounded-lg border border-deck-border bg-deck-surface p-4">
        <h3 className="text-sm font-semibold text-deck-text">Defaults</h3>
        <p className="mt-1 text-xs text-deck-muted">
          Default values applied when creating new goals.
        </p>

        <div className="mt-4 grid grid-cols-2 gap-4">
          {/* Default model */}
          <div>
            <label
              htmlFor="default-model"
              className="mb-1 block text-xs font-medium text-deck-muted"
            >
              Default Model
            </label>
            <select
              id="default-model"
              value={config.defaultModel}
              onChange={(e) => void updateConfig({ defaultModel: e.target.value as GoalModel })}
              className="w-full rounded-md border border-deck-border bg-deck-bg px-3 py-2 text-sm text-deck-text focus:outline-none focus:ring-2 focus:ring-deck-accent"
            >
              {modelOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Default permission mode */}
          <div>
            <label className="mb-1 block text-xs font-medium text-deck-muted">
              Default Permission Mode
            </label>
            <div className="flex gap-2">
              {PERMISSION_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => void updateConfig({ defaultPermissionMode: opt.value })}
                  className={`flex-1 rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                    config.defaultPermissionMode === opt.value
                      ? 'border-deck-accent bg-deck-accent/10 text-deck-text'
                      : 'border-deck-border text-deck-muted hover:text-deck-text'
                  }`}
                  aria-pressed={config.defaultPermissionMode === opt.value}
                >
                  <span className="block font-medium">{opt.label}</span>
                  <span className="block text-xs text-deck-muted">{opt.description}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Agents */}
      <AgentsSection
        providers={catalog}
        onToggle={(ids) =>
          void updateConfig({
            providers: catalog.map((c) => {
              const existing = config.providers.find((p) => p.id === c.id);
              return {
                id: c.id,
                enabled: ids.includes(c.id),
                billingMode: existing?.billingMode ?? 'seat',
                ...(existing?.seatPriceUsdMonthly !== undefined
                  ? { seatPriceUsdMonthly: existing.seatPriceUsdMonthly }
                  : {}),
                ...(existing?.budget !== undefined ? { budget: existing.budget } : {}),
              };
            }),
          })
        }
      />

      {/* Projects */}
      <ProjectsSection />

      {/* Orchestrator persona + governance */}
      <OrchestratorSection modelOptions={modelOptions} />

      {/* Headroom Compression */}
      <div className="rounded-lg border border-deck-border bg-deck-surface p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-deck-text">Headroom Compression</h3>
            <p className="mt-1 text-xs text-deck-muted">
              Route context compression through a Headroom service before it reaches the agent.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={config.headroom.enabled}
            onClick={() =>
              void updateConfig({
                headroom: { ...config.headroom, enabled: !config.headroom.enabled },
              })
            }
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
              config.headroom.enabled ? 'bg-deck-accent' : 'bg-deck-border'
            }`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                config.headroom.enabled ? 'translate-x-5' : 'translate-x-1'
              }`}
            />
            <span className="sr-only">Enable headroom compression</span>
          </button>
        </div>

        <div className="mt-4">
          <label htmlFor="headroom-base-url" className="mb-1 block text-xs font-medium text-deck-muted">
            Headroom Base URL
          </label>
          <input
            id="headroom-base-url"
            type="url"
            value={config.headroom.baseUrl}
            onChange={(e) =>
              setConfig({
                ...config,
                headroom: { ...config.headroom, baseUrl: e.target.value },
              })
            }
            onBlur={(e) => {
              const baseUrl = e.target.value.trim();
              if (!baseUrl) return;
              updateHeadroom({ baseUrl });
            }}
            placeholder="http://localhost:8787"
            className="w-full rounded-md border border-deck-border bg-deck-bg px-3 py-2 text-sm text-deck-text focus:outline-none focus:ring-2 focus:ring-deck-accent"
          />
        </div>

        <div className="mt-4 flex items-center justify-between gap-4 rounded-md border border-deck-border/70 bg-deck-bg/40 px-3 py-3">
          <div>
            <p className="text-sm font-medium text-deck-text">Auto-start managed proxy</p>
            <p className="mt-1 text-xs text-deck-muted">
              Launch a local Headroom process on Claude Deck startup and restart it when settings change.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={config.headroom.launchOnStartup}
            onClick={() => updateHeadroom({ launchOnStartup: !config.headroom.launchOnStartup })}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
              config.headroom.launchOnStartup ? 'bg-deck-accent' : 'bg-deck-border'
            }`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                config.headroom.launchOnStartup ? 'translate-x-5' : 'translate-x-1'
              }`}
            />
            <span className="sr-only">Auto-start managed Headroom proxy</span>
          </button>
        </div>

        <div className="mt-4">
          <label htmlFor="headroom-command" className="mb-1 block text-xs font-medium text-deck-muted">
            Launch Command
          </label>
          <input
            id="headroom-command"
            type="text"
            value={config.headroom.command}
            onChange={(e) =>
              setConfig({
                ...config,
                headroom: { ...config.headroom, command: e.target.value },
              })
            }
            onBlur={(e) => {
              const command = e.target.value.trim();
              if (!command) return;
              updateHeadroom({ command });
            }}
            placeholder="headroom proxy --port 8787"
            className="w-full rounded-md border border-deck-border bg-deck-bg px-3 py-2 text-sm text-deck-text focus:outline-none focus:ring-2 focus:ring-deck-accent"
          />
        </div>
      </div>

      {/* Trace Retention */}
      <div className="rounded-lg border border-deck-border bg-deck-surface p-4">
        <h3 className="text-sm font-semibold text-deck-text">Trace Retention</h3>
        <p className="mt-1 text-xs text-deck-muted">
          Traces older than this threshold are pruned automatically.
        </p>

        <div className="mt-3 flex items-center gap-2">
          <input
            type="number"
            min={1}
            max={365}
            value={config.tracePruneDays}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10);
              if (!isNaN(val) && val >= 1) {
                void updateConfig({ tracePruneDays: val });
              }
            }}
            className="w-24 rounded-md border border-deck-border bg-deck-bg px-3 py-2 text-sm text-deck-text focus:outline-none focus:ring-2 focus:ring-deck-accent"
          />
          <span className="text-sm text-deck-muted">days</span>
        </div>
      </div>
    </div>
  );
}
