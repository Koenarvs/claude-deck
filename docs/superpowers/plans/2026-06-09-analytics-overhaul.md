# Phase 2 — Analytics Overhaul (billing-aware + per-model) — Implementation Plan

**Date:** 2026-06-09
**Branch context:** `feat/multi-agent-foundation`
**Authoritative source:** `docs/superpowers/plans/2026-06-09-master-roadmap.md` §2 (decisions 1–7) + "Phase 2" brief.
**Style:** bite-sized TDD per `superpowers:writing-plans`. Every task is RED → GREEN → REFACTOR → COMMIT. All code below is real (no `...`, no placeholders).

---

## SPEC PREAMBLE

### Problem

The Analytics page is Claude-only and billing-blind. It shows one undifferentiated "cost" number computed from a silently-Opus-fallback pricing table. It cannot answer the two questions that are the user's core motivation:

- **WORK profile** (Claude via Vertex = metered): "Am I under budget? Which model is burning money?"
- **PERSONAL profile** (subscription seats — Claude/Gemini/ChatGPT): "Is my $200/mo subscription worth it?" (the user observed ~$6k Claude API-equivalent value in 60 days), "Which model can I still afford this window?", and "Am I getting more efficient (less top-tier reliance, lower cost-per-goal) over time?"

Today there is no per-model attribution (a session can mix models via subagents/mid-session switch), no value-multiplier view, no window-utilization estimate, and no efficiency trend. `session_usage` stores one row per session with a single `model` column, so per-model truth is lost at ingestion.

### Decisions (and justifications)

1. **Per-model storage = child table `session_model_usage`, NOT a `by_model_json` column.** Justification: the new endpoints (`model-breakdown`, `model-mix`) aggregate *across sessions, grouped by model and by date-bucket*. A child table lets SQLite do `GROUP BY model` / `GROUP BY session_date, model` with bound params and an index, which is the natural shape for every new endpoint. A JSON column would force per-row `json_each()` unnesting in every query (slower, harder to bind, no index on model). The parent `session_usage` row stays as-is (back-compat — every existing endpoint and the `getSessionUsage` KanbanCard path keep working), and the child rows are the per-model breakdown. Migration **017**.

2. **Dollars are ALWAYS computed from `tokens × registry pricing`** (locked contract). `billingMode` (per-provider, from config) only decides the response `label`: `'cost'` (metered) or `'equivalent_value'` (seat). Never branch the math on billing mode — only the label and which *extra* fields are attached.

3. **Unpriced models are loud, not hidden.** When `resolveModel(raw).pricing === null` (seat-only model with no public per-token rate, e.g. a future Gemini/Codex), the row is stored with `estimated_cost_usd = 0` and `unpriced = 1`, the model string preserved. Endpoints surface an `unpriced` flag; the UI renders an "unpriced" badge. Token counts are always intact.

4. **Value multiplier = equivalent$ ÷ seatPriceUsdMonthly** (locked). Window utilization = `Σ(tokens × quotaWeight)` vs an *estimated* rolling-window cap (locked; labeled "estimate" — no vendor quota API exists). Both are seat-only.

5. **`cost-per-goal` uses the existing goal↔session link.** `sessions.goal_id → goals.id` (migration 001) and `session_usage.session_id` is the same id as `sessions.id` (both are the JSONL session id). A completed goal = `goals.status = 'complete'` with `completed_at` set. Equivalent-$-per-completed-goal = (Σ equivalent$ of that goal's sessions' model rows) ÷ 1, trended by the goal's `completed_at` week.

### Locked contracts consumed (from earlier phases — prerequisites)

- **Phase 0A** `src/shared/agents/model-registry.ts` → `resolveModel(raw): ModelEntry | null` with `{ pricing | null, tier, quotaWeight, contextWindow, label, provider, id }`.
- **Phase 1 Delta A** `RawUsage.byModel: RawModelUsage[]` (per-model rows; `parseUsage()` aggregates them).
- **Phase 1 Delta B** config providers: `ProviderConfig[]`, each `{ id, enabled, billingMode: 'metered' | 'seat', seatPriceUsdMonthly?, budget? }`, read via `ConfigService.getPersisted()`.
- **Billing rule:** dollars = tokens × registry pricing; `billingMode` only labels. Seat multiplier = equivalent$ ÷ seatPriceUsdMonthly. Window utilization = `Σ(tokens × quotaWeight)` vs estimated cap (label estimate).

### Prerequisites (must be built first — note for the executor)

- **Phase 0A** (`model-registry.ts` with `resolveModel`) — endpoints and ingestion import it.
- **Phase 1 Delta B** (`ConfigService.getPersisted()` returning `providers: ProviderConfig[]`) — every endpoint reads provider `billingMode`.
- **Phase 1 Delta A** (`RawUsage.byModel`) — *only* needed by the adapter path; this plan's ingestion writes the child rows directly from the JSONL per-message model, so it does **not** hard-block on Delta A. If Delta A's `parseUsage()` lands first, Task 3 can delegate to it instead of re-parsing; the plan notes that seam.

**Fallback if a prerequisite is missing:** `model-registry.ts` is small and fully specified in the roadmap (Phase 0A). If it is not yet on the branch when this plan executes, build it first via the Phase 0A plan. `ConfigService` arrives with Phase 1; if absent, Task 6 includes a `readProviderConfig(db)` shim that reads the `app_config` single-row table directly (same shape) so the analytics endpoints are not blocked on the full Settings wiring.

### Test layout (locked)

- Server tests: `tests/server/**` (node env).
- Client tests: `tests/client/**` (jsdom env).
- DB tests use `new Database(':memory:')` + `runMigrations(db)` (see `tests/server/analytics-data-layer.test.ts` for the established harness).

### Scope boundary

In scope: migration 017, ingestion per-model write, 5 new `/api/analytics/*` endpoints, AnalyticsPage UI sections, model scorecard (cost/speed/quota now; pass/fail noted as Phase 5 follow-up). Out of scope: the verification gate itself (Phase 5C), provider adapters (Phase 3), budget *enforcement*/pausing (Phase 5E — this plan only *displays* budget vs spend).

---

## TASKS

### Task 1 — Migration 017: `session_model_usage` child table

**RED.** Create `tests/server/db/migrate-017.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';

describe('Migration 017 — session_model_usage', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); runMigrations(db); });
  afterEach(() => { db.close(); });

  it('creates the session_model_usage table', () => {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='session_model_usage'",
    ).get();
    expect(row).toBeTruthy();
  });

  it('has the expected columns', () => {
    const cols = (db.pragma('table_info(session_model_usage)') as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      'session_id', 'model', 'tier', 'provider',
      'input_tokens', 'cache_creation_tokens', 'cache_read_tokens', 'output_tokens',
      'total_tokens', 'estimated_cost_usd', 'unpriced', 'message_count', 'session_date',
      'first_message_at',
    ]));
  });

  it('enforces uniqueness on (session_id, model)', () => {
    const insert = db.prepare(`
      INSERT INTO session_model_usage
        (session_id, model, tier, provider, input_tokens, cache_creation_tokens,
         cache_read_tokens, output_tokens, total_tokens, estimated_cost_usd, unpriced,
         message_count, session_date, first_message_at)
      VALUES (@session_id, @model, @tier, @provider, @in, @cc, @cr, @out, @total, @cost,
              @unpriced, @mc, @date, @first)
    `);
    const row = {
      session_id: 's1', model: 'opus', tier: 'frontier', provider: 'claude',
      in: 100, cc: 10, cr: 20, out: 50, total: 180, cost: 0.5, unpriced: 0,
      mc: 3, date: '2026-06-01', first: Date.now(),
    };
    insert.run(row);
    expect(() => insert.run(row)).toThrow(/UNIQUE/);
  });

  it('records migration version 17', () => {
    const r = db.prepare('SELECT 1 FROM schema_migrations WHERE version = 17').get();
    expect(r).toBeTruthy();
  });
});
```

Run `npm test -- tests/server/db/migrate-017.test.ts` → **FAIL** (no table).

**GREEN.** Create `server/db/migrations/017_session_model_usage.sql`:

```sql
-- Migration 017: per-model usage breakdown (Phase 2 analytics overhaul).
-- One row per (session, model). The parent session_usage row stays as the
-- session-level rollup (back-compat); these rows attribute tokens/cost per model.
CREATE TABLE IF NOT EXISTS session_model_usage (
  session_id TEXT NOT NULL,
  model TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'unknown',
  provider TEXT NOT NULL DEFAULT 'claude',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  unpriced INTEGER NOT NULL DEFAULT 0 CHECK (unpriced IN (0, 1)),
  message_count INTEGER NOT NULL DEFAULT 0,
  session_date TEXT NOT NULL,
  first_message_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, model)
);

CREATE INDEX IF NOT EXISTS idx_smu_model ON session_model_usage (model);
CREATE INDEX IF NOT EXISTS idx_smu_date_model ON session_model_usage (session_date, model);
CREATE INDEX IF NOT EXISTS idx_smu_session ON session_model_usage (session_id);

INSERT OR IGNORE INTO schema_migrations (version) VALUES (17);
```

Run the test → **PASS**.

**COMMIT:** `feat(analytics): migration 017 — session_model_usage child table`

---

### Task 2 — Pricing helper for per-model rows (registry-backed)

The ingestion service will need to compute a per-model cost row from the registry. Add a pure helper next to ingestion so it is unit-testable without filesystem/JSONL.

**RED.** Create `tests/server/services/model-usage-row.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildModelUsageRow } from '../../../server/services/model-usage-row';

const tokens = { input: 1_000_000, cacheCreation: 0, cacheRead: 0, output: 0, messageCount: 4 };

describe('buildModelUsageRow', () => {
  it('prices a known model from the registry (opus input = $15/M)', () => {
    const row = buildModelUsageRow('claude-opus-4-8', tokens, '2026-06-01', 1717200000000);
    expect(row.model).toBe('claude-opus-4-8');
    expect(row.tier).toBe('frontier');
    expect(row.provider).toBe('claude');
    expect(row.unpriced).toBe(0);
    expect(row.estimatedCostUsd).toBeCloseTo(15, 4); // 1M input × $15/M
    expect(row.totalTokens).toBe(1_000_000);
  });

  it('flags unpriced when registry pricing is null (cost 0, model preserved)', () => {
    const row = buildModelUsageRow('gemini-3-pro', tokens, '2026-06-01', 1717200000000);
    expect(row.unpriced).toBe(1);
    expect(row.estimatedCostUsd).toBe(0);
    expect(row.model).toBe('gemini-3-pro');
    expect(row.totalTokens).toBe(1_000_000); // tokens never dropped
  });

  it('flags unpriced for a totally unknown model (resolveModel → null)', () => {
    const row = buildModelUsageRow('totally-made-up', tokens, '2026-06-01', 1717200000000);
    expect(row.unpriced).toBe(1);
    expect(row.estimatedCostUsd).toBe(0);
    expect(row.tier).toBe('unknown');
    expect(row.model).toBe('totally-made-up');
  });

  it('handles a null model string (no detected model)', () => {
    const row = buildModelUsageRow(null, tokens, '2026-06-01', 1717200000000);
    expect(row.unpriced).toBe(1);
    expect(row.model).toBe('unknown');
    expect(row.tier).toBe('unknown');
  });
});
```

Run → **FAIL** (no module).

**GREEN.** Create `server/services/model-usage-row.ts`:

```ts
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
  const totalTokens =
    tokens.input + tokens.cacheCreation + tokens.cacheRead + tokens.output;

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
```

Run → **PASS**.

**COMMIT:** `feat(analytics): registry-backed per-model usage row builder`

---

### Task 3 — Ingestion writes per-model rows

Amend `server/services/ingestion-service.ts` to accumulate tokens **per model** (keyed on the per-message `message.model`, falling back to the session's detected model), and upsert one `session_model_usage` row per model alongside the existing `session_usage` upsert.

**RED.** Create `tests/server/analytics-permodel-ingestion.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/db/migrate';
import { ingestAllSessions } from '../../server/services/ingestion-service';

function line(obj: unknown): string { return JSON.stringify(obj); }

describe('Per-model ingestion → session_model_usage', () => {
  let db: Database.Database;
  let tmp: string;

  beforeAll(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-permodel-'));
    const proj = path.join(tmp, 'proj');
    fs.mkdirSync(proj, { recursive: true });

    // A single session that mixes opus + sonnet (subagent / mid-session switch).
    fs.writeFileSync(path.join(proj, 'mixed.jsonl'), [
      line({ type: 'system', subtype: 'init', model: 'claude-opus-4-8', timestamp: '2026-06-01T10:00:00Z' }),
      line({ timestamp: '2026-06-01T10:00:01Z', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1000, output_tokens: 500 } } }),
      line({ timestamp: '2026-06-01T10:01:00Z', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 2000, output_tokens: 1000 } } }),
    ].join('\n') + '\n');

    await ingestAllSessions(db, tmp);
  });

  afterAll(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  it('writes one parent session_usage row (rollup unchanged)', () => {
    const row = db.prepare('SELECT * FROM session_usage WHERE session_id = ?').get('mixed') as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.input_tokens).toBe(3000);
    expect(row.output_tokens).toBe(1500);
  });

  it('writes one session_model_usage row per model', () => {
    const rows = db.prepare(
      'SELECT model, input_tokens, output_tokens, tier FROM session_model_usage WHERE session_id = ? ORDER BY model',
    ).all('mixed') as Array<{ model: string; input_tokens: number; output_tokens: number; tier: string }>;
    expect(rows.length).toBe(2);
    const opus = rows.find((r) => r.model.includes('opus'))!;
    const sonnet = rows.find((r) => r.model.includes('sonnet'))!;
    expect(opus.input_tokens).toBe(1000);
    expect(opus.output_tokens).toBe(500);
    expect(opus.tier).toBe('frontier');
    expect(sonnet.input_tokens).toBe(2000);
    expect(sonnet.output_tokens).toBe(1000);
    expect(sonnet.tier).toBe('balanced');
  });

  it('parent cost equals the sum of per-model costs', () => {
    const parent = db.prepare('SELECT estimated_cost_usd FROM session_usage WHERE session_id = ?').get('mixed') as { estimated_cost_usd: number };
    const childSum = (db.prepare('SELECT COALESCE(SUM(estimated_cost_usd),0) AS s FROM session_model_usage WHERE session_id = ?').get('mixed') as { s: number }).s;
    expect(parent.estimated_cost_usd).toBeCloseTo(childSum, 4);
  });

  it('re-ingestion does not duplicate per-model rows', async () => {
    await ingestAllSessions(db, tmp);
    const n = (db.prepare('SELECT COUNT(*) AS c FROM session_model_usage WHERE session_id = ?').get('mixed') as { c: number }).c;
    expect(n).toBe(2);
  });
});
```

Run → **FAIL** (no per-model rows written).

**GREEN.** Edit `server/services/ingestion-service.ts`. Replace the local `MODEL_PRICING`/`getPricing` with the registry path, accumulate per-model, and upsert child rows.

1. At the top, replace the local pricing block (lines ~5–25) with:

```ts
import { resolveModel } from '../../src/shared/agents/model-registry';
import { buildModelUsageRow, type ModelTokenInput } from './model-usage-row';

function priceSession(model: string | null, t: ModelTokenInput): number {
  const entry = resolveModel(model);
  if (!entry || entry.pricing === null) return 0;
  const p = entry.pricing;
  return (
    t.input * p.input +
    t.cacheRead * p.cache_read +
    t.cacheCreation * p.cache_creation +
    t.output * p.output
  );
}
```

2. Inside `ingestAllSessions`, add a per-model upsert prepared statement after the existing `upsert`:

```ts
  const upsertModel = db.prepare(`
    INSERT OR REPLACE INTO session_model_usage
      (session_id, model, tier, provider, input_tokens, cache_creation_tokens,
       cache_read_tokens, output_tokens, total_tokens, estimated_cost_usd, unpriced,
       message_count, session_date, first_message_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
```

3. In the per-line loop, accumulate per-model token maps alongside the existing session totals. Replace the loop body's token accumulation with a per-model map (keyed by the message's model, falling back to `detectedModel`):

```ts
      // per-model accumulator: model string -> ModelTokenInput
      const byModel = new Map<string, ModelTokenInput>();

      for (const lineStr of content.split('\n')) {
        if (!lineStr.trim()) continue;
        try {
          const parsed = JSON.parse(lineStr);

          if (!detectedModel) {
            if (parsed?.type === 'system' && parsed?.subtype === 'init' && parsed?.model) {
              detectedModel = parsed.model as string;
            } else if (parsed?.model) {
              detectedModel = parsed.model as string;
            }
          }

          if (parsed?.timestamp) {
            const ts = typeof parsed.timestamp === 'string'
              ? new Date(parsed.timestamp).getTime()
              : parsed.timestamp as number;
            if (!isNaN(ts) && ts > 0) {
              if (firstTimestamp === 0) firstTimestamp = ts;
              lastTimestamp = ts;
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

          // Attribute this message to its own model (subagents / mid-session switch).
          const msgModel = (parsed?.message?.model as string | undefined) ?? detectedModel ?? 'unknown';
          const acc = byModel.get(msgModel) ?? { input: 0, cacheCreation: 0, cacheRead: 0, output: 0, messageCount: 0 };
          acc.input += inp; acc.cacheCreation += cc; acc.cacheRead += cr; acc.output += out; acc.messageCount++;
          byModel.set(msgModel, acc);
        } catch { /* skip malformed lines */ }
      }
```

4. Replace the cost computation (lines ~107–112) so the parent cost is the **sum of per-model costs** (consistent with the child rows):

```ts
      const sessionDate = firstTimestamp > 0
        ? new Date(firstTimestamp).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0];

      let estimatedCostUsd = 0;
      for (const [, t] of byModel) {
        estimatedCostUsd += priceSession(
          // price by the model key; resolveModel handles substring matching
          [...byModel.keys()].find((k) => byModel.get(k) === t) ?? detectedModel,
          t,
        );
      }
```

   > Simpler and clearer — iterate entries directly:

```ts
      let estimatedCostUsd = 0;
      for (const [model, t] of byModel) {
        estimatedCostUsd += priceSession(model, t);
      }
```

5. After the existing parent `upsert.run(...)`, write the child rows inside the same loop iteration:

```ts
      for (const [model, t] of byModel) {
        const r = buildModelUsageRow(model, t, sessionDate, firstTimestamp || Date.now());
        upsertModel.run(
          sessionId, r.model, r.tier, r.provider,
          r.inputTokens, r.cacheCreationTokens, r.cacheReadTokens, r.outputTokens,
          r.totalTokens, r.estimatedCostUsd, r.unpriced, r.messageCount,
          r.sessionDate, r.firstMessageAt,
        );
      }
```

Run the new test + the existing `tests/server/analytics-ingestion.test.ts` → **PASS** (existing Claude numbers unchanged: opus/sonnet/haiku rates are byte-identical in the registry per Phase 0A).

**COMMIT:** `feat(analytics): ingestion writes per-model session_model_usage rows`

---

### Task 4 — Analytics SQL service (bound params, pure functions)

Put the new query logic in a testable service that takes a `Database` and returns plain objects. Endpoints (Task 6) are thin wrappers. All SQL uses **bound parameters** (no string interpolation of `days`).

**RED.** Create `tests/server/services/analytics-model-service.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';
import {
  getModelBreakdown, getModelMix, getCostPerGoal,
} from '../../../server/services/analytics-model-service';

const DAY = 86_400_000;
function daysAgo(n: number): number { return Date.now() - n * DAY; }
function dateOf(n: number): string { return new Date(daysAgo(n)).toISOString().split('T')[0]; }

function seedModelRow(db: Database.Database, r: {
  session: string; model: string; tier: string; provider?: string;
  input: number; output: number; cost: number; unpriced?: 0 | 1; daysAgo: number;
}): void {
  db.prepare(`
    INSERT OR REPLACE INTO session_model_usage
      (session_id, model, tier, provider, input_tokens, cache_creation_tokens,
       cache_read_tokens, output_tokens, total_tokens, estimated_cost_usd, unpriced,
       message_count, session_date, first_message_at)
    VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    r.session, r.model, r.tier, r.provider ?? 'claude',
    r.input, r.output, r.input + r.output, r.cost, r.unpriced ?? 0,
    dateOf(r.daysAgo), daysAgo(r.daysAgo),
  );
}

describe('analytics-model-service', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    seedModelRow(db, { session: 's1', model: 'claude-opus-4-8', tier: 'frontier', input: 1000, output: 500, cost: 1.0, daysAgo: 2 });
    seedModelRow(db, { session: 's1', model: 'claude-sonnet-4-6', tier: 'balanced', input: 4000, output: 2000, cost: 0.5, daysAgo: 2 });
    seedModelRow(db, { session: 's2', model: 'claude-opus-4-8', tier: 'frontier', input: 1000, output: 500, cost: 1.0, daysAgo: 40 });
    seedModelRow(db, { session: 's3', model: 'gemini-3-pro', tier: 'frontier', input: 9000, output: 0, cost: 0, unpriced: 1, daysAgo: 1 });
  });
  afterEach(() => { db.close(); });

  describe('getModelBreakdown', () => {
    it('groups by model within the window and computes share + effective rate', () => {
      const rows = getModelBreakdown(db, 30);
      const opus = rows.find((r) => r.model.includes('opus'))!;
      const sonnet = rows.find((r) => r.model.includes('sonnet'))!;
      expect(rows.find((r) => r.model.includes('gemini'))).toBeTruthy(); // unpriced still listed
      // window=30 excludes s2 (40d). opus: in1000/out500 cost1.0; sonnet: in4000/out2000 cost0.5
      expect(opus.equivalentUsd).toBeCloseTo(1.0, 4);
      expect(opus.tier).toBe('frontier');
      // effective rate = cost / total tokens
      expect(opus.effectiveRatePerMTok).toBeCloseTo(1.0 / ((1500) / 1_000_000), 0);
      // share by equivalentUsd sums to 1 across priced+unpriced
      const totalShare = rows.reduce((s, r) => s + r.share, 0);
      expect(totalShare).toBeCloseTo(1, 4);
    });

    it('marks unpriced models', () => {
      const gemini = getModelBreakdown(db, 30).find((r) => r.model.includes('gemini'))!;
      expect(gemini.unpriced).toBe(true);
      expect(gemini.equivalentUsd).toBe(0);
    });

    it('days=0 includes all-time rows', () => {
      expect(getModelBreakdown(db, 0).reduce((s, r) => s + r.tokensIn + r.tokensOut, 0))
        .toBeGreaterThan(getModelBreakdown(db, 30).reduce((s, r) => s + r.tokensIn + r.tokensOut, 0));
    });
  });

  describe('getModelMix', () => {
    it('returns per-date buckets with per-model token shares and a topTierShare', () => {
      const series = getModelMix(db, 30, 'day');
      expect(Array.isArray(series)).toBe(true);
      const today = series.find((b) => b.date === dateOf(1))!;
      // only gemini (frontier, unpriced) on day -1 → topTierShare = 1
      expect(today.topTierShare).toBeCloseTo(1, 4);
      const twoDaysAgo = series.find((b) => b.date === dateOf(2))!;
      // opus(frontier) tokens 1500 + sonnet(balanced) 6000 → topTier = 1500/7500 = 0.2
      expect(twoDaysAgo.topTierShare).toBeCloseTo(1500 / 7500, 4);
      expect(twoDaysAgo.models['claude-opus-4-8']).toBeGreaterThan(0);
    });
  });

  describe('getCostPerGoal', () => {
    it('trends equivalent-$ per completed goal by completion week', () => {
      // link s1 to a completed goal
      db.prepare(`INSERT INTO goals (id, title, cwd, status, kanban_order, created_at, updated_at, completed_at)
                  VALUES ('g1','G','/x','complete', 1, ?, ?, ?)`).run(daysAgo(2), daysAgo(2), daysAgo(2));
      db.prepare(`INSERT INTO sessions (id, goal_id, origin, started_at) VALUES ('s1','g1','dashboard', ?)`).run(daysAgo(2));
      const series = getCostPerGoal(db, 30);
      expect(series.length).toBeGreaterThan(0);
      const point = series[0];
      expect(typeof point.date).toBe('string');
      // g1 cost = opus 1.0 + sonnet 0.5 = 1.5 over 1 completed goal
      expect(point.equivalentUsdPerGoal).toBeCloseTo(1.5, 4);
      expect(point.completedGoals).toBe(1);
    });
  });
});
```

Run → **FAIL** (no service).

**GREEN.** Create `server/services/analytics-model-service.ts`:

```ts
import type Database from 'better-sqlite3';

function windowStart(days: number): number {
  return days > 0 ? Date.now() - days * 86_400_000 : 0;
}

export interface ModelBreakdownRow {
  model: string;
  tier: string;
  provider: string;
  tokensIn: number;   // input + cache_creation + cache_read
  tokensOut: number;  // output
  equivalentUsd: number;
  effectiveRatePerMTok: number; // equivalentUsd per 1M total tokens (0 when unpriced/empty)
  share: number;      // share of total equivalentUsd across all models (0..1)
  unpriced: boolean;
}

export function getModelBreakdown(db: Database.Database, days: number): ModelBreakdownRow[] {
  const since = windowStart(days);
  const rows = db.prepare(`
    SELECT model,
      MAX(tier) AS tier,
      MAX(provider) AS provider,
      COALESCE(SUM(input_tokens + cache_creation_tokens + cache_read_tokens), 0) AS tokensIn,
      COALESCE(SUM(output_tokens), 0) AS tokensOut,
      COALESCE(SUM(estimated_cost_usd), 0) AS equivalentUsd,
      MAX(unpriced) AS unpriced
    FROM session_model_usage
    WHERE first_message_at > ?
    GROUP BY model
    ORDER BY equivalentUsd DESC, tokensIn DESC
  `).all(since) as Array<{
    model: string; tier: string; provider: string;
    tokensIn: number; tokensOut: number; equivalentUsd: number; unpriced: number;
  }>;

  const totalUsd = rows.reduce((s, r) => s + r.equivalentUsd, 0);

  return rows.map((r) => {
    const totalTokens = r.tokensIn + r.tokensOut;
    return {
      model: r.model,
      tier: r.tier,
      provider: r.provider,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
      equivalentUsd: Math.round(r.equivalentUsd * 10000) / 10000,
      effectiveRatePerMTok: totalTokens > 0 ? (r.equivalentUsd / totalTokens) * 1_000_000 : 0,
      share: totalUsd > 0 ? r.equivalentUsd / totalUsd : 0,
      unpriced: r.unpriced === 1,
    };
  });
}

export interface ModelMixBucket {
  date: string;
  models: Record<string, number>; // model -> total tokens that day
  topTierShare: number;           // frontier tokens / all tokens that day (0..1)
}

export function getModelMix(db: Database.Database, days: number, bucket: 'day' = 'day'): ModelMixBucket[] {
  const since = windowStart(days);
  void bucket; // only 'day' supported today; param reserved for week/month later
  const rows = db.prepare(`
    SELECT session_date AS date, model, tier,
      COALESCE(SUM(total_tokens), 0) AS tokens
    FROM session_model_usage
    WHERE first_message_at > ?
    GROUP BY session_date, model
    ORDER BY session_date
  `).all(since) as Array<{ date: string; model: string; tier: string; tokens: number }>;

  const byDate = new Map<string, { models: Record<string, number>; frontier: number; total: number }>();
  for (const r of rows) {
    const b = byDate.get(r.date) ?? { models: {}, frontier: 0, total: 0 };
    b.models[r.model] = (b.models[r.model] ?? 0) + r.tokens;
    b.total += r.tokens;
    if (r.tier === 'frontier') b.frontier += r.tokens;
    byDate.set(r.date, b);
  }

  return [...byDate.entries()]
    .map(([date, b]) => ({
      date,
      models: b.models,
      topTierShare: b.total > 0 ? b.frontier / b.total : 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export interface CostPerGoalPoint {
  date: string;          // ISO week-start date
  equivalentUsdPerGoal: number;
  completedGoals: number;
}

export function getCostPerGoal(db: Database.Database, days: number): CostPerGoalPoint[] {
  const since = windowStart(days);
  // Equivalent$ per goal = sum of the goal's sessions' per-model cost,
  // grouped by the goal's completion week. Only completed goals count.
  const rows = db.prepare(`
    SELECT g.id AS goal_id, g.completed_at AS completed_at,
      COALESCE(SUM(smu.estimated_cost_usd), 0) AS usd
    FROM goals g
    JOIN sessions s ON s.goal_id = g.id
    JOIN session_model_usage smu ON smu.session_id = s.id
    WHERE g.status = 'complete' AND g.completed_at IS NOT NULL AND g.completed_at > ?
    GROUP BY g.id
  `).all(since) as Array<{ goal_id: string; completed_at: number; usd: number }>;

  const byWeek = new Map<string, { usd: number; goals: number }>();
  for (const r of rows) {
    const d = new Date(r.completed_at);
    d.setDate(d.getDate() - d.getDay()); // week start (Sunday)
    const week = d.toISOString().split('T')[0];
    const acc = byWeek.get(week) ?? { usd: 0, goals: 0 };
    acc.usd += r.usd;
    acc.goals += 1;
    byWeek.set(week, acc);
  }

  return [...byWeek.entries()]
    .map(([date, v]) => ({
      date,
      equivalentUsdPerGoal: v.goals > 0 ? Math.round((v.usd / v.goals) * 10000) / 10000 : 0,
      completedGoals: v.goals,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
```

Run → **PASS**.

**COMMIT:** `feat(analytics): model-breakdown/model-mix/cost-per-goal SQL service`

---

### Task 5 — Value + window-utilization service (config-aware)

These two endpoints need provider config (`billingMode`, `seatPriceUsdMonthly`, `budget`). Put the config-aware logic in a second service so it is unit-testable with an injected config object (no ConfigService dependency in the test).

**RED.** Create `tests/server/services/analytics-value-service.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';
import { getProviderValue, getWindowUtilization } from '../../../server/services/analytics-value-service';
import type { ProviderConfig } from '../../../src/shared/agents/provider-config';

const DAY = 86_400_000;
function daysAgo(n: number): number { return Date.now() - n * DAY; }
function dateOf(n: number): string { return new Date(daysAgo(n)).toISOString().split('T')[0]; }

function seed(db: Database.Database, r: { model: string; tier: string; provider: string; total: number; cost: number; daysAgo: number }): void {
  db.prepare(`INSERT OR REPLACE INTO session_model_usage
      (session_id, model, tier, provider, input_tokens, cache_creation_tokens, cache_read_tokens,
       output_tokens, total_tokens, estimated_cost_usd, unpriced, message_count, session_date, first_message_at)
      VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?, 0, 1, ?, ?)`)
    .run(`sess-${r.model}-${r.daysAgo}`, r.model, r.tier, r.provider, r.total, r.total, r.cost, dateOf(r.daysAgo), daysAgo(r.daysAgo));
}

describe('analytics-value-service', () => {
  let db: Database.Database;
  const providers: ProviderConfig[] = [
    { id: 'claude', enabled: true, billingMode: 'seat', seatPriceUsdMonthly: 200 },
    { id: 'antigravity', enabled: true, billingMode: 'metered', budget: { monthlyUsd: 500 } },
  ];

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    seed(db, { model: 'claude-opus-4-8', tier: 'frontier', provider: 'claude', total: 1_000_000, cost: 6000, daysAgo: 5 });
    seed(db, { model: 'gemini-3-pro', tier: 'frontier', provider: 'antigravity', total: 500_000, cost: 250, daysAgo: 5 });
  });
  afterEach(() => { db.close(); });

  it('seat provider gets equivalent_value label + value multiplier', () => {
    const rows = getProviderValue(db, 30, providers);
    const claude = rows.find((r) => r.provider === 'claude')!;
    expect(claude.label).toBe('equivalent_value');
    expect(claude.equivalentUsd).toBeCloseTo(6000, 2);
    expect(claude.seatPriceUsdMonthly).toBe(200);
    expect(claude.valueMultiplier).toBeCloseTo(6000 / 200, 4); // ~30x — the "steal" view
    expect(claude.budgetUsd).toBeUndefined();
  });

  it('metered provider gets cost label + budget vs spend (no multiplier)', () => {
    const ag = getProviderValue(db, 30, providers).find((r) => r.provider === 'antigravity')!;
    expect(ag.label).toBe('cost');
    expect(ag.equivalentUsd).toBeCloseTo(250, 2);
    expect(ag.budgetUsd).toBe(500);
    expect(ag.valueMultiplier).toBeUndefined();
  });

  it('window utilization is seat-only and labeled estimate', () => {
    const util = getWindowUtilization(db, providers);
    const claude = util.find((u) => u.provider === 'claude')!;
    expect(claude.isEstimate).toBe(true);
    // weighted units = total_tokens × quotaWeight (frontier opus weight from registry)
    expect(claude.weightedUnits).toBeGreaterThan(0);
    expect(claude.estimatedWindowCap).toBeGreaterThan(0);
    expect(claude.utilizationPct).toBeGreaterThanOrEqual(0);
    // metered antigravity excluded from window utilization
    expect(util.find((u) => u.provider === 'antigravity')).toBeUndefined();
  });
});
```

Also create a tiny shared type so both server and tests agree (this is the Phase 1 Delta B shape; defined here if not already present):

**GREEN — Part A.** Create `src/shared/agents/provider-config.ts` (only if Phase 1 has not already created it; if it has, import from there and delete this file):

```ts
export type BillingMode = 'metered' | 'seat';

export interface ProviderBudget {
  dailyUsd?: number;
  monthlyUsd?: number;
  perGoalUsd?: number;
}

export interface ProviderConfig {
  id: string;
  enabled: boolean;
  billingMode: BillingMode;
  seatPriceUsdMonthly?: number;
  budget?: ProviderBudget;
}
```

> **Prerequisite note:** Phase 1 Delta B owns `ProviderConfig`. If it already exports this exact shape (from `src/shared/schemas.ts` or a `provider-config.ts`), import it and do not duplicate. This file is the fallback so Phase 2 is not blocked.

**GREEN — Part B.** Create `server/services/analytics-value-service.ts`:

```ts
import type Database from 'better-sqlite3';
import { resolveModel } from '../../src/shared/agents/model-registry';
import type { ProviderConfig } from '../../src/shared/agents/provider-config';

function windowStart(days: number): number {
  return days > 0 ? Date.now() - days * 86_400_000 : 0;
}

export interface ProviderValueRow {
  provider: string;
  label: 'cost' | 'equivalent_value';
  equivalentUsd: number;            // tokens × registry pricing (always computed)
  seatPriceUsdMonthly?: number;     // seat only
  valueMultiplier?: number;         // seat only: equivalentUsd ÷ seatPriceUsdMonthly
  budgetUsd?: number;               // metered only: monthly budget cap
}

export function getProviderValue(db: Database.Database, days: number, providers: ProviderConfig[]): ProviderValueRow[] {
  const since = windowStart(days);
  const rows = db.prepare(`
    SELECT provider, COALESCE(SUM(estimated_cost_usd), 0) AS usd
    FROM session_model_usage
    WHERE first_message_at > ?
    GROUP BY provider
  `).all(since) as Array<{ provider: string; usd: number }>;
  const usdByProvider = new Map(rows.map((r) => [r.provider, r.usd]));

  return providers.filter((p) => p.enabled).map((p) => {
    const equivalentUsd = Math.round((usdByProvider.get(p.id) ?? 0) * 10000) / 10000;
    if (p.billingMode === 'seat') {
      const seat = p.seatPriceUsdMonthly;
      return {
        provider: p.id,
        label: 'equivalent_value',
        equivalentUsd,
        seatPriceUsdMonthly: seat,
        valueMultiplier: seat && seat > 0 ? Math.round((equivalentUsd / seat) * 100) / 100 : undefined,
      };
    }
    return {
      provider: p.id,
      label: 'cost',
      equivalentUsd,
      budgetUsd: p.budget?.monthlyUsd,
    };
  });
}

export interface WindowUtilizationRow {
  provider: string;
  weightedUnits: number;        // Σ(tokens × quotaWeight)
  estimatedWindowCap: number;   // heuristic cap (NOT a vendor figure)
  utilizationPct: number;       // weightedUnits / cap × 100, clamped 0..100
  isEstimate: true;
}

/**
 * Quota-weighted consumption over the provider's rolling window (5-hour default
 * for subscription seats) vs an ESTIMATED cap. No vendor quota API exists — the
 * cap is a heuristic and every row is flagged isEstimate.
 */
export function getWindowUtilization(db: Database.Database, providers: ProviderConfig[]): WindowUtilizationRow[] {
  const ROLLING_WINDOW_MS = 5 * 60 * 60 * 1000; // 5h subscription window
  const ESTIMATED_WINDOW_CAP_UNITS = 2_000_000; // heuristic weighted-token cap per window
  const since = Date.now() - ROLLING_WINDOW_MS;

  const seatProviders = providers.filter((p) => p.enabled && p.billingMode === 'seat');
  const out: WindowUtilizationRow[] = [];

  for (const p of seatProviders) {
    const modelRows = db.prepare(`
      SELECT model, COALESCE(SUM(total_tokens), 0) AS tokens
      FROM session_model_usage
      WHERE provider = ? AND first_message_at > ?
      GROUP BY model
    `).all(p.id, since) as Array<{ model: string; tokens: number }>;

    let weighted = 0;
    for (const r of modelRows) {
      const entry = resolveModel(r.model);
      const weight = entry?.quotaWeight ?? 1;
      weighted += r.tokens * weight;
    }
    out.push({
      provider: p.id,
      weightedUnits: Math.round(weighted),
      estimatedWindowCap: ESTIMATED_WINDOW_CAP_UNITS,
      utilizationPct: Math.min(100, Math.round((weighted / ESTIMATED_WINDOW_CAP_UNITS) * 1000) / 10),
      isEstimate: true,
    });
  }
  return out;
}
```

Run → **PASS**.

**COMMIT:** `feat(analytics): provider value + window-utilization service`

---

### Task 6 — Wire the 5 endpoints into the system router

Add `model-breakdown`, `model-mix`, `value`, `window-utilization`, `cost-per-goal` to `server/routes/system.ts`. The router needs provider config; inject it via a `getProviders` callback to keep the router decoupled from ConfigService (mirrors the `skillDirService` injection precedent). Each response is decorated with `label` from the provider's `billingMode`.

**RED.** Create `tests/server/routes/analytics-overhaul.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import Database from 'better-sqlite3';
import { createApp } from '../../../server/app';
import { createSystemRouter } from '../../../server/routes/system';
import { runMigrations } from '../../../server/db/migrate';
import type { ProviderConfig } from '../../../src/shared/agents/provider-config';

const DAY = 86_400_000;
function daysAgo(n: number): number { return Date.now() - n * DAY; }
function dateOf(n: number): string { return new Date(daysAgo(n)).toISOString().split('T')[0]; }

let server: http.Server;
let port: number;
let db: Database.Database;

const PROVIDERS: ProviderConfig[] = [
  { id: 'claude', enabled: true, billingMode: 'seat', seatPriceUsdMonthly: 200 },
];

beforeAll(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const ins = db.prepare(`INSERT OR REPLACE INTO session_model_usage
      (session_id, model, tier, provider, input_tokens, cache_creation_tokens, cache_read_tokens,
       output_tokens, total_tokens, estimated_cost_usd, unpriced, message_count, session_date, first_message_at)
      VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, 1, ?, ?)`);
  ins.run('s1', 'claude-opus-4-8', 'frontier', 'claude', 1000, 500, 1500, 1.0, 0, dateOf(2), daysAgo(2));
  ins.run('s1', 'claude-sonnet-4-6', 'balanced', 'claude', 4000, 2000, 6000, 0.5, 0, dateOf(2), daysAgo(2));
  ins.run('s2', 'gemini-3-pro', 'frontier', 'antigravity', 9000, 0, 9000, 0, 1, dateOf(1), daysAgo(1));

  const router = createSystemRouter(undefined, () => PROVIDERS);
  const app = createApp({ apiRouters: [router] });
  (app as unknown as { locals: { db: Database.Database } }).locals.db = db;
  server = http.createServer(app);
  port = await new Promise<number>((resolve) => server.listen(0, () => {
    const a = server.address(); if (a && typeof a === 'object') resolve(a.port);
  }));
});

afterAll(() => { server.close(); db.close(); });

const base = () => `http://127.0.0.1:${port}/api/analytics`;

describe('GET /api/analytics/model-breakdown', () => {
  it('returns per-model rows with label from billingMode', async () => {
    const res = await fetch(`${base()}/model-breakdown?days=30`);
    expect(res.status).toBe(200);
    const body = await res.json() as { label: string; models: Array<{ model: string; unpriced: boolean }> };
    expect(body.label).toBe('equivalent_value'); // claude seat
    const gemini = body.models.find((m) => m.model.includes('gemini'));
    expect(gemini?.unpriced).toBe(true); // unpriced surfaced, not hidden
  });
});

describe('GET /api/analytics/model-mix', () => {
  it('returns date buckets with topTierShare', async () => {
    const res = await fetch(`${base()}/model-mix?days=30&bucket=day`);
    expect(res.status).toBe(200);
    const body = await res.json() as { label: string; series: Array<{ date: string; topTierShare: number }> };
    expect(Array.isArray(body.series)).toBe(true);
    expect(body.series.every((b) => b.topTierShare >= 0 && b.topTierShare <= 1)).toBe(true);
  });
});

describe('GET /api/analytics/value', () => {
  it('returns seat provider with value multiplier', async () => {
    const res = await fetch(`${base()}/value?days=30`);
    const body = await res.json() as { providers: Array<{ provider: string; label: string; valueMultiplier?: number }> };
    const claude = body.providers.find((p) => p.provider === 'claude')!;
    expect(claude.label).toBe('equivalent_value');
    expect(claude.valueMultiplier).toBeGreaterThan(0);
  });
});

describe('GET /api/analytics/window-utilization', () => {
  it('returns seat-only rows flagged as estimate', async () => {
    const res = await fetch(`${base()}/window-utilization`);
    const body = await res.json() as { rows: Array<{ provider: string; isEstimate: boolean }> };
    expect(body.rows.every((r) => r.isEstimate === true)).toBe(true);
  });
});

describe('GET /api/analytics/cost-per-goal', () => {
  it('returns a trend array (empty allowed when no completed goals)', async () => {
    const res = await fetch(`${base()}/cost-per-goal?days=30`);
    expect(res.status).toBe(200);
    const body = await res.json() as { label: string; series: unknown[] };
    expect(Array.isArray(body.series)).toBe(true);
  });
});

describe('graceful degradation', () => {
  it('returns empty shapes (not 500) when session_model_usage is empty', async () => {
    const db2 = new Database(':memory:');
    runMigrations(db2);
    const router = createSystemRouter(undefined, () => PROVIDERS);
    const app2 = createApp({ apiRouters: [router] });
    (app2 as unknown as { locals: { db: Database.Database } }).locals.db = db2;
    const s2 = http.createServer(app2);
    const p2 = await new Promise<number>((r) => s2.listen(0, () => {
      const a = s2.address(); if (a && typeof a === 'object') r(a.port);
    }));
    const res = await fetch(`http://127.0.0.1:${p2}/api/analytics/model-breakdown?days=30`);
    expect(res.status).toBe(200);
    const body = await res.json() as { models: unknown[] };
    expect(body.models).toEqual([]);
    s2.close(); db2.close();
  });
});
```

Run → **FAIL** (router has no second param / no endpoints).

**GREEN.** Edit `server/routes/system.ts`:

1. Add imports at the top:

```ts
import {
  getModelBreakdown, getModelMix, getCostPerGoal,
} from '../services/analytics-model-service';
import { getProviderValue, getWindowUtilization } from '../services/analytics-value-service';
import type { ProviderConfig } from '../../src/shared/agents/provider-config';
```

2. Change the factory signature and add a default provider list helper:

```ts
export function createSystemRouter(
  skillDirService?: SkillDirectoryService,
  getProviders: () => ProviderConfig[] = () => [{ id: 'claude', enabled: true, billingMode: 'seat' }],
): Router {
```

3. Add a small helper near the top of the function body to pick the "primary" billing label for endpoints that report a single label (breakdown/mix/cost-per-goal report the dominant enabled provider's mode — Claude is always present and enabled):

```ts
  function primaryLabel(): 'cost' | 'equivalent_value' {
    const enabled = getProviders().filter((p) => p.enabled);
    const anyMetered = enabled.some((p) => p.billingMode === 'metered');
    // If the install is metered-anywhere (work profile), label as cost; else equivalent_value.
    return anyMetered ? 'cost' : 'equivalent_value';
  }
```

4. Add the five route handlers (place them with the other `/analytics/*` routes):

```ts
  /** GET /api/analytics/model-breakdown?days=N */
  router.get('/analytics/model-breakdown', (req, res) => {
    try {
      const db = (req.app as unknown as { locals: { db: import('better-sqlite3').Database } }).locals?.db;
      if (!db) { res.json({ label: primaryLabel(), models: [] }); return; }
      const days = Math.max(0, Number(req.query['days'] ?? 30));
      res.json({ label: primaryLabel(), models: getModelBreakdown(db, days) });
    } catch (err) {
      logger.error({ err: String(err) }, 'model-breakdown failed');
      res.json({ label: 'equivalent_value', models: [] });
    }
  });

  /** GET /api/analytics/model-mix?days=N&bucket=day */
  router.get('/analytics/model-mix', (req, res) => {
    try {
      const db = (req.app as unknown as { locals: { db: import('better-sqlite3').Database } }).locals?.db;
      if (!db) { res.json({ label: primaryLabel(), series: [] }); return; }
      const days = Math.max(0, Number(req.query['days'] ?? 30));
      res.json({ label: primaryLabel(), series: getModelMix(db, days, 'day') });
    } catch (err) {
      logger.error({ err: String(err) }, 'model-mix failed');
      res.json({ label: 'equivalent_value', series: [] });
    }
  });

  /** GET /api/analytics/value?days=N */
  router.get('/analytics/value', (req, res) => {
    try {
      const db = (req.app as unknown as { locals: { db: import('better-sqlite3').Database } }).locals?.db;
      if (!db) { res.json({ providers: [] }); return; }
      const days = Math.max(0, Number(req.query['days'] ?? 30));
      res.json({ providers: getProviderValue(db, days, getProviders()) });
    } catch (err) {
      logger.error({ err: String(err) }, 'value failed');
      res.json({ providers: [] });
    }
  });

  /** GET /api/analytics/window-utilization (seat only) */
  router.get('/analytics/window-utilization', (req, res) => {
    try {
      const db = (req.app as unknown as { locals: { db: import('better-sqlite3').Database } }).locals?.db;
      if (!db) { res.json({ rows: [] }); return; }
      res.json({ rows: getWindowUtilization(db, getProviders()) });
    } catch (err) {
      logger.error({ err: String(err) }, 'window-utilization failed');
      res.json({ rows: [] });
    }
  });

  /** GET /api/analytics/cost-per-goal?days=N */
  router.get('/analytics/cost-per-goal', (req, res) => {
    try {
      const db = (req.app as unknown as { locals: { db: import('better-sqlite3').Database } }).locals?.db;
      if (!db) { res.json({ label: primaryLabel(), series: [] }); return; }
      const days = Math.max(0, Number(req.query['days'] ?? 30));
      res.json({ label: primaryLabel(), series: getCostPerGoal(db, days) });
    } catch (err) {
      logger.error({ err: String(err) }, 'cost-per-goal failed');
      res.json({ label: 'equivalent_value', series: [] });
    }
  });
```

Run the new test + existing `tests/server/analytics-data-layer.test.ts` (calls `createSystemRouter()` with no args — the new optional param keeps it working) → **PASS**.

**COMMIT:** `feat(analytics): 5 billing-aware per-model endpoints`

---

### Task 7 — Wire provider config into `server/index.ts`

Connect the real provider config to the router. Read it from `ConfigService.getPersisted().providers` if present; otherwise use the single-claude-seat default.

**RED.** Extend `tests/server/routes/analytics-overhaul.test.ts` with a wiring assertion (add to the existing file):

```ts
describe('createSystemRouter provider injection', () => {
  it('defaults to a single claude seat provider when no getProviders passed', async () => {
    const db3 = new Database(':memory:');
    runMigrations(db3);
    db3.prepare(`INSERT OR REPLACE INTO session_model_usage
      (session_id, model, tier, provider, input_tokens, cache_creation_tokens, cache_read_tokens,
       output_tokens, total_tokens, estimated_cost_usd, unpriced, message_count, session_date, first_message_at)
      VALUES ('sx','claude-opus-4-8','frontier','claude',1000,0,0,0,1000,1.0,0,1,?,?)`)
      .run(dateOf(1), daysAgo(1));
    const router = createSystemRouter(); // no provider callback
    const app3 = createApp({ apiRouters: [router] });
    (app3 as unknown as { locals: { db: Database.Database } }).locals.db = db3;
    const s3 = http.createServer(app3);
    const p3 = await new Promise<number>((r) => s3.listen(0, () => {
      const a = s3.address(); if (a && typeof a === 'object') r(a.port);
    }));
    const res = await fetch(`http://127.0.0.1:${p3}/api/analytics/value?days=30`);
    const body = await res.json() as { providers: Array<{ provider: string; label: string }> };
    expect(body.providers[0].provider).toBe('claude');
    expect(body.providers[0].label).toBe('equivalent_value');
    s3.close(); db3.close();
  });
});
```

Run → **PASS already** (the default param covers it — this locks the contract). If it fails, the default param in Task 6 is wrong; fix there.

**GREEN.** Edit `server/index.ts` at the router-construction site (line ~292). Replace:

```ts
const systemRouterWithSkills = createSystemRouter(skillDirectoryService);
```

with config-aware injection:

```ts
// Provider config drives billing labels in analytics. Read from persisted config
// when available (Phase 1 ConfigService); fall back to a single Claude seat.
function getProviders(): import('../src/shared/agents/provider-config').ProviderConfig[] {
  try {
    const row = db.prepare('SELECT config_json FROM app_config WHERE id = 1').get() as { config_json: string } | undefined;
    if (row?.config_json) {
      const parsed = JSON.parse(row.config_json) as { providers?: import('../src/shared/agents/provider-config').ProviderConfig[] };
      if (Array.isArray(parsed.providers) && parsed.providers.length > 0) return parsed.providers;
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'provider config read failed; using default');
  }
  return [{ id: 'claude', enabled: true, billingMode: 'seat' }];
}
const systemRouterWithSkills = createSystemRouter(skillDirectoryService, getProviders);
```

> **Note:** this reads `app_config` directly (the single-row table from migration 015) so it works whether or not the full `ConfigService` is wired. When Phase 1's `ConfigService` lands, swap the body for `configService.getPersisted().providers`. The shape is identical.

Run `npm test -- tests/server/routes/analytics-overhaul.test.ts` and a server smoke (`npm run typecheck`) → **PASS**.

**COMMIT:** `feat(analytics): inject persisted provider config into system router`

---

### Task 8 — UI: client API types + fetch hook with AbortController

Before touching `AnalyticsPage.tsx`, add typed fetch helpers with a per-`timeRange` `AbortController` (the review-flagged fetch-race fix). Keep them in a small module so the page stays readable and the helpers are unit-testable.

**RED.** Create `tests/client/lib/analytics-api.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchModelBreakdown, fetchProviderValue } from '../../../src/lib/analytics-api';

afterEach(() => { vi.restoreAllMocks(); });

describe('analytics-api client', () => {
  it('fetchModelBreakdown passes days + signal and returns parsed body', async () => {
    const ctrl = new AbortController();
    const json = { label: 'equivalent_value', models: [{ model: 'claude-opus-4-8', unpriced: false }] };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(json) });
    vi.stubGlobal('fetch', fetchMock);
    const out = await fetchModelBreakdown(30, ctrl.signal);
    expect(fetchMock).toHaveBeenCalledWith('/api/analytics/model-breakdown?days=30', { signal: ctrl.signal });
    expect(out.label).toBe('equivalent_value');
    expect(out.models[0].model).toBe('claude-opus-4-8');
  });

  it('fetchProviderValue returns empty providers on non-ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({}) }));
    const out = await fetchProviderValue(30, new AbortController().signal);
    expect(out.providers).toEqual([]);
  });
});
```

Run → **FAIL** (no module).

**GREEN.** Create `src/lib/analytics-api.ts`:

```ts
export interface ModelBreakdownRow {
  model: string; tier: string; provider: string;
  tokensIn: number; tokensOut: number; equivalentUsd: number;
  effectiveRatePerMTok: number; share: number; unpriced: boolean;
}
export interface ModelBreakdownResponse { label: 'cost' | 'equivalent_value'; models: ModelBreakdownRow[]; }

export interface ModelMixBucket { date: string; models: Record<string, number>; topTierShare: number; }
export interface ModelMixResponse { label: 'cost' | 'equivalent_value'; series: ModelMixBucket[]; }

export interface ProviderValueRow {
  provider: string; label: 'cost' | 'equivalent_value'; equivalentUsd: number;
  seatPriceUsdMonthly?: number; valueMultiplier?: number; budgetUsd?: number;
}
export interface ProviderValueResponse { providers: ProviderValueRow[]; }

export interface WindowUtilizationRow {
  provider: string; weightedUnits: number; estimatedWindowCap: number;
  utilizationPct: number; isEstimate: true;
}
export interface WindowUtilizationResponse { rows: WindowUtilizationRow[]; }

export interface CostPerGoalPoint { date: string; equivalentUsdPerGoal: number; completedGoals: number; }
export interface CostPerGoalResponse { label: 'cost' | 'equivalent_value'; series: CostPerGoalPoint[]; }

async function getJson<T>(url: string, signal: AbortSignal, fallback: T): Promise<T> {
  try {
    const r = await fetch(url, { signal });
    if (!r.ok) return fallback;
    return await r.json() as T;
  } catch {
    return fallback;
  }
}

export function fetchModelBreakdown(days: number, signal: AbortSignal): Promise<ModelBreakdownResponse> {
  return getJson(`/api/analytics/model-breakdown?days=${days}`, signal, { label: 'equivalent_value', models: [] });
}
export function fetchModelMix(days: number, signal: AbortSignal): Promise<ModelMixResponse> {
  return getJson(`/api/analytics/model-mix?days=${days}&bucket=day`, signal, { label: 'equivalent_value', series: [] });
}
export function fetchProviderValue(days: number, signal: AbortSignal): Promise<ProviderValueResponse> {
  return getJson(`/api/analytics/value?days=${days}`, signal, { providers: [] });
}
export function fetchWindowUtilization(signal: AbortSignal): Promise<WindowUtilizationResponse> {
  return getJson(`/api/analytics/window-utilization`, signal, { rows: [] });
}
export function fetchCostPerGoal(days: number, signal: AbortSignal): Promise<CostPerGoalResponse> {
  return getJson(`/api/analytics/cost-per-goal?days=${days}`, signal, { label: 'equivalent_value', series: [] });
}
```

> **Note on the test's exact URL assertion:** `getJson` passes `{ signal }` (no `fallback` arg to `fetch`), matching `fetchMock).toHaveBeenCalledWith(url, { signal })`. The `ok:false` path returns the fallback, satisfying the second test.

Run → **PASS**.

**COMMIT:** `feat(analytics): typed client API with AbortController-ready fetch helpers`

---

### Task 9 — UI: Model Breakdown table + Model Mix chart

Add the two efficiency sections to the Analytics tab. Fetch them in the existing `useEffect` keyed on `timeRange`, but use a single `AbortController` aborted on cleanup (fixes the fetch-race: a stale `timeRange`'s responses are discarded).

**RED.** Create `tests/client/pages/AnalyticsPage.overhaul.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const fetchMock = vi.fn();
beforeEach(() => { vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.restoreAllMocks(); });

const modelBreakdown = {
  label: 'equivalent_value',
  models: [
    { model: 'claude-opus-4-8', tier: 'frontier', provider: 'claude', tokensIn: 1500, tokensOut: 500, equivalentUsd: 6000, effectiveRatePerMTok: 30, share: 0.9, unpriced: false },
    { model: 'gemini-3-pro', tier: 'frontier', provider: 'antigravity', tokensIn: 9000, tokensOut: 0, equivalentUsd: 0, effectiveRatePerMTok: 0, share: 0, unpriced: true },
  ],
};
const modelMix = { label: 'equivalent_value', series: [
  { date: '2026-06-01', models: { 'claude-opus-4-8': 1500, 'claude-sonnet-4-6': 6000 }, topTierShare: 0.2 },
] };

function mockAll() {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/model-breakdown')) return Promise.resolve({ ok: true, json: () => Promise.resolve(modelBreakdown) });
    if (url.includes('/model-mix')) return Promise.resolve({ ok: true, json: () => Promise.resolve(modelMix) });
    if (url.includes('/value')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ providers: [] }) });
    if (url.includes('/window-utilization')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ rows: [] }) });
    if (url.includes('/cost-per-goal')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ label: 'equivalent_value', series: [] }) });
    if (url.includes('/totals')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ sessions: 1, cost: 1, tokensIn: 1, tokensOut: 1 }) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  });
}

describe('AnalyticsPage — Model Breakdown + Mix', () => {
  it('renders the Model Breakdown table with rows', async () => {
    mockAll();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');
    render(<MemoryRouter><AnalyticsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Model Breakdown')).toBeInTheDocument());
    expect(screen.getByText('claude-opus-4-8')).toBeInTheDocument();
    expect(screen.getByText('gemini-3-pro')).toBeInTheDocument();
  });

  it('shows an unpriced badge on unpriced models (not hidden)', async () => {
    mockAll();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');
    render(<MemoryRouter><AnalyticsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('gemini-3-pro')).toBeInTheDocument());
    expect(screen.getAllByText(/unpriced/i).length).toBeGreaterThan(0);
  });

  it('renders the Model Mix chart with a top-tier-share callout', async () => {
    mockAll();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');
    render(<MemoryRouter><AnalyticsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Model Mix')).toBeInTheDocument());
    expect(screen.getByText(/top-tier/i)).toBeInTheDocument();
  });

  it('fetches the new endpoints on load', async () => {
    mockAll();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');
    render(<MemoryRouter><AnalyticsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Model Breakdown')).toBeInTheDocument());
    const urls = fetchMock.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(urls.some((u) => u.includes('/model-breakdown'))).toBe(true);
    expect(urls.some((u) => u.includes('/model-mix'))).toBe(true);
  });
});
```

Run → **FAIL** (no such sections).

**GREEN.** Edit `src/pages/AnalyticsPage.tsx`:

1. Add imports:

```tsx
import {
  fetchModelBreakdown, fetchModelMix, fetchProviderValue,
  fetchWindowUtilization, fetchCostPerGoal,
  type ModelBreakdownResponse, type ModelMixResponse, type ProviderValueResponse,
  type WindowUtilizationResponse, type CostPerGoalResponse,
} from '../lib/analytics-api';
```

2. Add state inside `AnalyticsPageContent`:

```tsx
  const [modelBreakdown, setModelBreakdown] = useState<ModelBreakdownResponse>({ label: 'equivalent_value', models: [] });
  const [modelMix, setModelMix] = useState<ModelMixResponse>({ label: 'equivalent_value', series: [] });
  const [providerValue, setProviderValue] = useState<ProviderValueResponse>({ providers: [] });
  const [windowUtil, setWindowUtil] = useState<WindowUtilizationResponse>({ rows: [] });
  const [costPerGoal, setCostPerGoal] = useState<CostPerGoalResponse>({ label: 'equivalent_value', series: [] });
```

3. Add a new `useEffect` (keyed on `timeRange`) with an AbortController. This is the race-safe loader for all new sections:

```tsx
  useEffect(() => {
    const ctrl = new AbortController();
    const days = timeRangeToDays(timeRange);
    Promise.all([
      fetchModelBreakdown(days, ctrl.signal).then(setModelBreakdown),
      fetchModelMix(days, ctrl.signal).then(setModelMix),
      fetchProviderValue(days, ctrl.signal).then(setProviderValue),
      fetchWindowUtilization(ctrl.signal).then(setWindowUtil),
      fetchCostPerGoal(days, ctrl.signal).then(setCostPerGoal),
    ]).catch(() => { /* aborts/errors fall back to defaults inside helpers */ });
    return () => ctrl.abort();
  }, [timeRange]);
```

4. Add the Model Breakdown table + Model Mix chart sections inside the `activeTab === 'analytics'` block, after the existing grid (before Output Trends). The `label` swaps the column header between "Cost" and "Equivalent $" without changing the numbers:

```tsx
          {/* Model Breakdown */}
          <div className="rounded-md border border-line bg-card p-4">
            <h2 className="mb-4 text-sm font-medium text-dim">Model Breakdown</h2>
            {modelBreakdown.models.length > 0 ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-dim">
                    <th className="px-3 py-2 font-medium">Model</th>
                    <th className="px-3 py-2 font-medium">Tier</th>
                    <th className="px-3 py-2 font-medium">Tokens In</th>
                    <th className="px-3 py-2 font-medium">Tokens Out</th>
                    <th className="px-3 py-2 font-medium">
                      {modelBreakdown.label === 'cost' ? 'Cost' : 'Equivalent $'}
                    </th>
                    <th className="px-3 py-2 font-medium">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {modelBreakdown.models.map((m) => (
                    <tr key={m.model} className={`border-b border-line last:border-0 ${m.unpriced ? 'opacity-70' : ''}`}>
                      <td className="px-3 py-2 text-fg">
                        {m.model}
                        {m.unpriced && (
                          <span className="ml-2 rounded-sm bg-warn/15 px-1.5 py-0.5 text-[10px] text-warn" data-testid="unpriced-badge">
                            unpriced
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-dim">{m.tier}</td>
                      <td className="px-3 py-2 mono-tabular text-fg">{fmtTokens(m.tokensIn)}</td>
                      <td className="px-3 py-2 mono-tabular text-fg">{fmtTokens(m.tokensOut)}</td>
                      <td className="px-3 py-2 mono-tabular text-fg">{m.unpriced ? '—' : fmtCost(m.equivalentUsd)}</td>
                      <td className="px-3 py-2 mono-tabular text-dim">{Math.round(m.share * 100)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty text="No per-model usage yet" />
            )}
          </div>

          {/* Model Mix + top-tier-share */}
          <div className="rounded-md border border-line bg-card p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-medium text-dim">Model Mix</h2>
              <span className="text-xs text-dim">
                top-tier share (latest):{' '}
                <span className="mono-tabular text-fg">
                  {modelMix.series.length > 0
                    ? `${Math.round(modelMix.series[modelMix.series.length - 1].topTierShare * 100)}%`
                    : '—'}
                </span>
              </span>
            </div>
            {modelMix.series.length > 0 ? (
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={modelMix.series.map((b) => ({ date: b.date, topTier: Math.round(b.topTierShare * 100) }))}>
                  <XAxis dataKey="date" tick={{ fill: 'var(--cd-faint)', fontSize: 10 }} />
                  <YAxis tick={{ fill: 'var(--cd-faint)', fontSize: 10 }} tickFormatter={(v: number) => `${v}%`} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [`${v}%`, 'Top-tier share']} />
                  <Line type="monotone" dataKey="topTier" stroke="var(--cd-accent)" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <Empty text="No model mix data yet" />
            )}
          </div>
```

Run the new test + the existing `tests/client/pages/AnalyticsPage.test.tsx` (regression — all original sections must still render) → **PASS**.

**COMMIT:** `feat(analytics): Model Breakdown table + Model Mix top-tier-share chart`

---

### Task 10 — UI: Subscription Value cards, Window Utilization gauges, Budget vs Spend

Render the value/utilization sections, swapping presentation by `label`/`billingMode`: seat → value multiplier cards + window gauges; metered → budget-vs-spend bars. Value-multiplier card carries the locked caveat tooltip.

**RED.** Create `tests/client/pages/AnalyticsPage.value.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const fetchMock = vi.fn();
beforeEach(() => { vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.restoreAllMocks(); });

function mockWith(value: unknown, util: unknown) {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/value')) return Promise.resolve({ ok: true, json: () => Promise.resolve(value) });
    if (url.includes('/window-utilization')) return Promise.resolve({ ok: true, json: () => Promise.resolve(util) });
    if (url.includes('/model-breakdown')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ label: 'equivalent_value', models: [] }) });
    if (url.includes('/model-mix')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ label: 'equivalent_value', series: [] }) });
    if (url.includes('/cost-per-goal')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ label: 'equivalent_value', series: [] }) });
    if (url.includes('/totals')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ sessions: 1, cost: 1, tokensIn: 1, tokensOut: 1 }) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  });
}

describe('AnalyticsPage — Subscription Value (seat)', () => {
  it('shows a value multiplier card with the replacement-value caveat', async () => {
    mockWith(
      { providers: [{ provider: 'claude', label: 'equivalent_value', equivalentUsd: 6000, seatPriceUsdMonthly: 200, valueMultiplier: 30 }] },
      { rows: [{ provider: 'claude', weightedUnits: 500000, estimatedWindowCap: 2000000, utilizationPct: 25, isEstimate: true }] },
    );
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');
    render(<MemoryRouter><AnalyticsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Subscription Value')).toBeInTheDocument());
    expect(screen.getByText(/30x/)).toBeInTheDocument();
    expect(screen.getByText(/replacement value/i)).toBeInTheDocument(); // locked caveat
  });

  it('shows window utilization gauges labeled as estimate', async () => {
    mockWith(
      { providers: [{ provider: 'claude', label: 'equivalent_value', equivalentUsd: 6000, seatPriceUsdMonthly: 200, valueMultiplier: 30 }] },
      { rows: [{ provider: 'claude', weightedUnits: 500000, estimatedWindowCap: 2000000, utilizationPct: 25, isEstimate: true }] },
    );
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');
    render(<MemoryRouter><AnalyticsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Window Utilization')).toBeInTheDocument());
    expect(screen.getByText(/estimate/i)).toBeInTheDocument();
    expect(screen.getByText(/25%/)).toBeInTheDocument();
  });
});

describe('AnalyticsPage — Budget vs Spend (metered)', () => {
  it('renders budget vs spend for a metered provider (no multiplier)', async () => {
    mockWith(
      { providers: [{ provider: 'antigravity', label: 'cost', equivalentUsd: 250, budgetUsd: 500 }] },
      { rows: [] },
    );
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');
    render(<MemoryRouter><AnalyticsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Budget vs Spend')).toBeInTheDocument());
    expect(screen.getByText(/antigravity/)).toBeInTheDocument();
    expect(screen.queryByText(/x$/)).not.toBeInTheDocument(); // no multiplier
  });
});
```

Run → **FAIL** (no such sections).

**GREEN.** Edit `src/pages/AnalyticsPage.tsx`. Add sections after the Model Mix block. Split providers into seat vs metered by their `label`:

```tsx
          {/* Subscription Value (seat providers) */}
          {providerValue.providers.some((p) => p.label === 'equivalent_value') && (
            <div className="rounded-md border border-line bg-card p-4">
              <h2 className="mb-4 text-sm font-medium text-dim">Subscription Value</h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {providerValue.providers.filter((p) => p.label === 'equivalent_value').map((p) => (
                  <div key={p.provider} className="rounded-md border border-line bg-inset p-4">
                    <p className="text-xs text-dim capitalize">{p.provider}</p>
                    <p className="mt-1 mono-tabular text-2xl font-bold text-fg">
                      {p.valueMultiplier ? `${p.valueMultiplier}x` : '—'}
                    </p>
                    <p className="mt-1 text-xs text-dim">
                      {fmtCost(p.equivalentUsd)} value{p.seatPriceUsdMonthly ? ` / ${fmtCost(p.seatPriceUsdMonthly)}/mo` : ''}
                    </p>
                    <p className="mt-2 text-[10px] text-faint" title="Replacement value: what the same tokens would cost at metered API rates. Overstates somewhat at zero marginal cost.">
                      replacement value — overstates at zero marginal cost
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Window Utilization (seat only, estimate) */}
          {windowUtil.rows.length > 0 && (
            <div className="rounded-md border border-line bg-card p-4">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-sm font-medium text-dim">Window Utilization</h2>
                <span className="rounded-sm bg-warn/15 px-1.5 py-0.5 text-[10px] text-warn">estimate</span>
              </div>
              <div className="space-y-3">
                {windowUtil.rows.map((r) => (
                  <div key={r.provider} className="flex items-center gap-3">
                    <span className="w-24 text-xs text-dim capitalize">{r.provider}</span>
                    <div className="flex-1 h-4 bg-inset rounded overflow-hidden">
                      <div className="h-full rounded bg-accent transition-all" style={{ width: `${Math.min(100, r.utilizationPct)}%` }} />
                    </div>
                    <span className="w-12 text-right mono-tabular text-xs text-fg">{r.utilizationPct}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Budget vs Spend (metered providers — work profile) */}
          {providerValue.providers.some((p) => p.label === 'cost') && (
            <div className="rounded-md border border-line bg-card p-4">
              <h2 className="mb-4 text-sm font-medium text-dim">Budget vs Spend</h2>
              <div className="space-y-3">
                {providerValue.providers.filter((p) => p.label === 'cost').map((p) => {
                  const pct = p.budgetUsd && p.budgetUsd > 0 ? Math.min(100, (p.equivalentUsd / p.budgetUsd) * 100) : 0;
                  const over = p.budgetUsd !== undefined && p.equivalentUsd > p.budgetUsd;
                  return (
                    <div key={p.provider} className="flex items-center gap-3">
                      <span className="w-24 text-xs text-dim capitalize">{p.provider}</span>
                      <div className="flex-1 h-4 bg-inset rounded overflow-hidden">
                        <div className={`h-full rounded transition-all ${over ? 'bg-danger' : 'bg-ok'}`} style={{ width: `${pct}%` }} />
                      </div>
                      <span className="w-28 text-right mono-tabular text-xs text-fg">
                        {fmtCost(p.equivalentUsd)}{p.budgetUsd !== undefined ? ` / ${fmtCost(p.budgetUsd)}` : ''}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
```

Run the new test + prior client tests → **PASS**.

**COMMIT:** `feat(analytics): subscription value cards, window gauges, budget vs spend`

---

### Task 11 — UI: Model Scorecard (cost/speed/quota; pass/fail follow-up noted)

A scorecard table per model: equivalent$, effective rate, quota weight (from registry), and a placeholder pass/fail column gated on a future verification gate. Since Phase 5C (verification gate) is **not** built yet, ship cost/speed/quota columns now and render pass/fail as "—" with a one-line note.

**RED.** Add to `tests/client/pages/AnalyticsPage.overhaul.test.tsx`:

```tsx
describe('AnalyticsPage — Model Scorecard', () => {
  it('renders a scorecard with quota weight and a pass/fail-pending column', async () => {
    mockAll();
    const { default: AnalyticsPage } = await import('../../../src/pages/AnalyticsPage');
    render(<MemoryRouter><AnalyticsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Model Scorecard')).toBeInTheDocument());
    expect(screen.getByText(/Quota Weight/i)).toBeInTheDocument();
    // Verification column present but pending (Phase 5 gate not built)
    expect(screen.getByText(/Verification/i)).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});
```

Run → **FAIL**.

**GREEN.** The scorecard derives from `modelBreakdown.models` plus the registry quota weight. Add a registry import and the section in `src/pages/AnalyticsPage.tsx`:

```tsx
import { resolveModel } from '../shared/agents/model-registry';
```

Section (after Budget vs Spend):

```tsx
          {/* Model Scorecard */}
          {modelBreakdown.models.length > 0 && (
            <div className="rounded-md border border-line bg-card p-4">
              <h2 className="mb-1 text-sm font-medium text-dim">Model Scorecard</h2>
              <p className="mb-3 text-[10px] text-faint">
                Verification pass/fail lands with the Phase 5 verification gate; columns below are cost/speed/quota only.
              </p>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-dim">
                    <th className="px-3 py-2 font-medium">Model</th>
                    <th className="px-3 py-2 font-medium">Tier</th>
                    <th className="px-3 py-2 font-medium">Eff. $/MTok</th>
                    <th className="px-3 py-2 font-medium">Quota Weight</th>
                    <th className="px-3 py-2 font-medium">Verification</th>
                  </tr>
                </thead>
                <tbody>
                  {modelBreakdown.models.map((m) => {
                    const entry = resolveModel(m.model);
                    return (
                      <tr key={m.model} className="border-b border-line last:border-0">
                        <td className="px-3 py-2 text-fg">{m.model}</td>
                        <td className="px-3 py-2 text-dim">{m.tier}</td>
                        <td className="px-3 py-2 mono-tabular text-fg">{m.unpriced ? '—' : `$${m.effectiveRatePerMTok.toFixed(2)}`}</td>
                        <td className="px-3 py-2 mono-tabular text-dim">{entry?.quotaWeight ?? '—'}</td>
                        <td className="px-3 py-2 text-faint">—</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
```

Run → **PASS**.

**COMMIT:** `feat(analytics): model scorecard (cost/speed/quota; verification pending Phase 5)`

---

### Task 12 — Full regression + typecheck + lint gate

**RED/GREEN.** Run the whole suite and the typechecker; fix any breakage (the most likely: the existing `AnalyticsPage.test.tsx` mocks don't return the new endpoints — they fall through to the default `[]`/`{}` mock, which the helpers tolerate via fallbacks, so no change should be needed; confirm).

```bash
npm run typecheck
npm test
```

Expected: all green, including `tests/server/analytics-ingestion.test.ts`, `tests/server/analytics-data-layer.test.ts`, `tests/client/pages/AnalyticsPage.test.tsx` (0 new failures vs the Phase 1 green baseline).

If `getProviders()` in `server/index.ts` queries `app_config` before migration 015 exists on the branch, the `try/catch` returns the default — verify the server still boots. (Migration 015 arrives with Phase 1; the read is defensive.)

**COMMIT:** `test(analytics): green full-suite regression for analytics overhaul`

---

## SELF-REVIEW (by plan author)

**Coverage of the brief:**
- *DATA — per-model granularity:* Task 1 (migration **017** `session_model_usage` child table — chosen over `by_model_json` and justified: GROUP-BY-friendly, indexable, bound-param queries). Task 3 ingestion writes per-model rows; cost via Phase 0A registry; `pricing === null` → cost 0 + `unpriced` flag (Task 2). ✔
- *ENDPOINTS (bound params):* Task 4 (`model-breakdown`, `model-mix`, `cost-per-goal`) + Task 5 (`value`, `window-utilization`), all using `?`-bound `days`/`since`. Task 6 wires them with `label` from `billingMode`. Goal↔session link found and used (`sessions.goal_id → goals.id`, `session_usage.session_id = sessions.id`). ✔
- *UI:* Model Breakdown table (Task 9), Model Mix + top-tier-share (Task 9), Subscription Value cards with multiplier + the locked "replacement value" caveat (Task 10), Window Utilization gauges labeled estimate (Task 10), Budget vs Spend (Task 10), unpriced badge not hidden (Task 9), AbortController per `timeRange` (Task 8/9). `label` swaps presentation without changing math. ✔
- *Model scorecard:* Task 11 — cost/speed/quota now; pass/fail column present but "—" with a Phase 5 follow-up note (no verification gate yet). ✔

**Locked contracts honored:** dollars always = tokens × registry pricing (Tasks 2/4/5); `billingMode` only labels (Task 6 `label`, Tasks 9–10 presentation swap); seat multiplier = equivalent$ ÷ seatPriceUsdMonthly (Task 5); window utilization = Σ(tokens × quotaWeight) vs estimated cap, labeled estimate (Task 5/10). `RawUsage.byModel` (Delta A) is noted as a delegation seam but not hard-required — ingestion writes child rows from the per-message model directly. `ProviderConfig` (Delta B) consumed; a fallback `provider-config.ts` + `app_config` direct-read shim included so Phase 2 isn't blocked if Phase 1 lags.

**TDD discipline:** every task is RED (failing test with exact path) → GREEN (real code) → COMMIT. No placeholders. Tests use the established `:memory:` + `runMigrations` harness and the existing client `vi.stubGlobal('fetch', ...)` pattern.

**Migrations used:** **017** (`session_model_usage`). Note: migrations 015 (`app_config`) and 016 (`provider_config` rewrite) are Phase 1's; this plan only *reads* `app_config` and does not create it.

**Known risks called out inline:** (1) Phase 0A registry + Phase 1 ConfigService are prerequisites — fallbacks provided (Task 5 `provider-config.ts`, Task 7 `app_config` direct read). (2) The window-utilization cap is a heuristic, not a vendor number — flagged `isEstimate` and badged in UI. (3) Existing `AnalyticsPage.test.tsx` regression relies on the new fetch helpers tolerating the default mock — confirmed via fallbacks; Task 12 verifies. (4) Parent-cost = sum-of-per-model-cost changes the rounding path slightly vs the old single-model cost; existing `analytics-ingestion.test.ts` only asserts `> 0`, so it stays green, and the new test asserts parent == Σ children.

**Missing contract (flagged to caller):** none blocking. The only assumption beyond the locked contracts is the **rolling-window length (5h) and estimated weighted-token cap (2M units)** for window-utilization — these are not specified anywhere and are encoded as named constants in `analytics-value-service.ts` for easy tuning; if the user has real per-plan window figures, they should replace `ROLLING_WINDOW_MS` / `ESTIMATED_WINDOW_CAP_UNITS`.
