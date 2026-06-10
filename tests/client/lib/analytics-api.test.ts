import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchModelBreakdown, fetchProviderValue } from '../../../src/lib/analytics-api';

afterEach(() => { vi.restoreAllMocks(); });

describe('analytics-api client', () => {
  it('fetchModelBreakdown passes days + signal and returns parsed body', async () => {
    const ctrl = new AbortController();
    const json = { label: 'equivalent_value', models: [{ model: 'claude-opus-4-8', unpriced: false }] };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(json) });
    vi.stubGlobal('fetch', fetchMock);
    const out = await fetchModelBreakdown(30, ctrl.signal);
    expect(fetchMock).toHaveBeenCalledWith('/api/analytics/model-breakdown?days=30', { signal: ctrl.signal });
    expect(out.label).toBe('equivalent_value');
    expect(out.models[0].model).toBe('claude-opus-4-8');
  });

  it('fetchProviderValue returns empty providers on non-ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({}) }));
    const out = await fetchProviderValue(30, new AbortController().signal);
    expect(out.providers).toEqual([]);
  });
});
