// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { createClaudeModelsService } from '../../../server/services/claude-models-service';

vi.mock('../../../server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const apiBody = {
  data: [
    { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', max_input_tokens: 1000000 },
    { id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7', max_input_tokens: 1000000 },
    { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', max_input_tokens: 1000000 },
  ],
};

function okFetch(body: unknown) {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => body }) as unknown as Response);
}

describe('claudeModelsService', () => {
  it('maps the API list to options with the default sentinel first + (1M) variants', async () => {
    const svc = createClaudeModelsService({ readToken: () => 'tok', fetchImpl: okFetch(apiBody) });
    const opts = await svc.getModelOptions();
    expect(opts).toEqual([
      { value: 'default', label: 'Default' },
      { value: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
      { value: 'claude-opus-4-8[1m]', label: 'Claude Opus 4.8 (1M)' },
      { value: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
      { value: 'claude-opus-4-7[1m]', label: 'Claude Opus 4.7 (1M)' },
      { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { value: 'claude-sonnet-4-6[1m]', label: 'Claude Sonnet 4.6 (1M)' },
    ]);
  });

  it('adds a (1M) variant only for models whose max_input_tokens reaches 1M', async () => {
    const mixed = {
      data: [
        { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', max_input_tokens: 1000000 },
        { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', max_input_tokens: 200000 },
        { id: 'claude-no-meta', display_name: 'No Meta' }, // missing field → base only
      ],
    };
    const svc = createClaudeModelsService({ readToken: () => 'tok', fetchImpl: okFetch(mixed) });
    const opts = await svc.getModelOptions();
    expect(opts?.map((o) => o.value)).toEqual([
      'default',
      'claude-opus-4-8',
      'claude-opus-4-8[1m]',
      'claude-haiku-4-5',
      'claude-no-meta',
    ]);
  });

  it('returns null (fallback) when no token is available — never calls the API', async () => {
    const fetchImpl = okFetch(apiBody);
    const svc = createClaudeModelsService({ readToken: () => null, fetchImpl });
    expect(await svc.getModelOptions()).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('retries a transient network error and succeeds', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error('fetch failed'); // ECONNRESET twice
      return { ok: true, status: 200, json: async () => apiBody } as unknown as Response;
    });
    const svc = createClaudeModelsService({
      readToken: () => 'tok',
      fetchImpl,
      sleep: async () => {},
      maxAttempts: 3,
    });
    const opts = await svc.getModelOptions();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(opts?.map((o) => o.value)).toContain('claude-opus-4-8');
  });

  it('falls back to null after exhausting retries', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    const svc = createClaudeModelsService({
      readToken: () => 'tok',
      fetchImpl,
      sleep: async () => {},
      maxAttempts: 3,
    });
    expect(await svc.getModelOptions()).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a non-OK (auth) response', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }) as unknown as Response);
    const svc = createClaudeModelsService({ readToken: () => 'tok', fetchImpl, sleep: async () => {}, maxAttempts: 3 });
    expect(await svc.getModelOptions()).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns null when the API responds non-OK', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }) as unknown as Response);
    const svc = createClaudeModelsService({ readToken: () => 'tok', fetchImpl });
    expect(await svc.getModelOptions()).toBeNull();
  });

  it('caches within the TTL — a second call does not refetch', async () => {
    const fetchImpl = okFetch(apiBody);
    const svc = createClaudeModelsService({ readToken: () => 'tok', fetchImpl, now: () => 1000, ttlMs: 10_000 });
    await svc.getModelOptions();
    await svc.getModelOptions();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refetches after the TTL expires', async () => {
    const fetchImpl = okFetch(apiBody);
    let t = 1000;
    const svc = createClaudeModelsService({ readToken: () => 'tok', fetchImpl, now: () => t, ttlMs: 5000 });
    await svc.getModelOptions();
    t += 6000;
    await svc.getModelOptions();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
