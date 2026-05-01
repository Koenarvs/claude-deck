import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
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
  contextWindow: number;
  contextPct: number;
  estimatedCostUsd: number;
  messageCount: number;
}

/** Per-session usage summary with file metadata for aggregation. */
export interface SessionUsageSummary {
  sessionId: string;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  messageCount: number;
  /** File modification time (epoch ms) — used for date grouping. */
  fileModifiedAt: number;
  /** First message timestamp from JSONL (epoch ms), or file mtime as fallback. */
  firstMessageAt: number;
  /** Model detected from JSONL entries (for pricing). */
  model: string | null;
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

function getContextWindow(model: string | null, currentContextTokens: number): number {
  // If tokens already exceed 200K, it's definitely a 1M context session
  if (currentContextTokens > 200_000) return 1_000_000;

  if (!model) return 200_000;
  const lower = model.toLowerCase();

  // Explicit 1M context variants
  if (lower.includes('1m')) return 1_000_000;

  // Haiku is always 200K
  if (lower.includes('haiku')) return 200_000;

  // Opus and Sonnet default to 200K unless proven otherwise
  return 200_000;
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

  const detectedModel = model ?? null;
  const pricing = getPricing(detectedModel);
  const estimatedCostUsd =
    inputTokens * pricing.input +
    cacheReadTokens * pricing.cache_read +
    cacheCreationTokens * pricing.cache_creation +
    outputTokens * pricing.output;

  const currentContext = lastInputTokens + lastCacheRead + lastCacheCreation;
  const contextWindow = getContextWindow(detectedModel, currentContext);
  const contextPct = Math.min(100, Math.round((currentContext / contextWindow) * 100));

  return {
    inputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    outputTokens,
    totalTokens: inputTokens + cacheCreationTokens + cacheReadTokens + outputTokens,
    currentContextTokens: currentContext,
    contextWindow,
    contextPct,
    estimatedCostUsd: Math.round(estimatedCostUsd * 10000) / 10000,
    messageCount,
  };
}

/**
 * Discovers all JSONL session files across all project directories and returns
 * per-session usage summaries. Used by analytics endpoints to compute aggregate
 * totals and daily cost breakdowns without relying on SQLite token columns.
 *
 * @param sinceDaysAgo - Only include files modified within the last N days. 0 = all time.
 */
export function getAllSessionUsageSummaries(sinceDaysAgo = 0): SessionUsageSummary[] {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return [];

  const cutoff = sinceDaysAgo > 0
    ? Date.now() - sinceDaysAgo * 24 * 60 * 60 * 1000
    : 0;

  const summaries: SessionUsageSummary[] = [];

  try {
    const projects = readdirSync(CLAUDE_PROJECTS_DIR);
    for (const project of projects) {
      const projectDir = join(CLAUDE_PROJECTS_DIR, project);
      let entries: string[];
      try {
        entries = readdirSync(projectDir);
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.endsWith('.jsonl')) continue;
        const filePath = join(projectDir, entry);
        const sessionId = entry.replace('.jsonl', '');

        // Check file mtime for the date cutoff
        let fileMtime: number;
        try {
          const st = statSync(filePath);
          fileMtime = st.mtimeMs;
        } catch {
          continue;
        }

        if (cutoff > 0 && fileMtime < cutoff) continue;

        let content: string;
        try {
          content = readFileSync(filePath, 'utf-8');
        } catch {
          continue;
        }

        let inputTokens = 0;
        let cacheCreationTokens = 0;
        let cacheReadTokens = 0;
        let outputTokens = 0;
        let messageCount = 0;
        let firstTimestamp = 0;
        let detectedModel: string | null = null;

        for (const line of content.split('\n')) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);

            // Try to detect model from init event or message model field
            if (!detectedModel) {
              if (parsed?.type === 'system' && parsed?.subtype === 'init' && parsed?.model) {
                detectedModel = parsed.model as string;
              } else if (parsed?.model) {
                detectedModel = parsed.model as string;
              }
            }

            // Try to extract timestamp for date grouping
            if (firstTimestamp === 0 && parsed?.timestamp) {
              const ts = typeof parsed.timestamp === 'string'
                ? new Date(parsed.timestamp).getTime()
                : parsed.timestamp as number;
              if (!isNaN(ts) && ts > 0) firstTimestamp = ts;
            }

            const usage = parsed?.message?.usage;
            if (!usage) continue;

            inputTokens += (usage.input_tokens as number) ?? 0;
            cacheCreationTokens += (usage.cache_creation_input_tokens as number) ?? 0;
            cacheReadTokens += (usage.cache_read_input_tokens as number) ?? 0;
            outputTokens += (usage.output_tokens as number) ?? 0;
            messageCount++;
          } catch {
            // skip malformed lines
          }
        }

        if (messageCount === 0) continue;

        const pricing = getPricing(detectedModel);
        const estimatedCostUsd =
          inputTokens * pricing.input +
          cacheReadTokens * pricing.cache_read +
          cacheCreationTokens * pricing.cache_creation +
          outputTokens * pricing.output;

        summaries.push({
          sessionId,
          inputTokens,
          cacheCreationTokens,
          cacheReadTokens,
          outputTokens,
          totalTokens: inputTokens + cacheCreationTokens + cacheReadTokens + outputTokens,
          estimatedCostUsd: Math.round(estimatedCostUsd * 10000) / 10000,
          messageCount,
          fileModifiedAt: fileMtime,
          firstMessageAt: firstTimestamp > 0 ? firstTimestamp : fileMtime,
          model: detectedModel,
        });
      }
    }
  } catch (err) {
    logger.error({ err }, 'Error scanning JSONL session files');
  }

  return summaries;
}

/** Aggregate totals across all JSONL session files. */
export interface AggregateTotals {
  sessions: number;
  cost: number;
  tokensIn: number;
  tokensOut: number;
}

/**
 * Computes aggregate totals from JSONL files. Used by /api/analytics/totals.
 *
 * tokensIn includes input + cache_creation + cache_read (matches KanbanCard convention).
 * tokensOut is output tokens only.
 */
export function getAggregateTotals(sinceDaysAgo = 0): AggregateTotals {
  const summaries = getAllSessionUsageSummaries(sinceDaysAgo);

  let cost = 0;
  let tokensIn = 0;
  let tokensOut = 0;

  for (const s of summaries) {
    cost += s.estimatedCostUsd;
    tokensIn += s.inputTokens + s.cacheCreationTokens + s.cacheReadTokens;
    tokensOut += s.outputTokens;
  }

  return {
    sessions: summaries.length,
    cost: Math.round(cost * 10000) / 10000,
    tokensIn,
    tokensOut,
  };
}

/** A single day's cost aggregate from JSONL data. */
export interface DailyCostEntry {
  date: string;
  cost: number;
  sessions: number;
}

/**
 * Computes daily cost aggregates from JSONL files. Uses the session's first
 * message timestamp (or file mtime) to assign each session to a date.
 *
 * @param sinceDaysAgo - Only include sessions from the last N days. 0 = all time.
 */
export function getDailyCosts(sinceDaysAgo = 90): DailyCostEntry[] {
  const summaries = getAllSessionUsageSummaries(sinceDaysAgo);

  const byDate = new Map<string, { cost: number; sessions: number }>();

  for (const s of summaries) {
    const d = new Date(s.firstMessageAt);
    const dateStr = d.toISOString().split('T')[0];
    const existing = byDate.get(dateStr) ?? { cost: 0, sessions: 0 };
    existing.cost += s.estimatedCostUsd;
    existing.sessions += 1;
    byDate.set(dateStr, existing);
  }

  return [...byDate.entries()]
    .map(([date, v]) => ({
      date,
      cost: Math.round(v.cost * 10000) / 10000,
      sessions: v.sessions,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
