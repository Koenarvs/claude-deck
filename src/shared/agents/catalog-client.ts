import type { AgentCatalogEntry, ModelOption } from './types';

/**
 * Model options shown in pickers = the union of enabled providers' models,
 * with the 'default' sentinel present and first.
 */
export function modelOptionsFromCatalog(catalog: AgentCatalogEntry[]): ModelOption[] {
  const enabled = catalog.filter((p) => p.enabled);
  const opts = enabled.flatMap((p) => p.models);
  const withoutDefault = opts.filter((o) => o.value !== 'default');
  return [{ value: 'default', label: 'Default' }, ...withoutDefault];
}
