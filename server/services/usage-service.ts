import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import logger from '../logger';

export interface SessionUsage {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalTokens: number;
  currentContextTokens: number;
  estimatedCostUsd: number;
  messageCount: number;
}

interface ModelPricing {
  input: number;
  cache_read: number;
  cache_creation: number;
  output: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  opus: {
    input: 15 / 1_000_000,
    cache_read: 1.5 / 1_000_000,
    cache_creation: 18.75 / 1_000_000,
    output: 75 / 1_000_000,
  },
  sonnet: {
    input: 3 / 1_000_000,
    cache_read: 0.3 / 1_000_000,
    cache_creation: 3.75 / 1_000_000,
    output: 15 / 1_000_000,
  },
  haiku: {
    input: 0.80 / 1_000_000,
    cache_read: 0.08 / 1_000_000,
    cache_creation: 1 / 1_000_000,
    output: 4 / 1_000_000,
  },
};

function getPricing(model: string | null): ModelPricing {
  if (!model) return MODEL_PRICING.opus;
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return MODEL_PRICING.opus;
  if (lower.includes('sonnet')) return MODEL_PRICING.sonnet;
  if (lower.includes('haiku')) return MODEL_PRICING.haiku;
  return MODEL_PRICING.opus;
}

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

function findJsonlFile(sessionId: string): string | null {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return null;

  try {
    const projects = readdirSync(CLAUDE_PROJECTS_DIR);
    for (const project of projects) {
      const filePath = join(CLAUDE_PROJECTS_DIR, project, `${sessionId}.jsonl`);
      if (existsSync(filePath)) return filePath;
    }
  } catch {
    // ignore
  }
  return null;
}

export function getSessionUsage(sessionId: string, model?: string | null): SessionUsage | null {
  const filePath = findJsonlFile(sessionId);
  if (!filePath) {
    logger.debug({ sessionId }, 'No JSONL log file found for session');
    return null;
  }

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  let inputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let messageCount = 0;
  let lastInputTokens = 0;
  let lastCacheRead = 0;
  let lastCacheCreation = 0;

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const usage = entry?.message?.usage;
      if (!usage) continue;

      const inp = (usage.input_tokens as number) ?? 0;
      const cacheCreate = (usage.cache_creation_input_tokens as number) ?? 0;
      const cacheRead = (usage.cache_read_input_tokens as number) ?? 0;
      const out = (usage.output_tokens as number) ?? 0;

      inputTokens += inp;
      cacheCreationTokens += cacheCreate;
      cacheReadTokens += cacheRead;
      outputTokens += out;
      messageCount++;

      lastInputTokens = inp;
      lastCacheRead = cacheRead;
      lastCacheCreation = cacheCreate;
    } catch {
      // skip malformed lines
    }
  }

  if (messageCount === 0) return null;

  const pricing = getPricing(model ?? null);
  const estimatedCostUsd =
    inputTokens * pricing.input +
    cacheReadTokens * pricing.cache_read +
    cacheCreationTokens * pricing.cache_creation +
    outputTokens * pricing.output;

  return {
    inputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    outputTokens,
    totalTokens: inputTokens + cacheCreationTokens + cacheReadTokens + outputTokens,
    currentContextTokens: lastInputTokens + lastCacheRead + lastCacheCreation,
    estimatedCostUsd: Math.round(estimatedCostUsd * 10000) / 10000,
    messageCount,
  };
}
