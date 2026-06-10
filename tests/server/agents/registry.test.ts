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
    expect(reg.enabledModelOptions(['claude']).map((m) => m.value)).toEqual(['default', 'opus', 'sonnet', 'haiku']);
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

it('default registry exports module-level helpers (claude only)', () => {
  expect(adapterForModel('opus', ['claude']).id).toBe('claude');
  expect(enabledModelOptions(['claude']).length).toBe(4);
  expect(buildCatalog(['claude']).length).toBe(1);
});
