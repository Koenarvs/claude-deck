import { describe, it, expect } from 'vitest';
import { createModelValidator } from '../../../server/security/model-allow';

describe('model validator', () => {
  const validate = createModelValidator();

  it('accepts undefined model (uses CLI default)', () => {
    expect(validate(undefined).ok).toBe(true);
  });

  it("accepts 'default' (sentinel — not passed to --model)", () => {
    expect(validate('default').ok).toBe(true);
  });

  it('accepts a known registry model', () => {
    // resolveModel must recognize a current Claude model id.
    expect(validate('claude-opus-4-8').ok).toBe(true);
  });

  it('rejects an unknown / attacker-controlled model string', () => {
    const r = validate('--dangerously-skip; rm -rf /');
    expect(r.ok).toBe(false);
  });

  it('rejects a model that does not resolve in the registry', () => {
    expect(validate('totally-made-up-model').ok).toBe(false);
  });
});
