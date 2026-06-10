import { resolveModel } from '../../src/shared/agents/model-registry';

export interface ModelTokenInput {
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
  messageCount: number;
}

export interface ModelUsageRow {
  model: string;
  tier: string;
  provider: string;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  unpriced: 0 | 1;
  messageCount: number;
  sessionDate: string;
  firstMessageAt: number;
}

/**
 * Builds one per-model usage row for the session_model_usage table.
 * Cost = tokens × registry pricing. pricing === null (or unknown model) →
 * cost 0 + unpriced flag, model string preserved (loud, not hidden).
 */
export function buildModelUsageRow(
  rawModel: string | null,
  tokens: ModelTokenInput,
  sessionDate: string,
  firstMessageAt: number,
): ModelUsageRow {
  const entry = resolveModel(rawModel);
  const totalTokens = tokens.input + tokens.cacheCreation + tokens.cacheRead + tokens.output;

  if (!entry || entry.pricing === null) {
    return {
      model: rawModel ?? 'unknown',
      tier: entry?.tier ?? 'unknown',
      provider: entry?.provider ?? 'unknown',
      inputTokens: tokens.input,
      cacheCreationTokens: tokens.cacheCreation,
      cacheReadTokens: tokens.cacheRead,
      outputTokens: tokens.output,
      totalTokens,
      estimatedCostUsd: 0,
      unpriced: 1,
      messageCount: tokens.messageCount,
      sessionDate,
      firstMessageAt,
    };
  }

  const p = entry.pricing;
  const cost =
    tokens.input * p.input +
    tokens.cacheRead * p.cache_read +
    tokens.cacheCreation * p.cache_creation +
    tokens.output * p.output;

  return {
    model: rawModel ?? entry.id,
    tier: entry.tier,
    provider: entry.provider,
    inputTokens: tokens.input,
    cacheCreationTokens: tokens.cacheCreation,
    cacheReadTokens: tokens.cacheRead,
    outputTokens: tokens.output,
    totalTokens,
    estimatedCostUsd: Math.round(cost * 10000) / 10000,
    unpriced: 0,
    messageCount: tokens.messageCount,
    sessionDate,
    firstMessageAt,
  };
}
