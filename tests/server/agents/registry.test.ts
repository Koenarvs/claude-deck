import { describe, it, expect } from 'vitest';
import {
  adapterForModel,
  enabledModelOptions,
  buildCatalog,
  makeRegistry,
} from '../../../server/agents/registry';
import { ClaudeAdapter } from '../../../server/agents/claude-adapter';
import { MockAdapter } from '../../fixtures/mock-adapter';

const reg = makeRegistry([new ClaudeAdapter(), new MockAdapter()]);

describe('registry', () => {
  it('resolves a model to its adapter', () => {
    expect(reg.adapterForModel('opus', ['claude', 'mock']).id).toBe('claude');
    expect(reg.adapterForModel('mock', ['claude', 'mock']).id).toBe('mock');
  });

  it('falls back to claude for unknown/default/disabled', () => {
    expect(reg.adapterForModel('default', ['claude']).id).toBe('claude');
    expect(reg.adapterForModel('totally-unknown', ['claude']).id).toBe('claude');
    expect(reg.adapterForModel('mock', ['claude']).id).toBe('claude'); // mock disabled
  });

  it('enabledModelOptions is the union of enabled providers', () => {
    expect(reg.enabledModelOptions(['claude']).map((m) => m.value)).toEqual(['default', 'fable-5', 'opus', 'sonnet', 'haiku']);
    expect(reg.enabledModelOptions(['claude', 'mock']).some((m) => m.value === 'mock')).toBe(true);
  });

  it('buildCatalog marks enabled flags and carries the capability matrix', () => {
    const cat = reg.buildCatalog(['claude']);
    expect(cat.find((c) => c.id === 'claude')?.enabled).toBe(true);
    expect(cat.find((c) => c.id === 'mock')?.enabled).toBe(false);
    expect(cat.find((c) => c.id === 'claude')?.capabilities.canApprove).toBe(true);
    expect(cat.find((c) => c.id === 'mock')?.capabilities.canApprove).toBe(false);
  });
});

describe('default production registry (claude + codex + antigravity)', () => {
  it('catalog lists all three providers; only enabled ones are flagged', () => {
    const cat = buildCatalog(['claude']);
    expect(cat.map((c) => c.id).sort()).toEqual(['antigravity', 'claude', 'codex']);
    expect(cat.find((c) => c.id === 'claude')?.enabled).toBe(true);
    expect(cat.find((c) => c.id === 'codex')?.enabled).toBe(false);
    expect(cat.find((c) => c.id === 'antigravity')?.enabled).toBe(false);
    // Non-Claude providers carry their models so the picker can surface them once enabled.
    expect(cat.find((c) => c.id === 'codex')?.models.some((m) => m.value === 'gpt-5.4')).toBe(true);
    expect(
      cat.find((c) => c.id === 'antigravity')?.models.some((m) => m.value === 'gemini-3-pro'),
    ).toBe(true);
  });

  it('adapterForModel selects the provider that owns the model when enabled', () => {
    expect(adapterForModel('opus', ['claude']).id).toBe('claude');
    expect(adapterForModel('gpt-5.4', ['claude', 'codex']).id).toBe('codex');
    expect(adapterForModel('gemini-3-pro', ['claude', 'antigravity']).id).toBe('antigravity');
    // Disabled provider → falls back to claude (won't spawn the wrong CLI silently-enabled).
    expect(adapterForModel('gpt-5.4', ['claude']).id).toBe('claude');
  });

  it('enabledModelOptions unions only enabled providers', () => {
    expect(enabledModelOptions(['claude']).length).toBe(5); // default + fable-5 + opus + sonnet + haiku
    expect(enabledModelOptions(['claude', 'codex']).some((m) => m.value === 'gpt-5.4')).toBe(true);
  });
});
