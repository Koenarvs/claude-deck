import { describe, it, expect } from 'vitest';
import { readBudgetConfig } from '../../../server/services/budget-config';

describe('readBudgetConfig', () => {
  it('returns safe defaults for the legacy enabledProviders shape', () => {
    const cfg = readBudgetConfig({ enabledProviders: ['claude'] });
    expect(cfg.providers['claude']!.billingMode).toBe('seat');
    expect(cfg.providers['claude']!.budget).toEqual({});
    expect(cfg.providers['claude']!.maxConcurrent).toBeNull();
  });

  it('extracts caps + billingMode from the rich providers shape', () => {
    const cfg = readBudgetConfig({
      providers: [
        { id: 'claude', enabled: true, billingMode: 'metered', budget: { dailyUsd: 50, perGoalUsd: 10 }, maxConcurrent: 2 },
        { id: 'codex', enabled: true, billingMode: 'seat' },
      ],
    });
    expect(cfg.providers['claude']!.billingMode).toBe('metered');
    expect(cfg.providers['claude']!.budget.dailyUsd).toBe(50);
    expect(cfg.providers['claude']!.budget.perGoalUsd).toBe(10);
    expect(cfg.providers['claude']!.maxConcurrent).toBe(2);
    expect(cfg.providers['codex']!.billingMode).toBe('seat');
  });

  it('reports whether any provider is metered (caps only matter for metered)', () => {
    expect(readBudgetConfig({ enabledProviders: ['claude'] }).anyMetered).toBe(false);
    expect(
      readBudgetConfig({ providers: [{ id: 'claude', enabled: true, billingMode: 'metered' }] }).anyMetered,
    ).toBe(true);
  });

  it('always includes claude even when absent from config', () => {
    expect(readBudgetConfig({}).providers['claude']).toBeDefined();
  });
});
