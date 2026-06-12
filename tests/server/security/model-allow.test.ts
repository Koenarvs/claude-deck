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

  describe('with live catalog values', () => {
    const live = createModelValidator(() => [
      'Gemini 3.1 Pro (High)', // Antigravity display name (registry does not match)
      'gpt-5.2', // Codex slug the static registry predates
    ]);

    it('accepts an Antigravity display-name value present in the live catalog', () => {
      expect(live('Gemini 3.1 Pro (High)').ok).toBe(true);
    });

    it('accepts a live Codex slug the registry does not resolve', () => {
      expect(live('gpt-5.2').ok).toBe(true);
    });

    it('still rejects values absent from both the registry and the live catalog', () => {
      expect(live('Gemini 9 Ultra').ok).toBe(false);
    });

    it('still accepts registry-known models regardless of live values', () => {
      expect(live('claude-opus-4-8').ok).toBe(true);
    });
  });
});
