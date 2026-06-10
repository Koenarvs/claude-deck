import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  parseClaudeUsage,
  claudePricingFor,
  claudeContextWindow,
} from '../../../server/services/usage-service';

const fixture = path.resolve(__dirname, '../../fixtures/usage/sample-session.jsonl');

describe('claude usage primitives', () => {
  it('parseClaudeUsage sums tokens across turns and rolls up totals', () => {
    const u = parseClaudeUsage(fixture);
    expect(u.inputTokens).toBe(300);
    expect(u.cacheCreationTokens).toBe(20);
    expect(u.cacheReadTokens).toBe(15);
    expect(u.outputTokens).toBe(130);
    expect(u.messageCount).toBe(2);
    expect(u.model).toBe('claude-opus-4-8');
  });

  it('parseClaudeUsage breaks usage down per message model (Delta A)', () => {
    const u = parseClaudeUsage(fixture);
    expect(u.byModel).toHaveLength(2);
    const opus = u.byModel.find((b) => b.model === 'claude-opus-4-8');
    const sonnet = u.byModel.find((b) => b.model === 'claude-sonnet-4-6');
    expect(opus?.inputTokens).toBe(100);
    expect(opus?.outputTokens).toBe(50);
    expect(opus?.messageCount).toBe(1);
    expect(sonnet?.inputTokens).toBe(200);
    expect(sonnet?.outputTokens).toBe(80);
  });

  it('parseClaudeUsage returns an empty shape for a missing file', () => {
    const u = parseClaudeUsage(path.resolve(__dirname, 'no-such-file.jsonl'));
    expect(u.messageCount).toBe(0);
    expect(u.byModel).toEqual([]);
  });

  it('claudePricingFor maps opus by substring (per-token)', () => {
    expect(claudePricingFor('claude-opus-4-8').output).toBeCloseTo(75 / 1_000_000);
  });

  it('claudePricingFor returns zeros for unknown/seat-only models (never Opus)', () => {
    expect(claudePricingFor('totally-unknown')).toEqual({ input: 0, cache_read: 0, cache_creation: 0, output: 0 });
  });

  it('claudeContextWindow returns 1M when tokens exceed 200k, else the model default', () => {
    expect(claudeContextWindow('claude-opus-4-8', 250_000)).toBe(1_000_000);
    expect(claudeContextWindow('claude-opus-4-8', 1_000)).toBe(200_000);
  });
});
