import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ModelOption } from '../../src/shared/agents/types';
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

  let cache: ModelOption[] | null = null;
  let cachedMtime = Number.NaN;

  // Async to share one interface with the Claude (network) service, though the work is sync.
  async function getModelOptions(): Promise<ModelOption[] | null> {
    try {
      const mtime = statMtimeMs(cachePath);
      if (cache && mtime === cachedMtime) return cache;

      const parsed = JSON.parse(readFile(cachePath)) as CodexCache;
      const models = (parsed.models ?? [])
        .filter((m): m is CodexCacheModel & { slug: string } => typeof m.slug === 'string')
        // `visibility: 'list'` are user-selectable; 'hide' (e.g. codex-auto-review) are internal.
        .filter((m) => m.visibility !== 'hide')
        .map((m) => ({ value: m.slug, label: m.display_name || m.slug }));
      if (models.length === 0) return null;

      cache = models;
      cachedMtime = mtime;
      return models;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Codex models_cache.json unreadable; using fallback model list',
      );
      return null;
    }
  }

  /** The currently-cached model values (sync; [] when cold). Used by the model validator. */
  function cachedValues(): string[] {
    return cache ? cache.map((o) => o.value) : [];
  }

  return { getModelOptions, cachedValues };
}

export type CodexModelsService = ReturnType<typeof createCodexModelsService>;

/** Process-wide singleton used by the live server. */
export const codexModelsService = createCodexModelsService();
