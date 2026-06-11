import { describe, it, expect } from 'vitest';
import { recommendRoute } from '../../../server/services/quota-router';

const util = [
  { provider: 'claude', utilizationPct: 92 },
  { provider: 'codex', utilizationPct: 20 },
  { provider: 'antigravity', utilizationPct: 70 },
];

const fns = {
  providerForModel: () => 'claude',
  coolestModelForProvider: (p: string) => `${p}-default`,
};

describe('recommendRoute', () => {
  it('stays on the requested provider when its window is cool', () => {
    const r = recommendRoute({
      requestedModel: 'sonnet',
      windowUtilization: [{ provider: 'claude', utilizationPct: 30 }],
      enabledProviders: ['claude', 'codex'],
      hotThresholdPct: 85,
      autoRoute: false,
      ...fns,
    });
    expect(r.recommendedProvider).toBeNull();
    expect(r.applied).toBe(false);
  });

  it('recommends the coolest enabled alternate when the requested provider is hot', () => {
    const r = recommendRoute({
      requestedModel: 'opus',
      windowUtilization: util,
      enabledProviders: ['claude', 'codex', 'antigravity'],
      hotThresholdPct: 85,
      autoRoute: false,
      ...fns,
    });
    expect(r.recommendedProvider).toBe('codex');
    expect(r.recommendedModel).toBe('codex-default');
    expect(r.reason).toMatch(/hot/i);
    expect(r.applied).toBe(false);
  });

  it('applies the recommendation when autoRoute is true', () => {
    const r = recommendRoute({
      requestedModel: 'opus',
      windowUtilization: util,
      enabledProviders: ['claude', 'codex'],
      hotThresholdPct: 85,
      autoRoute: true,
      ...fns,
    });
    expect(r.recommendedProvider).toBe('codex');
    expect(r.applied).toBe(true);
  });

  it('makes no recommendation when no cooler enabled provider exists', () => {
    const r = recommendRoute({
      requestedModel: 'opus',
      windowUtilization: [{ provider: 'claude', utilizationPct: 95 }],
      enabledProviders: ['claude'],
      hotThresholdPct: 85,
      autoRoute: true,
      ...fns,
    });
    expect(r.recommendedProvider).toBeNull();
    expect(r.applied).toBe(false);
  });

  it('makes no recommendation when window utilization is empty (feed absent)', () => {
    const r = recommendRoute({
      requestedModel: 'opus',
      windowUtilization: [],
      enabledProviders: ['claude', 'codex'],
      hotThresholdPct: 85,
      autoRoute: true,
      ...fns,
    });
    expect(r.recommendedProvider).toBeNull();
  });
});
