import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import logger from '../logger';
import { resolveModel, type ModelPricing } from '../../src/shared/agents/model-registry';
import type { RawUsage, RawModelUsage } from '../../src/shared/agents/types';

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

/**
 * Per-token pricing for a model string, via the single model registry.
 * Returns null when the model is unknown OR seat-only (pricing === null).
 * Callers must treat null as "unpriced" (cost 0) — never fall back to Opus.
 */
function getPricing(
  model: string | null,
): { input: number; cache_read: number; cache_creation: number; output: number } | null {
  return resolveModel(model)?.pricing ?? null;
}

function getContextWindow(model: string | null, currentContextTokens: number): number {
  // If tokens already exceed 200K, it's definitely a 1M context session
  if (currentContextTokens > 200_000) return 1_000_000;

  // Explicit 1M context variants (e.g. a '[1m]' tag on any model) — preserved
  // from the legacy behavior so non-fable 1M sessions still report 1M.
  if (model && model.toLowerCase().includes('1m')) return 1_000_000;

  const entry = resolveModel(model);
  if (entry) return entry.contextWindow;

  // Unknown model: keep the legacy 200K default for the gauge.
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
  if (!pricing) {
    logger.warn({ model: detectedModel }, 'unknown model — usage uncosted');
  }
  const estimatedCostUsd = pricing
    ? inputTokens * pricing.input +
      cacheReadTokens * pricing.cache_read +
      cacheCreationTokens * pricing.cache_creation +
      outputTokens * pricing.output
    : 0;

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

            // Try to detect model from init event, top-level model field, or the
            // per-message model (real transcripts carry it on message.model —
            // without this, sessions lacking an init line ingested uncosted).
            if (!detectedModel) {
              if (parsed?.type === 'system' && parsed?.subtype === 'init' && parsed?.model) {
                detectedModel = parsed.model as string;
              } else if (parsed?.model) {
                detectedModel = parsed.model as string;
              } else if (parsed?.message?.model) {
                detectedModel = parsed.message.model as string;
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
        if (!pricing) {
          logger.warn({ model: detectedModel }, 'unknown model — usage uncosted');
        }
        const estimatedCostUsd = pricing
          ? inputTokens * pricing.input +
            cacheReadTokens * pricing.cache_read +
            cacheCreationTokens * pricing.cache_creation +
            outputTokens * pricing.output
          : 0;

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

// ── Adapter primitives (consumed by ClaudeAdapter; pricing via model-registry) ──

/**
 * Parses a single Claude transcript file into the shared RawUsage shape.
 * Top-level fields are the rolled-up session totals; `byModel` aggregates tokens
 * per per-message model (a session that switches models or uses subagents yields
 * multiple rows). The top-level `model` is the session's detected model (init
 * event or first message), matching the legacy summary convention.
 */
export function parseClaudeUsage(filePath: string): RawUsage {
  const empty: RawUsage = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    messageCount: 0, model: null, byModel: [],
  };
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return empty;
  }

  let initModel: string | null = null;
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreationTokens = 0, messageCount = 0;
  const perModel = new Map<string, RawModelUsage>();

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);

      if (!initModel) {
        if (parsed?.type === 'system' && parsed?.subtype === 'init' && parsed?.model) {
          initModel = parsed.model as string;
        } else if (parsed?.model && !parsed?.message) {
          initModel = parsed.model as string;
        }
      }

      const usage = parsed?.message?.usage;
      if (!usage) continue;

      const inp = (usage.input_tokens as number) ?? 0;
      const cc = (usage.cache_creation_input_tokens as number) ?? 0;
      const cr = (usage.cache_read_input_tokens as number) ?? 0;
      const out = (usage.output_tokens as number) ?? 0;

      inputTokens += inp;
      cacheCreationTokens += cc;
      cacheReadTokens += cr;
      outputTokens += out;
      messageCount++;

      const msgModel: string | null = (parsed?.message?.model as string) ?? initModel ?? null;
      const key = msgModel ?? '__null__';
      let row = perModel.get(key);
      if (!row) {
        row = { model: msgModel, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, messageCount: 0 };
        perModel.set(key, row);
      }
      row.inputTokens += inp;
      row.cacheCreationTokens += cc;
      row.cacheReadTokens += cr;
      row.outputTokens += out;
      row.messageCount++;
    } catch {
      // skip malformed lines
    }
  }

  return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, messageCount, model: initModel, byModel: [...perModel.values()] };
}

/** Per-token pricing via the single registry; zeros for unknown/seat-only models. */
export function claudePricingFor(model: string | null): ModelPricing {
  return resolveModel(model)?.pricing ?? { input: 0, cache_read: 0, cache_creation: 0, output: 0 };
}

/** Context window for a model (registry-backed; respects an observed-tokens override). */
export function claudeContextWindow(model: string | null, currentContextTokens: number): number {
  return getContextWindow(model, currentContextTokens);
}

/** Locate a Claude transcript file by session id. */
export function locateClaudeJsonl(sessionId: string): string | null {
  return findJsonlFile(sessionId);
}

/** Enumerate Claude transcript paths modified within the last `sinceMs` ms (0 = all). */
export function listClaudeJsonl(sinceMs = 0): string[] {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return [];
  const cutoff = sinceMs > 0 ? Date.now() - sinceMs : 0;
  const paths: string[] = [];
  let projects: string[];
  try {
    projects = readdirSync(CLAUDE_PROJECTS_DIR);
  } catch {
    return [];
  }
  for (const project of projects) {
    const dir = join(CLAUDE_PROJECTS_DIR, project);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const fp = join(dir, entry);
      try {
        if (cutoff > 0 && statSync(fp).mtimeMs < cutoff) continue;
      } catch {
        continue;
      }
      paths.push(fp);
    }
  }
  return paths;
}
