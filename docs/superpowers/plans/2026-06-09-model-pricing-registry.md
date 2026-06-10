# Phase 0A — Model & Pricing Registry (implementation plan)

> **Methodology:** `superpowers:writing-plans` — bite-sized TDD tasks, exact paths, real code in every step, one commit per task, Self-Review at the end. Each task is: write/adjust the test → run it and watch it FAIL for the right reason → implement → run and watch it PASS → commit.

## Why

Fixes the live bug **"a session with model 'Fable 5' (`claude-fable-5[1m]`) shows no/incorrect cost."**

Pricing is hardcoded in **two** copies — `server/services/usage-service.ts` (lines 44–89) and `server/services/ingestion-service.ts` (lines 12–25) — each a 3-entry `Record` (`opus`/`sonnet`/`haiku`) with substring matching and a **silent fallback to Opus** for anything unrecognized (`usage-service.ts:71`, `ingestion-service.ts:24`). Consequences:

1. A `claude-fable-5[1m]` session — and any future GPT-5.5 / Gemini session — is silently mispriced **as Opus**, which corrupts the efficiency analytics this whole effort is built on.
2. There is no single place to add a model or update a rate.
3. Unknown models are invisible rather than flagged.

This plan creates `src/shared/agents/model-registry.ts` as the **single source of truth** (types + entries + `resolveModel`), deletes both local pricing copies in favor of registry imports, and makes unknown models **loud** (logged + stored with `estimated_cost_usd = 0` and a non-null model string, never dropped, never coerced to Opus).

> The *symptom* the user sees (zero tokens/cost for the current Fable 5 session) may be ingestion timing or transcript-shape, not only pricing — the silent Opus-fallback would mis-*price*, not zero-out. The fix below makes unknown models loud, which turns whatever the real cause is into something visible instead of guessed.

**Roadmap source:** `docs/superpowers/plans/2026-06-09-master-roadmap.md` → "Phase 0 — 0A" and §2 cross-cutting decisions (esp. Decision 4: per-model granularity; Decision 5: tier/top-tier-share; the `pricing===null → cost 0 + "unpriced"` billing seam).

## Migrations

**None.** The registry is code, not data. No schema change; `session_usage` columns are untouched. (`estimated_cost_usd` already defaults to `0`, so storing `0` for unknown models requires no migration.)

## Locked contracts (verbatim from roadmap §"Phase 0 — 0A Step 1")

```ts
export type ModelTier = 'frontier' | 'balanced' | 'fast' | 'unknown';
export interface ModelEntry {
  id: string;                  // canonical key, e.g. 'fable-5'
  match: (raw: string) => boolean;   // matches a transcript model string
  label: string;               // 'Fable 5'
  provider: string;            // 'claude' | 'antigravity' | 'codex'
  tier: ModelTier;
  /** per-token USD; null = no public metered rate (subscription-only) */
  pricing: { input: number; cache_read: number; cache_creation: number; output: number } | null;
  /** quota weight vs the provider's lightest model (for seat window utilization) */
  quotaWeight: number;
  contextWindow: number;       // e.g. 200_000, or 1_000_000 for [1m]
}
export const MODEL_REGISTRY: ModelEntry[] = [ /* ... */ ];
export function resolveModel(raw: string | null): ModelEntry | null; // null = unknown (do NOT default to opus)
export const UNKNOWN_PRICING_FALLBACK = null;
```

**Billing rule (seam this plan establishes):** dollars = tokens × registry pricing. `pricing === null` (or `resolveModel` returns `null`) → cost `0` + the model is flagged "unpriced/unknown" by a `logger.warn`. The downstream analytics plan (Phase 2) renders the "unpriced model" badge; this plan's warn-and-store-0 behavior is the seam it consumes.

**Interop with the foundation `ModelPricing` type.** `src/shared/agents/types.ts` already declares `ModelPricing { input; cache_read; cache_creation; output }` (per-token). The registry's inline pricing object is the *same shape*; the registry re-uses that exported type rather than redeclaring it, so a model's pricing is callable per-model by anything holding a `ModelEntry`. (`RawUsage.byModel: RawModelUsage[]` — added by the Phase 1 / Delta A plan — will carry per-model rows; each row's `model` string is fed through `resolveModel` to get its `pricing`. That consumer is out of scope here; this plan only guarantees the per-model lookup exists and is correct.)

## Pre-flight (no commit) — establish the green baseline

Run once before Task 1 so any later red is attributable to this plan, not pre-existing drift:

```
npm test
npm run typecheck
```

Record the failing-count (the roadmap notes a "green baseline" was established in commit `87dfa01`). If anything is red here, stop and reconcile before proceeding — this plan must not regress the baseline.

**Test runner note (binding for every task below):** `vite.config.ts` routes `tests/shared/**/*.test.ts` to the **client (jsdom)** Vitest project and `tests/server/**/*.test.ts` to the **server (node)** project. The registry test (`tests/shared/agents/model-registry.test.ts`) therefore runs under jsdom. The registry file itself must **not** import the Pino `logger` (server-only) — keep it dependency-free. Only the *service* files import `logger`, and they run under the server project. Targeted runs:

- Registry test only: `npx vitest run tests/shared/agents/model-registry.test.ts`
- Service/analytics suite: `npx vitest run tests/server/analytics-ingestion.test.ts tests/server/analytics-regression.test.ts tests/server/analytics-data-layer.test.ts tests/server/analytics-phase2.test.ts tests/server/analytics-phase3.test.ts`

---

## Task 1 — Write the registry test (RED)

**Goal:** Lock the resolution contract and the rate-parity guard before any registry exists. The test must FAIL because `src/shared/agents/model-registry.ts` does not yet exist (import error).

**Create** `tests/shared/agents/model-registry.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  resolveModel,
  MODEL_REGISTRY,
  UNKNOWN_PRICING_FALLBACK,
  type ModelEntry,
} from '../../../src/shared/agents/model-registry';

// Per-million rates the existing analytics depends on. resolveModel returns
// per-TOKEN rates, so these are divided by 1_000_000 at the assertion site.
// If any of these change, existing Claude analytics numbers move — that is the
// whole point of this parity guard.
const PER_MILLION = {
  opus:   { input: 15,   cache_read: 1.5,  cache_creation: 18.75, output: 75 },
  sonnet: { input: 3,    cache_read: 0.3,  cache_creation: 3.75,  output: 15 },
  haiku:  { input: 0.80, cache_read: 0.08, cache_creation: 1,     output: 4  },
};

function expectPerToken(entry: ModelEntry | null, perMillion: { input: number; cache_read: number; cache_creation: number; output: number }) {
  expect(entry).not.toBeNull();
  const p = entry!.pricing;
  expect(p).not.toBeNull();
  expect(p!.input).toBe(perMillion.input / 1_000_000);
  expect(p!.cache_read).toBe(perMillion.cache_read / 1_000_000);
  expect(p!.cache_creation).toBe(perMillion.cache_creation / 1_000_000);
  expect(p!.output).toBe(perMillion.output / 1_000_000);
}

describe('model-registry: resolveModel', () => {
  it('resolves the Fable 5 1M-context transcript string', () => {
    const e = resolveModel('claude-fable-5[1m]');
    expect(e).not.toBeNull();
    expect(e!.id).toBe('fable-5');
    expect(e!.label).toBe('Fable 5');
    expect(e!.provider).toBe('claude');
    expect(e!.contextWindow).toBe(1_000_000);
  });

  it('resolves a plain opus transcript string', () => {
    const e = resolveModel('claude-opus-4-8');
    expect(e).not.toBeNull();
    expect(e!.id).toBe('opus');
    expect(e!.tier).toBe('frontier');
  });

  it('resolves sonnet and haiku by substring', () => {
    expect(resolveModel('claude-sonnet-4-6')!.id).toBe('sonnet');
    expect(resolveModel('claude-3-5-haiku-20241022')!.id).toBe('haiku');
  });

  it('returns null for an unknown model and NEVER falls back to opus', () => {
    expect(resolveModel('totally-made-up')).toBeNull();
    expect(resolveModel('gpt-9000')).toBeNull();
  });

  it('returns null for null/empty input', () => {
    expect(resolveModel(null)).toBeNull();
    expect(resolveModel('')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(resolveModel('CLAUDE-OPUS-4-8')!.id).toBe('opus');
    expect(resolveModel('Claude-Fable-5[1M]')!.id).toBe('fable-5');
  });
});

describe('model-registry: pricing parity guard (existing analytics must not move)', () => {
  it('opus rates are byte-identical to the legacy hardcoded values', () => {
    expectPerToken(resolveModel('claude-opus-4-8'), PER_MILLION.opus);
  });
  it('sonnet rates are byte-identical', () => {
    expectPerToken(resolveModel('claude-sonnet-4-6'), PER_MILLION.sonnet);
  });
  it('haiku rates are byte-identical', () => {
    expectPerToken(resolveModel('claude-3-5-haiku-20241022'), PER_MILLION.haiku);
  });
  it('Fable 5 inherits frontier (Opus) rates', () => {
    // Fable 5 is a frontier Claude model; until a distinct public rate exists it
    // is priced at the Opus frontier rate so its cost is non-zero (not unpriced).
    expectPerToken(resolveModel('claude-fable-5[1m]'), PER_MILLION.opus);
  });
});

describe('model-registry: provider stubs are seat-only (pricing null)', () => {
  it('gpt-5.5 is registered but unpriced', () => {
    const e = resolveModel('gpt-5.5');
    expect(e).not.toBeNull();
    expect(e!.provider).toBe('codex');
    expect(e!.pricing).toBeNull();
  });
  it('gemini-3-pro is registered but unpriced', () => {
    const e = resolveModel('gemini-3-pro');
    expect(e).not.toBeNull();
    expect(e!.provider).toBe('antigravity');
    expect(e!.pricing).toBeNull();
  });
  it('gemini-flash-2.5 is registered but unpriced and fast-tier', () => {
    const e = resolveModel('gemini-flash-2.5');
    expect(e).not.toBeNull();
    expect(e!.tier).toBe('fast');
    expect(e!.pricing).toBeNull();
  });
  it('UNKNOWN_PRICING_FALLBACK is null (never Opus)', () => {
    expect(UNKNOWN_PRICING_FALLBACK).toBeNull();
  });
});

describe('model-registry: structural invariants', () => {
  it('every entry has a unique id', () => {
    const ids = MODEL_REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('every entry has a positive context window and quota weight', () => {
    for (const e of MODEL_REGISTRY) {
      expect(e.contextWindow).toBeGreaterThan(0);
      expect(e.quotaWeight).toBeGreaterThan(0);
    }
  });
});
```

**Run (expect FAIL — module not found):**

```
npx vitest run tests/shared/agents/model-registry.test.ts
```

**Commit:**

```
test(registry): add failing model-registry spec — Fable 5, parity guard, unknown=null

Co-Authored-By: Claude <noreply@anthropic.com>
```

---

## Task 2 — Implement the registry (GREEN)

**Goal:** Make Task 1 pass. Single source of truth, dependency-free (no `logger` import), pricing per-token.

**Create** `src/shared/agents/model-registry.ts`:

```ts
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

import type { ModelPricing } from './types';

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
const perToken = (perMillion: { input: number; cache_read: number; cache_creation: number; output: number }): ModelPricing => ({
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

  // ── Provider stubs (adapters land in Phase 3). pricing = null = subscription
  //    seat with no public per-token rate yet. NEVER coerced to Opus downstream.
  {
    id: 'gpt-5.5',
    match: (raw) => raw.includes('gpt-5.5') || raw.includes('gpt5.5'),
    label: 'GPT-5.5',
    provider: 'codex',
    tier: 'frontier',
    pricing: null,
    quotaWeight: 5,
    contextWindow: 400_000,
  },
  {
    id: 'gemini-3-pro',
    match: (raw) => raw.includes('gemini-3-pro') || raw.includes('gemini-3.0-pro'),
    label: 'Gemini 3 Pro',
    provider: 'antigravity',
    tier: 'frontier',
    pricing: null,
    quotaWeight: 5,
    contextWindow: 1_000_000,
  },
  {
    id: 'gemini-flash-2.5',
    match: (raw) => raw.includes('gemini-flash-2.5') || raw.includes('gemini-2.5-flash'),
    label: 'Gemini Flash 2.5',
    provider: 'antigravity',
    tier: 'fast',
    pricing: null,
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
```

**Run (expect PASS):**

```
npx vitest run tests/shared/agents/model-registry.test.ts
npm run typecheck
```

**Commit:**

```
feat(registry): single source of truth for model pricing/tier/context

Adds src/shared/agents/model-registry.ts: opus/sonnet/haiku at byte-identical
legacy rates, a Fable 5 entry (1M context, frontier rate), and seat-only stubs
(gpt-5.5/gemini-3-pro/gemini-flash-2.5, pricing null). resolveModel returns null
for unknown — never Opus.

Co-Authored-By: Claude <noreply@anthropic.com>
```

---

## Task 3 — Wire `usage-service.ts` to the registry (refactor, characterization-safe)

**Goal:** Delete the local `MODEL_PRICING` / `getPricing` / `getContextWindow` in `usage-service.ts` and route through the registry. For unknown models: `logger.warn`, cost `0`, keep token counts and a non-null model string. Existing Claude numbers must not move (the registry rates are byte-identical, so `tests/server/analytics-regression.test.ts` and `tests/server/analytics-data-layer.test.ts` are the characterization guard — run them before and after).

**First, run the existing guard to confirm it's green pre-change:**

```
npx vitest run tests/server/analytics-regression.test.ts tests/server/analytics-data-layer.test.ts
```

**Edit** `server/services/usage-service.ts`:

1. Add the import near the top (after the existing `logger` import on line 4):

```ts
import { resolveModel } from '../../src/shared/agents/model-registry';
```

2. **Delete** the entire local pricing block — the `ModelPricing` interface (lines 37–42), the `MODEL_PRICING` const (lines 44–63), `getPricing` (lines 65–72), and `getContextWindow` (lines 74–89). Replace them with registry-backed helpers:

```ts
/**
 * Per-token pricing for a model string, via the single registry.
 * Returns null when the model is unknown OR seat-only (pricing === null).
 * Callers must treat null as "unpriced" (cost 0) — never fall back to Opus.
 */
function getPricing(model: string | null): { input: number; cache_read: number; cache_creation: number; output: number } | null {
  return resolveModel(model)?.pricing ?? null;
}

/**
 * Context window for a model string. Falls back to a 200K default for unknown
 * models, but still respects an observed-tokens override (a session already
 * past 200K tokens is, by definition, a 1M-context session).
 */
function getContextWindow(model: string | null, currentContextTokens: number): number {
  if (currentContextTokens > 200_000) return 1_000_000;
  const entry = resolveModel(model);
  if (entry) return entry.contextWindow;
  // Unknown model: keep the legacy 200K default for the gauge.
  return 200_000;
}
```

3. Update the cost computation in `getSessionUsage` (currently lines 159–165). Replace:

```ts
  const detectedModel = model ?? null;
  const pricing = getPricing(detectedModel);
  const estimatedCostUsd =
    inputTokens * pricing.input +
    cacheReadTokens * pricing.cache_read +
    cacheCreationTokens * pricing.cache_creation +
    outputTokens * pricing.output;
```

with:

```ts
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
```

Everything below (context window, `contextPct`, the returned object with full token counts) is unchanged — token counts are preserved regardless of model. `getContextWindow(detectedModel, currentContext)` now consults the registry but the `currentContextTokens > 200_000` override still wins first, so the existing "1M when over 200K" behavior is preserved.

The `getAllSessionUsageSummaries` path (lines ~280–285) uses the same `getPricing` helper; update its cost block identically:

```ts
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
```

(The summary row's `model: detectedModel` field is already non-null-preserving — it stores whatever was detected, including unknown strings. No change needed there; the row is not dropped.)

**Run (expect PASS — numbers unchanged):**

```
npx vitest run tests/server/analytics-regression.test.ts tests/server/analytics-data-layer.test.ts
npm run typecheck
```

**Commit:**

```
refactor(usage-service): price via model-registry; warn+0 for unknown models

Deletes the local MODEL_PRICING/getPricing/getContextWindow copy. Unknown models
now log a warn and cost 0 (instead of silently pricing as Opus); token counts and
the detected model string are preserved. Claude rates byte-identical — analytics
characterization tests unchanged.

Co-Authored-By: Claude <noreply@anthropic.com>
```

---

## Task 4 — Wire `ingestion-service.ts` to the registry (the table-backed path)

**Goal:** Delete the **duplicate** `MODEL_PRICING` / `getPricing` in `ingestion-service.ts` (this is the path that writes `session_usage`, the table analytics reads). Unknown models: `logger.warn`, `estimated_cost_usd = 0`, **non-null `model` string**, full token counts, row NOT dropped. Existing rows must keep their exact costs (parity).

Note: `ingestion-service.ts` currently imports **no logger**. Add one.

**First, confirm the ingestion guard is green pre-change:**

```
npx vitest run tests/server/analytics-ingestion.test.ts
```

**Edit** `server/services/ingestion-service.ts`:

1. Replace the imports block (lines 1–3) — add the logger and the registry:

```ts
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import logger from '../logger';
import { resolveModel } from '../../src/shared/agents/model-registry';
```

2. **Delete** the local `ModelPricing` interface (lines 5–10), the `MODEL_PRICING` const (lines 12–16), and `getPricing` (lines 18–25). Replace with a single registry-backed helper:

```ts
/** Per-token pricing via the single registry; null = unknown/seat-only (cost 0). */
function getPricing(model: string | null): { input: number; cache_read: number; cache_creation: number; output: number } | null {
  return resolveModel(model)?.pricing ?? null;
}
```

3. Update the cost computation inside `ingestAllSessions` (currently lines 107–112). Replace:

```ts
      const pricing = getPricing(detectedModel);
      const estimatedCostUsd =
        inputTokens * pricing.input +
        cacheReadTokens * pricing.cache_read +
        cacheCreationTokens * pricing.cache_creation +
        outputTokens * pricing.output;
```

with:

```ts
      const pricing = getPricing(detectedModel);
      if (!pricing) {
        logger.warn({ model: detectedModel, sessionId }, 'unknown model — usage uncosted');
      }
      const estimatedCostUsd = pricing
        ? inputTokens * pricing.input +
          cacheReadTokens * pricing.cache_read +
          cacheCreationTokens * pricing.cache_creation +
          outputTokens * pricing.output
        : 0;
```

The `upsert.run(...)` call (lines 118–127) already passes `detectedModel` as the `model` column and the full token counts — so an unknown model is stored with its real model string, full tokens, and `estimated_cost_usd = 0`. The row is **not** dropped (the only `continue` guards are `messageCount === 0` and the idempotency check, both unrelated to pricing). No change needed there.

**Run (expect PASS — costs unchanged for known models):**

```
npx vitest run tests/server/analytics-ingestion.test.ts
npm run typecheck
```

**Commit:**

```
refactor(ingestion-service): price via model-registry; store unknown as cost 0

Deletes the duplicate MODEL_PRICING/getPricing. Unknown models now warn and write
estimated_cost_usd=0 with a non-null model string and full token counts (row kept,
not dropped, not Opus-priced). Known-model costs byte-identical.

Co-Authored-By: Claude <noreply@anthropic.com>
```

---

## Task 5 — Add an ingestion regression: unknown model is stored at cost 0, not dropped

**Goal:** A targeted regression proving the new behavior end-to-end through the table-backed path (the analytics-feeding one). This guards against a future re-introduction of the silent-Opus fallback.

**Edit** `tests/server/analytics-ingestion.test.ts` — add a third fixture file in the existing `beforeAll` of the `Ingestion Service` describe (after `session-beta.jsonl` is written, around line 118):

```ts
    fs.writeFileSync(
      path.join(projectDir, 'session-fable.jsonl'),
      createJsonlContent({
        model: 'claude-fable-5[1m]',
        timestamp: '2026-05-12T09:00:00Z',
        messages: [
          { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 500 },
        ],
      }),
    );

    fs.writeFileSync(
      path.join(projectDir, 'session-unknown.jsonl'),
      createJsonlContent({
        model: 'totally-made-up-model',
        timestamp: '2026-05-13T09:00:00Z',
        messages: [
          { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 500 },
        ],
      }),
    );
```

Then update the row-count assertion in `'ingestAllSessions populates session_usage table'` from `expect(rows.length).toBe(2);` to `expect(rows.length).toBe(4);`.

Add two new `it` blocks inside the same describe (after `'estimated_cost_usd is calculated correctly'`):

```ts
  it('Fable 5 session is priced at the frontier (Opus) rate, not zero', async () => {
    const row = db.prepare('SELECT model, estimated_cost_usd FROM session_usage WHERE session_id = ?').get('session-fable') as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect((row.model as string)).toContain('fable');
    // 1000 input @ $15/M + 500 output @ $75/M = 0.015 + 0.0375 = 0.0525
    expect(row.estimated_cost_usd).toBeCloseTo(0.0525, 4);
  });

  it('unknown model is ingested with cost 0 and a non-null model string (row kept, not Opus-priced)', async () => {
    const row = db.prepare('SELECT model, input_tokens, output_tokens, total_tokens, estimated_cost_usd FROM session_usage WHERE session_id = ?').get('session-unknown') as Record<string, unknown>;
    expect(row).toBeTruthy();                                  // not dropped
    expect(row.model).toBe('totally-made-up-model');           // non-null model preserved
    expect(row.input_tokens).toBe(1000);                        // token counts intact
    expect(row.output_tokens).toBe(500);
    expect(row.total_tokens).toBe(1500);
    expect(row.estimated_cost_usd).toBe(0);                     // uncosted, NOT Opus-priced
  });
```

> Note: the existing `'re-ingestion is idempotent (no duplicates)'` test asserts `count.cnt` equals the file count; update its expectation from `toBe(2)` to `toBe(4)` so it stays consistent with the two new fixtures.

**Run (expect PASS):**

```
npx vitest run tests/server/analytics-ingestion.test.ts
```

**Commit:**

```
test(ingestion): unknown model stored at cost 0 (not dropped, not Opus); Fable 5 priced

Co-Authored-By: Claude <noreply@anthropic.com>
```

---

## Task 6 — Full suite + typecheck green; commit the phase

**Goal:** Prove no regression against the pre-flight baseline.

**Run:**

```
npm test
npm run typecheck
```

Expect: all of `model-registry`, `analytics-ingestion`, `analytics-regression`, `analytics-data-layer`, `analytics-phase2`, `analytics-phase3` green; **0 new failures** vs the pre-flight baseline. Known Claude costs are byte-identical (registry rates equal legacy rates — proven by the parity guard in Task 1 and the unchanged characterization suites).

If any pre-existing-but-now-failing test surfaces, it is either (a) a test that hardcoded the silent-Opus-fallback as correct behavior — fix the test, since the fallback was the bug — or (b) genuine drift; in that case STOP and reconcile per `superpowers:systematic-debugging`.

**Commit (if any residual cleanup):**

```
chore(registry): phase 0A green — single pricing source wired through both services

Co-Authored-By: Claude <noreply@anthropic.com>
```

---

## Self-Review (by plan author)

**Scope coverage (vs the task brief):**
1. ✅ `src/shared/agents/model-registry.ts` is the single source of truth — `ModelEntry` / `ModelTier` / `resolveModel` / `MODEL_REGISTRY` / `UNKNOWN_PRICING_FALLBACK` exactly as the locked contract specifies (Task 2). One entry per known model with `id`, `match`, `label`, `provider`, `tier`, per-token `pricing` (or `null`), `quotaWeight`, `contextWindow`.
2. ✅ Current Claude models at byte-identical existing rates (opus 15/1.5/18.75/75; sonnet 3/0.3/3.75/15; haiku 0.80/0.08/1/4 per M) — enforced by the parity guard test (Task 1) and the unchanged characterization suites (Tasks 3–4, 6).
3. ✅ New **Fable 5** entry: matches `'fable'`, `contextWindow: 1_000_000` (the `[1m]` tag), frontier/Opus rate so it is costed, not zeroed.
4. ✅ Stub entries `gpt-5.5` / `gemini-3-pro` / `gemini-flash-2.5` with `pricing: null`.
5. ✅ `resolveModel(raw)` returns the entry or `null`; NULL never falls back to Opus (asserted explicitly, including `gpt-9000` and case-insensitive inputs).
6. ✅ Both local pricing copies deleted and replaced with registry imports — `usage-service.ts` (Task 3) and `ingestion-service.ts` (Task 4).
7. ✅ Unknown-model behavior: `logger.warn({ model }, 'unknown model — usage uncosted')`, `estimated_cost_usd = 0`, non-null `model` string, full token counts, row not dropped — proven end-to-end by Task 5.
8. ✅ Required tests present (Task 1): `resolveModel('claude-fable-5[1m]')` → fable w/ 1M window; `'claude-opus-4-8'` → opus; `'totally-made-up'` → null; plus the opus/sonnet/haiku rate parity guard.

**TDD discipline:** Every task writes/extends a test that FAILs first (Task 1 fails on missing module; Tasks 3–5 are guarded by run-before/run-after on existing characterization suites), then implements to GREEN, then commits. No placeholders, no "TODO" — every code block is the literal text to write.

**Risks called out inline:**
- *Test project routing* — the registry test runs under jsdom (`tests/shared/**`), so the registry file is kept dependency-free (no Pino import); pre-flight note makes this binding.
- *Parity* — registry rates are computed via the same `perMillion / 1_000_000` arithmetic as the legacy code, so floating-point results are identical; the parity test asserts exact equality (`toBe`), not approximate.
- *Fable pricing choice* — Fable 5 is given the Opus frontier rate (non-zero) rather than `null`, because it is a real metered Claude frontier model, not a subscription-only stub. This is an explicit decision (documented in code + test), not an oversight. If the user later supplies a distinct published Fable rate, it changes exactly one line in the registry.
- *Idempotency-count tests* — Task 5 flags the two existing `toBe(2)` count assertions that must become `toBe(4)` when fixtures are added, so the new fixtures don't silently break them.

**Migrations:** none (registry is code; `session_usage` schema untouched).

**Not in scope (deferred, by design):** rendering the "unpriced model" UI badge (Phase 2 analytics plan consumes this plan's warn+store-0 seam); per-model `byModel` row attribution (`RawUsage.byModel` is the Phase 1 / Delta A plan's job — this plan only guarantees per-model `pricing` lookup is correct and callable); adapter-layer `ModelPricing`/`contextWindowFor` delegation (foundation Tasks 5/6 will import this registry).
