import type { ModelOption } from '../../src/shared/agents/types';

/**
 * Shared cache / inflight-coalescing / fallback plumbing for the per-provider
 * live model-list services (claude / codex / antigravity). Each service supplies
 * a source-specific fetch plus a staleness strategy; the factory owns the cached
 * options, the single in-flight refresh, and the fallback semantics.
 */
export interface CachedModelSourceOpts {
  /**
   * Fetches fresh options. Resolve null (or reject) when the source is
   * unavailable — the caller then falls back per `onFailure`. A successful
   * (non-null) result replaces the cache and stamps `fetchedAt`.
   */
  fetch: () => Promise<ModelOption[] | null>;
  /**
   * Whether the current cache must be refreshed. Called only when a cache
   * exists; throwing is treated as stale (the underlying failure then surfaces
   * through fetch). Receives the timestamp of the last successful fetch.
   */
  isStale: (state: { fetchedAt: number }) => boolean;
  /**
   * 'await'      — getModelOptions waits for the refresh (claude: TTL;
   *                codex: file mtime).
   * 'background' — getModelOptions returns the current cache immediately and
   *                refreshes behind the scenes (antigravity: never awaits the
   *                PTY fetch; use warm() at boot to prime the cache).
   */
  refreshMode: 'await' | 'background';
  /**
   * What a failed refresh yields to callers: the prior (possibly stale) cache
   * when available ('stale-cache': claude/antigravity, default) or null
   * ('null': codex, whose cache is keyed to a file that just proved unreadable).
   * The cached list itself is left intact either way.
   */
  onFailure?: 'stale-cache' | 'null';
  /** Invoked when fetch (or isStale via fetch) rejects — e.g. to log a fallback warning. */
  onFallbackWarn?: (err: unknown) => void;
  /** Clock used to stamp successful fetches (injectable for tests). */
  now?: () => number;
}

export interface CachedModelSource {
  getModelOptions(): Promise<ModelOption[] | null>;
  /** Awaitable refresh (e.g. server-boot warm-up for background sources). */
  warm(): Promise<void>;
  /** The currently-cached model values (sync; [] when cold). Used by the model validator. */
  cachedValues(): string[];
}

export function createCachedModelSource(opts: CachedModelSourceOpts): CachedModelSource {
  const now = opts.now ?? Date.now;
  const failureResult = () => (opts.onFailure === 'null' ? null : cache);

  let cache: ModelOption[] | null = null;
  let fetchedAt = 0;
  let inflight: Promise<ModelOption[] | null> | null = null;

  function isFresh(): boolean {
    if (!cache) return false;
    try {
      return !opts.isStale({ fetchedAt });
    } catch {
      return false;
    }
  }

  /**
   * Refreshes the cache, sharing one in-flight fetch among concurrent callers.
   * A successful result is cached; a failure leaves any prior cache intact.
   */
  function refresh(): Promise<ModelOption[] | null> {
    if (inflight) return inflight;
    inflight = opts
      .fetch()
      .then((fetched) => {
        if (fetched) {
          cache = fetched;
          fetchedAt = now();
        }
        return fetched ?? failureResult();
      })
      .catch((err) => {
        opts.onFallbackWarn?.(err);
        return failureResult();
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  /**
   * Returns the cached options, refreshing when stale. In 'await' mode the
   * refresh is awaited; in 'background' mode the current cache (or null when
   * cold) is returned immediately while the refresh runs behind the scenes.
   */
  async function getModelOptions(): Promise<ModelOption[] | null> {
    if (isFresh()) return cache;
    if (opts.refreshMode === 'background') {
      void refresh();
      return cache;
    }
    return refresh();
  }

  async function warm(): Promise<void> {
    await refresh();
  }

  function cachedValues(): string[] {
    return cache ? cache.map((o) => o.value) : [];
  }

  return { getModelOptions, warm, cachedValues };
}
