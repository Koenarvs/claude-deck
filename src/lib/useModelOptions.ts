import { useConfigStore } from '../stores/useConfigStore';
import { modelOptionsFromCatalog } from '../shared/agents/catalog-client';
import type { ModelOption } from '../shared/agents/types';

/**
 * Claude-only fallback used before the catalog has loaded (matches the historical
 * hardcoded picker so behavior is unchanged on first paint / in tests that don't
 * seed the catalog).
 */
const FALLBACK_MODEL_OPTIONS: ModelOption[] = [
  { value: 'default', label: 'Default' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
];

/**
 * Model options for every goal picker: the union of ENABLED providers' models
 * from the catalog (centralized in the config store, fetched once at app boot),
 * with the 'default' sentinel first. Falls back to the Claude defaults until the
 * catalog loads. Enable Codex/Antigravity in Settings → Agents to surface their
 * models here.
 */
export function useModelOptions(): ModelOption[] {
  const catalog = useConfigStore((s) => s.catalog);
  return catalog.length > 0 ? modelOptionsFromCatalog(catalog) : FALLBACK_MODEL_OPTIONS;
}
