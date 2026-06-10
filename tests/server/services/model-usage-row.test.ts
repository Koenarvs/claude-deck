import { describe, it, expect } from 'vitest';
import { buildModelUsageRow } from '../../../server/services/model-usage-row';

const tokens = { input: 1_000_000, cacheCreation: 0, cacheRead: 0, output: 0, messageCount: 4 };

describe('buildModelUsageRow', () => {
  it('prices a known model from the registry (opus input = $15/M)', () => {
    const row = buildModelUsageRow('claude-opus-4-8', tokens, '2026-06-01', 1717200000000);
    expect(row.model).toBe('claude-opus-4-8');
    expect(row.tier).toBe('frontier');
    expect(row.provider).toBe('claude');
    expect(row.unpriced).toBe(0);
    expect(row.estimatedCostUsd).toBeCloseTo(15, 4); // 1M input × $15/M
    expect(row.totalTokens).toBe(1_000_000);
  });

  it('flags unpriced when registry pricing is null (cost 0, model preserved)', () => {
    const row = buildModelUsageRow('gemini-3-pro', tokens, '2026-06-01', 1717200000000);
    expect(row.unpriced).toBe(1);
    expect(row.estimatedCostUsd).toBe(0);
    expect(row.model).toBe('gemini-3-pro');
    expect(row.totalTokens).toBe(1_000_000); // tokens never dropped
  });

  it('flags unpriced for a totally unknown model (resolveModel → null)', () => {
    const row = buildModelUsageRow('totally-made-up', tokens, '2026-06-01', 1717200000000);
    expect(row.unpriced).toBe(1);
    expect(row.estimatedCostUsd).toBe(0);
    expect(row.tier).toBe('unknown');
    expect(row.model).toBe('totally-made-up');
  });

  it('handles a null model string (no detected model)', () => {
    const row = buildModelUsageRow(null, tokens, '2026-06-01', 1717200000000);
    expect(row.unpriced).toBe(1);
    expect(row.model).toBe('unknown');
    expect(row.tier).toBe('unknown');
  });
});
