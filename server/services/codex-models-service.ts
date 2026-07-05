import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createCachedModelSource } from './cached-model-source';
import logger from '../logger';

/**
 * Reads the live Codex model list from the cache the Codex CLI maintains at
 * ~/.codex/models_cache.json (it refreshes the file from OpenAI with an etag). This
 * keeps the goal picker's Codex options current — including models the static
 * registry predates — and honors each model's `visibility` (hidden ones like
 * `codex-auto-review` are excluded). Returns null when the file is absent/unreadable,
 * so callers fall back to the static registry-derived list.
 *
 * The read is a local file + JSON parse (fast); results are cached and only re-parsed
 * when the file's mtime changes, so the CLI's next refresh is picked up automatically.
 */

interface CodexCacheModel {
  slug?: string;
  display_name?: string;
  visibility?: string;
  supported_in_api?: boolean;
}
interface CodexCache {
  models?: CodexCacheModel[];
}

export interface CodexModelsDeps {
  cachePath?: string;
  readFile?: (p: string) => string;
  statMtimeMs?: (p: string) => number;
}

export function createCodexModelsService(deps: CodexModelsDeps = {}) {
  const cachePath = deps.cachePath ?? path.join(os.homedir(), '.codex', 'models_cache.json');
  const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const statMtimeMs = deps.statMtimeMs ?? ((p: string) => fs.statSync(p).mtimeMs);

  let cachedMtime = Number.NaN;

  // The work is sync (local file + JSON parse) but the fetch is async to share one
  // interface with the Claude (network) service. Staleness is keyed to the file's
  // mtime, so the CLI's next refresh is picked up automatically; a read/parse
  // failure yields null (not the prior cache — the file just proved unreadable).
  const source = createCachedModelSource({
    fetch: async () => {
      const mtime = statMtimeMs(cachePath);
      const parsed = JSON.parse(readFile(cachePath)) as CodexCache;
      const models = (parsed.models ?? [])
        .filter((m): m is CodexCacheModel & { slug: string } => typeof m.slug === 'string')
        // `visibility: 'list'` are user-selectable; 'hide' (e.g. codex-auto-review) are internal.
        .filter((m) => m.visibility !== 'hide')
        .map((m) => ({ value: m.slug, label: m.display_name || m.slug }));
      if (models.length === 0) return null;

      cachedMtime = mtime;
      return models;
    },
    isStale: () => statMtimeMs(cachePath) !== cachedMtime,
    refreshMode: 'await',
    onFailure: 'null',
    onFallbackWarn: (err) =>
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Codex models_cache.json unreadable; using fallback model list',
      ),
  });

  return { getModelOptions: source.getModelOptions, cachedValues: source.cachedValues };
}

export type CodexModelsService = ReturnType<typeof createCodexModelsService>;

/** Process-wide singleton used by the live server. */
export const codexModelsService = createCodexModelsService();
