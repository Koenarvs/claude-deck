// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { createCodexModelsService } from '../../../server/services/codex-models-service';

vi.mock('../../../server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const cacheJson = JSON.stringify({
  fetched_at: '2026-05-12T05:44:58Z',
  models: [
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', supported_in_api: true },
    { slug: 'gpt-5.4', display_name: 'gpt-5.4', visibility: 'list', supported_in_api: true },
    { slug: 'gpt-5.2', display_name: 'gpt-5.2', visibility: 'list', supported_in_api: true },
    { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide' },
    { slug: 'no-display', visibility: 'list' },
  ],
});

describe('codexModelsService', () => {
  it('maps visible cache models to options (label falls back to slug), excluding hidden ones', async () => {
    const svc = createCodexModelsService({
      cachePath: '/fake/models_cache.json',
      readFile: () => cacheJson,
      statMtimeMs: () => 1,
    });
    const opts = await svc.getModelOptions();
    expect(opts).toEqual([
      { value: 'gpt-5.5', label: 'GPT-5.5' },
      { value: 'gpt-5.4', label: 'gpt-5.4' },
      { value: 'gpt-5.2', label: 'gpt-5.2' },
      { value: 'no-display', label: 'no-display' },
    ]);
    // codex-auto-review (visibility: hide) is excluded.
    expect(opts?.some((o) => o.value === 'codex-auto-review')).toBe(false);
  });

  it('re-reads only when the file mtime changes (caches otherwise)', async () => {
    const readFile = vi.fn(() => cacheJson);
    let mtime = 1;
    const svc = createCodexModelsService({
      cachePath: '/fake/models_cache.json',
      readFile,
      statMtimeMs: () => mtime,
    });
    await svc.getModelOptions();
    await svc.getModelOptions(); // same mtime → cached
    expect(readFile).toHaveBeenCalledTimes(1);
    mtime = 2; // CLI refreshed the cache
    await svc.getModelOptions();
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it('returns null (fallback) when the cache file is missing/unreadable', async () => {
    const svc = createCodexModelsService({
      cachePath: '/nope.json',
      readFile: () => { throw new Error('ENOENT'); },
      statMtimeMs: () => { throw new Error('ENOENT'); },
    });
    expect(await svc.getModelOptions()).toBeNull();
  });

  it('returns null when the cache has no usable models', async () => {
    const svc = createCodexModelsService({
      cachePath: '/fake.json',
      readFile: () => JSON.stringify({ models: [{ slug: 'x', visibility: 'hide' }] }),
      statMtimeMs: () => 1,
    });
    expect(await svc.getModelOptions()).toBeNull();
  });
});
