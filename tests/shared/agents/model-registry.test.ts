import { describe, it, expect } from 'vitest';
import {
  resolveModel,
  MODEL_REGISTRY,
  UNKNOWN_PRICING_FALLBACK,
  type ModelEntry,
} from '../../../src/shared/agents/model-registry';

// Per-million rates the existing analytics depends on. resolveModel returns
// per-TOKEN rates, so these are divided by 1_000_000 at the assertion site.
// If any of these change, existing Claude analytics numbers move — that is the
// whole point of this parity guard.
const PER_MILLION = {
  opus: { input: 15, cache_read: 1.5, cache_creation: 18.75, output: 75 },
  sonnet: { input: 3, cache_read: 0.3, cache_creation: 3.75, output: 15 },
  haiku: { input: 0.8, cache_read: 0.08, cache_creation: 1, output: 4 },
};

function expectPerToken(
  entry: ModelEntry | null,
  perMillion: { input: number; cache_read: number; cache_creation: number; output: number },
) {
  expect(entry).not.toBeNull();
  const p = entry!.pricing;
  expect(p).not.toBeNull();
  expect(p!.input).toBe(perMillion.input / 1_000_000);
  expect(p!.cache_read).toBe(perMillion.cache_read / 1_000_000);
  expect(p!.cache_creation).toBe(perMillion.cache_creation / 1_000_000);
  expect(p!.output).toBe(perMillion.output / 1_000_000);
}

describe('model-registry: resolveModel', () => {
  it('resolves the Fable 5 1M-context transcript string', () => {
    const e = resolveModel('claude-fable-5[1m]');
    expect(e).not.toBeNull();
    expect(e!.id).toBe('fable-5');
    expect(e!.label).toBe('Fable 5');
    expect(e!.provider).toBe('claude');
    expect(e!.contextWindow).toBe(1_000_000);
  });

  it('resolves a plain opus transcript string', () => {
    const e = resolveModel('claude-opus-4-8');
    expect(e).not.toBeNull();
    expect(e!.id).toBe('opus');
    expect(e!.tier).toBe('frontier');
  });

  it('resolves sonnet and haiku by substring', () => {
    expect(resolveModel('claude-sonnet-4-6')!.id).toBe('sonnet');
    expect(resolveModel('claude-3-5-haiku-20241022')!.id).toBe('haiku');
  });

  it('returns null for an unknown model and NEVER falls back to opus', () => {
    expect(resolveModel('totally-made-up')).toBeNull();
    expect(resolveModel('gpt-9000')).toBeNull();
  });

  it('returns null for null/empty input', () => {
    expect(resolveModel(null)).toBeNull();
    expect(resolveModel('')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(resolveModel('CLAUDE-OPUS-4-8')!.id).toBe('opus');
    expect(resolveModel('Claude-Fable-5[1M]')!.id).toBe('fable-5');
  });
});

describe('model-registry: pricing parity guard (existing analytics must not move)', () => {
  it('opus rates are byte-identical to the legacy hardcoded values', () => {
    expectPerToken(resolveModel('claude-opus-4-8'), PER_MILLION.opus);
  });
  it('sonnet rates are byte-identical', () => {
    expectPerToken(resolveModel('claude-sonnet-4-6'), PER_MILLION.sonnet);
  });
  it('haiku rates are byte-identical', () => {
    expectPerToken(resolveModel('claude-3-5-haiku-20241022'), PER_MILLION.haiku);
  });
  it('Fable 5 inherits frontier (Opus) rates', () => {
    // Fable 5 is a frontier Claude model; until a distinct public rate exists it
    // is priced at the Opus frontier rate so its cost is non-zero (not unpriced).
    expectPerToken(resolveModel('claude-fable-5[1m]'), PER_MILLION.opus);
  });
});

describe('model-registry: provider stubs are seat-only (pricing null)', () => {
  it('gpt-5.5 is registered but unpriced', () => {
    const e = resolveModel('gpt-5.5');
    expect(e).not.toBeNull();
    expect(e!.provider).toBe('codex');
    expect(e!.pricing).toBeNull();
  });
  it('gemini-3-pro is registered but unpriced', () => {
    const e = resolveModel('gemini-3-pro');
    expect(e).not.toBeNull();
    expect(e!.provider).toBe('antigravity');
    expect(e!.pricing).toBeNull();
  });
  it('gemini-flash-2.5 is registered but unpriced and fast-tier', () => {
    const e = resolveModel('gemini-flash-2.5');
    expect(e).not.toBeNull();
    expect(e!.tier).toBe('fast');
    expect(e!.pricing).toBeNull();
  });
  it('UNKNOWN_PRICING_FALLBACK is null (never Opus)', () => {
    expect(UNKNOWN_PRICING_FALLBACK).toBeNull();
  });
});

describe('model-registry: structural invariants', () => {
  it('every entry has a unique id', () => {
    const ids = MODEL_REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('every entry has a positive context window and quota weight', () => {
    for (const e of MODEL_REGISTRY) {
      expect(e.contextWindow).toBeGreaterThan(0);
      expect(e.quotaWeight).toBeGreaterThan(0);
    }
  });
});
