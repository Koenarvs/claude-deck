// src/shared/agents/model-registry.ts
//
// SINGLE SOURCE OF TRUTH for model identity, pricing, tier, quota weight, and
// context window. Server services (usage-service, ingestion-service) and the
// future adapter layer all resolve models through here — there are NO other
// pricing tables in the codebase.
//
// Dependency-free on purpose: this file is imported by both the jsdom client
// test project and the node server project, so it must not import server-only
// modules (e.g. the Pino logger). Callers do the logging.
//
// NOTE: `ModelPricing` is declared here (not imported from ./types) so the
// registry has no dependency beneath it — it is the lowest-level shared
// primitive. The Phase 1 agent-adapter foundation re-uses this same shape; the
// structural type is identical, so the two are interchangeable.

/** Per-token USD pricing for a model. */
export interface ModelPricing {
  input: number;
  cache_read: number;
  cache_creation: number;
  output: number;
}

export type ModelTier = 'frontier' | 'balanced' | 'fast' | 'unknown';

export interface ModelEntry {
  /** canonical key, e.g. 'fable-5' */
  id: string;
  /** matches a transcript model string (already lower-cased by resolveModel) */
  match: (raw: string) => boolean;
  /** display label, e.g. 'Fable 5' */
  label: string;
  /** owning provider: 'claude' | 'antigravity' | 'codex' */
  provider: string;
  tier: ModelTier;
  /** per-token USD; null = no public metered rate (subscription-only / adapter not landed) */
  pricing: ModelPricing | null;
  /** quota weight vs the provider's lightest model (for seat window utilization) */
  quotaWeight: number;
  /** context window in tokens, e.g. 200_000 or 1_000_000 for [1m] variants */
  contextWindow: number;
}

/** Per-token USD. These are the EXACT legacy rates — do not change without intent. */
const perToken = (perMillion: {
  input: number;
  cache_read: number;
  cache_creation: number;
  output: number;
}): ModelPricing => ({
  input: perMillion.input / 1_000_000,
  cache_read: perMillion.cache_read / 1_000_000,
  cache_creation: perMillion.cache_creation / 1_000_000,
  output: perMillion.output / 1_000_000,
});

// Frontier Claude pricing (Opus rate). Fable 5 inherits this until it gets a
// distinct published rate — keeping its cost non-zero rather than unpriced.
const CLAUDE_FRONTIER = perToken({ input: 15, cache_read: 1.5, cache_creation: 18.75, output: 75 });
const CLAUDE_SONNET = perToken({ input: 3, cache_read: 0.3, cache_creation: 3.75, output: 15 });
const CLAUDE_HAIKU = perToken({ input: 0.8, cache_read: 0.08, cache_creation: 1, output: 4 });

export const MODEL_REGISTRY: ModelEntry[] = [
  {
    id: 'fable-5',
    // 'claude-fable-5[1m]' and any future fable variant. Checked before opus so
    // the [1m] context window wins.
    match: (raw) => raw.includes('fable'),
    label: 'Fable 5',
    provider: 'claude',
    tier: 'frontier',
    pricing: CLAUDE_FRONTIER,
    quotaWeight: 5,
    contextWindow: 1_000_000, // [1m] tag in the transcript model string
  },
  {
    id: 'opus',
    match: (raw) => raw.includes('opus'),
    label: 'Opus',
    provider: 'claude',
    tier: 'frontier',
    pricing: CLAUDE_FRONTIER,
    quotaWeight: 5,
    contextWindow: 200_000,
  },
  {
    id: 'sonnet',
    match: (raw) => raw.includes('sonnet'),
    label: 'Sonnet',
    provider: 'claude',
    tier: 'balanced',
    pricing: CLAUDE_SONNET,
    quotaWeight: 1,
    contextWindow: 200_000,
  },
  {
    id: 'haiku',
    match: (raw) => raw.includes('haiku'),
    label: 'Haiku',
    provider: 'claude',
    tier: 'fast',
    pricing: CLAUDE_HAIKU,
    quotaWeight: 1,
    contextWindow: 200_000,
  },

  // ── Non-Claude providers. These seats are subscription-billed; the metered
  //    rates below express usage as EQUIVALENT API VALUE in dollars (public
  //    pay-as-you-go list prices, June 2026). cache_creation uses the input rate
  //    where the provider doesn't bill cache writes separately.
  {
    id: 'gpt-5.5',
    match: (raw) => raw.includes('gpt-5.5') || raw.includes('gpt5.5'),
    label: 'GPT-5.5',
    provider: 'codex',
    tier: 'frontier',
    // OpenAI list: $5 in / $30 out / $0.50 cached input (April 2026 5.5 launch).
    pricing: perToken({ input: 5, cache_read: 0.5, cache_creation: 5, output: 30 }),
    quotaWeight: 5,
    contextWindow: 400_000,
  },
  // Codex ChatGPT-seat lineup (ids from ~/.codex/models_cache.json). pricing=null
  // (seat, no metered rate). The '-mini' matcher MUST precede the broad 'gpt-5.4'
  // matcher — resolveModel returns the first match in array order.
  {
    id: 'gpt-5.4-mini',
    match: (raw) => raw.includes('gpt-5.4-mini'),
    label: 'GPT-5.4 Mini',
    provider: 'codex',
    tier: 'fast',
    // Mini class list rate ($0.25 in / $2 out).
    pricing: perToken({ input: 0.25, cache_read: 0.025, cache_creation: 0.25, output: 2 }),
    quotaWeight: 1,
    contextWindow: 400_000,
  },
  {
    id: 'gpt-5.4',
    match: (raw) => raw.includes('gpt-5.4'),
    label: 'GPT-5.4',
    provider: 'codex',
    tier: 'balanced',
    // Pre-5.5 GPT-5 line rate ($2.50 in / $15 out).
    pricing: perToken({ input: 2.5, cache_read: 0.25, cache_creation: 2.5, output: 15 }),
    quotaWeight: 4,
    contextWindow: 400_000,
  },
  {
    id: 'gpt-5.3-codex',
    match: (raw) => raw.includes('gpt-5.3-codex') || raw.includes('gpt-5.3'),
    label: 'GPT-5.3 Codex',
    provider: 'codex',
    tier: 'balanced',
    // Codex line list rate ($1.25 in / $10 out).
    pricing: perToken({ input: 1.25, cache_read: 0.125, cache_creation: 1.25, output: 10 }),
    quotaWeight: 3,
    contextWindow: 400_000,
  },
  {
    id: 'gemini-3-pro',
    match: (raw) => raw.includes('gemini-3-pro') || raw.includes('gemini-3.0-pro'),
    label: 'Gemini 3 Pro',
    provider: 'antigravity',
    tier: 'frontier',
    // Google list: $2 in / $12 out (≤200K tier); cached input ~10% of input.
    pricing: perToken({ input: 2, cache_read: 0.2, cache_creation: 2, output: 12 }),
    quotaWeight: 5,
    contextWindow: 1_000_000,
  },
  {
    id: 'gemini-flash-2.5',
    match: (raw) => raw.includes('gemini-flash-2.5') || raw.includes('gemini-2.5-flash'),
    label: 'Gemini Flash 2.5',
    provider: 'antigravity',
    tier: 'fast',
    // Google list: $0.30 in / $2.50 out; cached input ~10% of input.
    pricing: perToken({ input: 0.3, cache_read: 0.03, cache_creation: 0.3, output: 2.5 }),
    quotaWeight: 1,
    contextWindow: 1_000_000,
  },
];

/**
 * Resolve a transcript model string to its registry entry.
 * Returns null for unknown/empty input. NULL MEANS UNKNOWN — callers must treat
 * it as unpriced (cost 0 + warn), and must NEVER fall back to Opus.
 */
export function resolveModel(raw: string | null): ModelEntry | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  for (const entry of MODEL_REGISTRY) {
    if (entry.match(lower)) return entry;
  }
  return null;
}

/** Explicit sentinel: there is no Opus fallback. Unknown models are unpriced. */
export const UNKNOWN_PRICING_FALLBACK: ModelPricing | null = null;
