import { describe, it, expect } from 'vitest';
import { resolveModel } from '../../../src/shared/agents/model-registry';

// Codex model variants (the gpt-5.5 default already lands as a Phase-1 stub;
// these add the rest of the ChatGPT-seat lineup discovered in ~/.codex/models_cache.json).
describe('codex model variants in registry', () => {
  it('resolves gpt-5.4 to a codex entry metered at the pre-5.5 line rate', () => {
    const m = resolveModel('gpt-5.4');
    expect(m).not.toBeNull();
    expect(m!.provider).toBe('codex');
    expect(m!.pricing).not.toBeNull(); // equivalent-API-value rate ($2.50/$15)
    expect(m!.pricing!.input).toBeCloseTo(2.5 / 1_000_000, 12);
    expect(m!.contextWindow).toBeGreaterThanOrEqual(200_000);
  });

  it('resolves the mini variant to the fast tier (matched before the broad gpt-5.4)', () => {
    const m = resolveModel('gpt-5.4-mini');
    expect(m).not.toBeNull();
    expect(m!.id).toBe('gpt-5.4-mini');
    expect(m!.tier).toBe('fast');
  });

  it('resolves gpt-5.3-codex to a codex provider entry', () => {
    expect(resolveModel('gpt-5.3-codex')!.provider).toBe('codex');
  });

  it('matches a transcript model string containing the id', () => {
    expect(resolveModel('openai/gpt-5.4-mini')!.id).toBe('gpt-5.4-mini');
  });

  it('an imaginary openai model stays null (no opus default)', () => {
    expect(resolveModel('gpt-9-imaginary')).toBeNull();
  });
});
