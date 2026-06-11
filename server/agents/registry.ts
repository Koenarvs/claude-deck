// server/agents/registry.ts
//
// The single place that knows which adapters exist and maps a model value back
// to its adapter. The production default registry is Claude-only for the
// Foundation; Antigravity/Codex are added in Phase 3.

import type { AgentAdapter } from './agent-adapter';
import type { AgentCatalogEntry, ModelOption } from '../../src/shared/agents/types';
import { ClaudeAdapter } from './claude-adapter';
import { CodexAdapter } from './codex-adapter';
import { AntigravityAdapter } from './antigravity-adapter';
import logger from '../logger';

export function makeRegistry(adapters: AgentAdapter[]) {
  const byId = new Map(adapters.map((a) => [a.id, a]));
  const claude = byId.get('claude');
  if (!claude) throw new Error('registry requires a "claude" adapter');

  function allAdapters(): AgentAdapter[] {
    return [...adapters];
  }
  function getAdapter(id: string): AgentAdapter | undefined {
    return byId.get(id);
  }

  /** Resolve a model value to its (enabled) adapter; fall back to claude. */
  function adapterForModel(model: string, enabled: string[]): AgentAdapter {
    for (const a of adapters) {
      if (!enabled.includes(a.id)) continue;
      if (a.models.some((m) => m.value === model)) return a;
    }
    if (model && model !== 'default') {
      logger.warn({ model, enabled }, 'No enabled adapter owns model; falling back to claude');
    }
    return claude!;
  }

  /** The union of enabled adapters' model options — drives every picker. */
  function enabledModelOptions(enabled: string[]): ModelOption[] {
    const opts: ModelOption[] = [];
    for (const a of adapters) if (enabled.includes(a.id)) opts.push(...a.models);
    return opts;
  }

  /** Client-facing catalog: identity, models, enabled flag, capability matrix. */
  function buildCatalog(enabled: string[]): AgentCatalogEntry[] {
    return adapters.map((a) => ({
      id: a.id,
      label: a.label,
      enabled: enabled.includes(a.id),
      models: a.models,
      capabilities: a.capabilities,
      ...(a.authHint ? { authHint: a.authHint } : {}),
    }));
  }

  return { allAdapters, getAdapter, adapterForModel, enabledModelOptions, buildCatalog };
}

export type Registry = ReturnType<typeof makeRegistry>;

// Default production registry. Claude is always enabled; Codex and Antigravity
// are registered so their models surface in the catalog (toggle-on in Settings →
// Agents). adapterForModel selects them only when the provider is enabled.
const defaultRegistry = makeRegistry([
  new ClaudeAdapter(),
  new CodexAdapter(),
  new AntigravityAdapter(),
]);
export const allAdapters = defaultRegistry.allAdapters;
export const getAdapter = defaultRegistry.getAdapter;
export const adapterForModel = defaultRegistry.adapterForModel;
export const enabledModelOptions = defaultRegistry.enabledModelOptions;
export const buildCatalog = defaultRegistry.buildCatalog;
