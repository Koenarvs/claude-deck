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
import type { AppConfig, AuthMode, GoalModel, PermissionMode, CompressionDegree } from '../shared/types';

type ConfigResponse = AppConfig & { catalog?: AgentCatalogEntry[] };

const DEGREE_OPTIONS: Array<{ value: CompressionDegree; label: string; description: string }> = [
  { value: 'off', label: 'Off', description: 'No optimization (passthrough)' },
  { value: 'light', label: 'Light', description: 'Gentle (ratio 0.6)' },
  { value: 'balanced', label: 'Balanced', description: 'Recommended (ratio 0.4)' },
  { value: 'aggressive', label: 'Aggressive', description: 'Most compression (ratio 0.3)' },
];

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

const AUTH_MODE_OPTIONS: Array<{ value: AuthMode; label: string; description: string }> = [
  {
    value: 'auto',
    label: 'Auto-detect',
    description: 'Vertex when CLAUDE_CODE_USE_VERTEX is set (env or ~/.claude settings), else OAuth',
  },
  {
    value: 'vertex',
    label: 'Vertex AI',
    description: 'Force Google Cloud Vertex (needs project/region configured for the CLI)',
  },
  {
    value: 'oauth',
    label: 'OAuth',
    description: 'Force claude.ai subscription login, ignoring ambient Vertex env',
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

  const headroom = config.headroom;
  const updateHeadroom = (updates: Partial<AppConfig['headroom']>) => {
    const next = { ...headroom, ...updates };
    setConfig({ ...config, headroom: next });
    void updateConfig({ headroom: next });
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

      {/* Claude Authentication */}
      <div className="rounded-lg border border-deck-border bg-deck-surface p-4">
        <h3 className="text-sm font-semibold text-deck-text">Claude Authentication</h3>
        <p className="mt-1 text-xs text-deck-muted">
          How spawned Claude sessions authenticate on this machine. Auto detects from
          CLAUDE_CODE_USE_VERTEX (deck env, then ~/.claude settings); an explicit choice
          overrides whatever the launch shell carried. Stored per machine.
        </p>
        <div className="mt-4 flex gap-2">
          {AUTH_MODE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => void updateConfig({ authMode: opt.value })}
              className={`flex-1 rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                config.authMode === opt.value
                  ? 'border-deck-accent bg-deck-accent/10 text-deck-text'
                  : 'border-deck-border text-deck-muted hover:text-deck-text'
              }`}
              aria-pressed={config.authMode === opt.value}
            >
              <span className="block font-medium">{opt.label}</span>
              <span className="block text-xs text-deck-muted">{opt.description}</span>
            </button>
          ))}
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
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-deck-text">Headroom Compression</h3>
            <p className="mt-1 text-xs text-deck-muted">
              Routes Claude sessions through a local proxy that compresses request context. Opt-in;
              on Vertex the proxy is auto-started and sessions fall back to direct if it isn&apos;t running.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={headroom.enabled}
            aria-label="Enable headroom compression"
            onClick={() => updateHeadroom({ enabled: !headroom.enabled })}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
              headroom.enabled ? 'bg-deck-accent' : 'bg-deck-border'
            }`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                headroom.enabled ? 'translate-x-5' : 'translate-x-1'
              }`}
            />
          </button>
        </div>

        {headroom.enabled && (
          <div className="mt-4 space-y-4">
            {/* Compression degree */}
            <div>
              <label className="mb-1 block text-xs font-medium text-deck-muted">Compression Degree</label>
              <div className="grid grid-cols-4 gap-2">
                {DEGREE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => updateHeadroom({ compressionDegree: opt.value })}
                    className={`rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                      headroom.compressionDegree === opt.value
                        ? 'border-deck-accent bg-deck-accent/10 text-deck-text'
                        : 'border-deck-border text-deck-muted hover:text-deck-text'
                    }`}
                    aria-pressed={headroom.compressionDegree === opt.value}
                  >
                    <span className="block font-medium">{opt.label}</span>
                    <span className="block text-xs text-deck-muted">{opt.description}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Feature toggles */}
            <div className="space-y-3 rounded-md border border-deck-border p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="block text-sm text-deck-text">Intercept tool results</span>
                  <span className="block text-xs text-deck-muted">
                    Compresses large tool outputs before the model sees them. In our Vertex testing this
                    showed little measurable benefit — included to experiment.
                  </span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={headroom.interceptToolResults}
                  aria-label="Intercept tool results"
                  onClick={() => updateHeadroom({ interceptToolResults: !headroom.interceptToolResults })}
                  className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                    headroom.interceptToolResults ? 'bg-deck-accent' : 'bg-deck-border'
                  }`}
                >
                  <span
                    className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                      headroom.interceptToolResults ? 'translate-x-5' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="block text-sm text-deck-text">Memory</span>
                  <span className="block text-xs text-deck-muted">
                    Lets the proxy reuse cross-request context. Minimal measured benefit on this stack;
                    included to experiment.
                  </span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={headroom.memory}
                  aria-label="Headroom memory"
                  onClick={() => updateHeadroom({ memory: !headroom.memory })}
                  className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                    headroom.memory ? 'bg-deck-accent' : 'bg-deck-border'
                  }`}
                >
                  <span
                    className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                      headroom.memory ? 'translate-x-5' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
            </div>

            {/* Auto-start toggle */}
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <span className="block text-sm text-deck-text">Auto-start managed proxy</span>
                <span className="block text-xs text-deck-muted">
                  Claude Deck launches and supervises the <code>headroom proxy</code> process. Turn off to
                  point at an externally-managed proxy.
                </span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={headroom.launchOnStartup}
                aria-label="Auto-start managed proxy"
                onClick={() => updateHeadroom({ launchOnStartup: !headroom.launchOnStartup })}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                  headroom.launchOnStartup ? 'bg-deck-accent' : 'bg-deck-border'
                }`}
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                    headroom.launchOnStartup ? 'translate-x-5' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>

            {/* Vertex API URL */}
            <div>
              <label htmlFor="headroom-vertex-url" className="mb-1 block text-xs font-medium text-deck-muted">
                Vertex API URL
              </label>
              <input
                id="headroom-vertex-url"
                type="url"
                defaultValue={headroom.vertexApiUrl ?? ''}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  const next = v.length > 0 ? v : undefined;
                  if (next !== headroom.vertexApiUrl) updateHeadroom({ vertexApiUrl: next });
                }}
                placeholder="Auto-detect from CLOUD_ML_REGION"
                className="w-full rounded-md border border-deck-border bg-deck-bg px-3 py-2 text-sm text-deck-text focus:outline-none focus:ring-2 focus:ring-deck-accent"
              />
              <p className="mt-1 text-xs text-deck-muted">
                Optional override for the Vertex AI endpoint the proxy forwards to. Leave blank to
                auto-detect from CLOUD_ML_REGION (self-corrects when the region changes).
              </p>
            </div>

            {/* Advanced: override command */}
            <details className="rounded-md border border-deck-border p-3">
              <summary className="cursor-pointer text-xs font-medium text-deck-muted">
                Advanced: override launch command
              </summary>
              <input
                type="text"
                defaultValue={headroom.command ?? ''}
                onBlur={(e) => {
                  // Empty string is normalized back to "auto-build" server-side.
                  updateHeadroom({ command: e.target.value.trim() });
                }}
                placeholder="Leave blank to auto-build from the options above"
                className="mt-2 w-full rounded-md border border-deck-border bg-deck-bg px-3 py-2 text-sm text-deck-text focus:outline-none focus:ring-2 focus:ring-deck-accent"
              />
              <p className="mt-1 text-xs text-deck-muted">
                Overrides all options above. Leave blank to auto-build the command.
              </p>
            </details>
          </div>
        )}
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
