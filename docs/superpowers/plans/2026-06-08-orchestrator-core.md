# Orchestrator Core (Backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the server-side, event-driven orchestrator dispatcher for Claude Deck — a persistent-state / disposable-process agent that wakes on triggers, loads a durable memory file + a live board snapshot, reasons via a headless cost-effective CLI brain, acts through the existing claude-deck MCP, and mirrors everything to a chat thread + WS events.

**Architecture:** A single `OrchestratorService` owns a serialized trigger queue and a lifecycle state machine (`idle → waking → active → cooling → idle`). On each trigger it assembles a context bundle (durable `memory.md` + live SQLite snapshot + the triggering event + recent chat turns) and runs a **headless** CLI brain (`claude -p`, model `haiku` by default) via an injectable `BrainRunner`. The brain's streamed output is persisted to `orchestrator_messages` and broadcast as new `ServerEvent`s; a delimited `<memory-update>` block in the brain's output is extracted and written back to `memory.md` on clean finish. Governance caps orchestrator-spawned children. Triggers come from owner messages (API), the approval coordinator, session-ended events, the scheduler, and a heartbeat sweep.

**Tech Stack:** TypeScript 5.5 (strict), Express v5, better-sqlite3 (WAL), node-cron, Zod, Pino, Vitest. Node 22+. Follows existing service/route/migration/event patterns in `server/` and `src/shared/`.

---

## Prerequisites (NOT built by this plan)

This plan assumes the **agent-adapter foundation** (`docs/superpowers/specs/2026-06-06-agent-adapter-foundation-design.md`) is implemented first, providing:
- `server/agents/registry.ts` exporting `adapterForModel(model, enabled)` and an `AgentAdapter` with `resolveBinary(): string`.

If the foundation is **not yet built** when this plan runs, Task 8 contains a self-contained fallback (`resolveClaudeBinaryDirect()`) so the orchestrator core remains executable and testable; a one-line swap routes it through the adapter once the foundation lands. The fallback seam is called out explicitly in Task 8.

This plan does **NOT** build: the Discord adapter, the in-app Orchestrator tab, or the Settings persona UI — those are Plan 2 (Faces), which consumes the REST routes (Task 13) and WS events (Task 12) defined here.

---

## Shared type contract (defined in Task 2, referenced throughout)

These names are used verbatim across tasks — do not rename:

```ts
type OrchestratorRole = 'owner' | 'orchestrator' | 'system';
type OrchestratorChannel = 'app' | 'discord' | 'internal';
type TriggerKind = 'owner_message' | 'approval' | 'session_ended' | 'scheduled' | 'heartbeat';
type OrchestratorStatus = 'idle' | 'waking' | 'active' | 'cooling';

interface OrchestratorMessage {
  id: string;
  role: OrchestratorRole;
  channel: OrchestratorChannel;
  content: string;
  tool_calls_json: string | null;   // JSON array of { tool: string; summary: string }
  trigger_kind: TriggerKind | null;
  created_at: number;
}

interface OrchestratorTrigger {
  kind: TriggerKind;
  text?: string;          // owner_message content
  channel?: OrchestratorChannel; // origin face for owner_message (default 'app')
  approvalId?: string;    // approval
  goalId?: string;        // approval | session_ended | scheduled
  sessionId?: string;     // session_ended
  taskId?: string;        // scheduled
}

interface OrchestratorConfig {
  enabled: boolean;
  persona_name: string;       // default 'Hawat'
  model: string;              // default 'haiku'
  idle_timeout_ms: number;    // default 600000 (10 min)
  max_concurrent_children: number; // default 3
  max_depth: number;          // default 2
}

interface OrchestratorStateRecord {
  status: OrchestratorStatus;
  last_wake_at: number | null;
  last_active_at: number | null;
  config: OrchestratorConfig;
}
```

---

## File Structure

**New (server):**
- `server/db/migrations/015_orchestrator.sql` — `orchestrator_messages` + `orchestrator_state` tables.
- `server/services/orchestrator-state-service.ts` — single-row state + config CRUD.
- `server/services/orchestrator-message-service.ts` — chat thread persistence.
- `server/orchestrator/memory-store.ts` — durable `memory.md` read/write.
- `server/orchestrator/snapshot.ts` — live board snapshot from SQLite.
- `server/orchestrator/context-bundle.ts` — assembles the brain prompt input.
- `server/orchestrator/brain-provider.ts` — `BrainProvider` interface + `ClaudeBrainProvider` (arg building, stream parse, memory extraction).
- `server/orchestrator/brain-runner.ts` — spawns the headless brain, streams, returns a result.
- `server/orchestrator/orchestrator-service.ts` — queue + lifecycle + governance + mirror.
- `server/routes/orchestrator.ts` — REST API.

**New (shared):**
- `src/shared/orchestrator.ts` — shared types + Zod schemas (Task 2).

**Modified:**
- `src/shared/events.ts` — add orchestrator `ServerEvent`s (Task 12).
- `server/approval-coordinator.ts` — optional `onApprovalPending` observer (Task 14).
- `server/scheduler.ts` — optional `onFire` callback (Task 14).
- `server/index.ts` — instantiate + wire triggers + shutdown (Task 14).

**Tests:** mirror each module under `tests/server/orchestrator/**` and `tests/server/services/**` (existing test layout).

---

### Task 1: Database migration

**Files:**
- Create: `server/db/migrations/015_orchestrator.sql`
- Test: `tests/server/orchestrator/migration.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/server/orchestrator/migration.test.ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';

describe('migration 015 orchestrator', () => {
  it('creates orchestrator_messages and orchestrator_state with a seeded singleton row', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('orchestrator_messages','orchestrator_state')")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name).sort()).toEqual(['orchestrator_messages', 'orchestrator_state']);

    const state = db.prepare('SELECT * FROM orchestrator_state WHERE id = 1').get() as { id: number; status: string } | undefined;
    expect(state?.status).toBe('idle');

    const version = db.prepare('SELECT MAX(version) as v FROM schema_migrations').get() as { v: number };
    expect(version.v).toBeGreaterThanOrEqual(15);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/orchestrator/migration.test.ts`
Expected: FAIL — tables `orchestrator_messages`/`orchestrator_state` do not exist.

- [ ] **Step 3: Write the migration**

```sql
-- server/db/migrations/015_orchestrator.sql
-- Always-on orchestrator: chat thread + singleton lifecycle/config state.

CREATE TABLE IF NOT EXISTS orchestrator_messages (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('owner', 'orchestrator', 'system')),
  channel TEXT NOT NULL CHECK (channel IN ('app', 'discord', 'internal')),
  content TEXT NOT NULL,
  tool_calls_json TEXT,
  trigger_kind TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orchestrator_messages_created ON orchestrator_messages (created_at);

CREATE TABLE IF NOT EXISTS orchestrator_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'waking', 'active', 'cooling')),
  last_wake_at INTEGER,
  last_active_at INTEGER,
  config_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO orchestrator_state (id, status, config_json, updated_at)
VALUES (
  1,
  'idle',
  '{"enabled":false,"persona_name":"Hawat","model":"haiku","idle_timeout_ms":600000,"max_concurrent_children":3,"max_depth":2}',
  0
);

INSERT OR IGNORE INTO schema_migrations (version) VALUES (15);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/orchestrator/migration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/db/migrations/015_orchestrator.sql tests/server/orchestrator/migration.test.ts
git commit -m "feat(orchestrator): migration 015 — messages + singleton state tables"
```

---

### Task 2: Shared types & Zod schemas

**Files:**
- Create: `src/shared/orchestrator.ts`
- Test: `tests/shared/orchestrator-schemas.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/shared/orchestrator-schemas.test.ts
import { describe, it, expect } from 'vitest';
import {
  OrchestratorConfigSchema,
  OrchestratorMessageSchema,
  PostOwnerMessageSchema,
  DEFAULT_ORCHESTRATOR_CONFIG,
} from '../../src/shared/orchestrator';

describe('orchestrator schemas', () => {
  it('provides defaults via DEFAULT_ORCHESTRATOR_CONFIG', () => {
    const parsed = OrchestratorConfigSchema.parse(DEFAULT_ORCHESTRATOR_CONFIG);
    expect(parsed.persona_name).toBe('Hawat');
    expect(parsed.model).toBe('haiku');
    expect(parsed.idle_timeout_ms).toBe(600000);
  });

  it('rejects an invalid role on a message', () => {
    expect(() =>
      OrchestratorMessageSchema.parse({
        id: 'x', role: 'robot', channel: 'app', content: 'hi',
        tool_calls_json: null, trigger_kind: null, created_at: 1,
      }),
    ).toThrow();
  });

  it('requires non-empty text on a posted owner message', () => {
    expect(() => PostOwnerMessageSchema.parse({ text: '' })).toThrow();
    expect(PostOwnerMessageSchema.parse({ text: 'do the thing' }).text).toBe('do the thing');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/shared/orchestrator-schemas.test.ts`
Expected: FAIL — module `src/shared/orchestrator` not found.

- [ ] **Step 3: Write the module**

```ts
// src/shared/orchestrator.ts
import { z } from 'zod';

export const OrchestratorRoleSchema = z.enum(['owner', 'orchestrator', 'system']);
export const OrchestratorChannelSchema = z.enum(['app', 'discord', 'internal']);
export const TriggerKindSchema = z.enum(['owner_message', 'approval', 'session_ended', 'scheduled', 'heartbeat']);
export const OrchestratorStatusSchema = z.enum(['idle', 'waking', 'active', 'cooling']);

export type OrchestratorRole = z.infer<typeof OrchestratorRoleSchema>;
export type OrchestratorChannel = z.infer<typeof OrchestratorChannelSchema>;
export type TriggerKind = z.infer<typeof TriggerKindSchema>;
export type OrchestratorStatus = z.infer<typeof OrchestratorStatusSchema>;

export const OrchestratorMessageSchema = z.object({
  id: z.string(),
  role: OrchestratorRoleSchema,
  channel: OrchestratorChannelSchema,
  content: z.string(),
  tool_calls_json: z.string().nullable(),
  trigger_kind: TriggerKindSchema.nullable(),
  created_at: z.number(),
});
export type OrchestratorMessage = z.infer<typeof OrchestratorMessageSchema>;

export const OrchestratorConfigSchema = z.object({
  enabled: z.boolean(),
  persona_name: z.string().min(1),
  model: z.string().min(1),
  idle_timeout_ms: z.number().int().min(10_000),
  max_concurrent_children: z.number().int().min(0),
  max_depth: z.number().int().min(0),
});
export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>;

export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  enabled: false,
  persona_name: 'Hawat',
  model: 'haiku',
  idle_timeout_ms: 600_000,
  max_concurrent_children: 3,
  max_depth: 2,
};

export const OrchestratorStateRecordSchema = z.object({
  status: OrchestratorStatusSchema,
  last_wake_at: z.number().nullable(),
  last_active_at: z.number().nullable(),
  config: OrchestratorConfigSchema,
});
export type OrchestratorStateRecord = z.infer<typeof OrchestratorStateRecordSchema>;

/** A trigger that can wake the orchestrator. Validated where it crosses the API boundary. */
export interface OrchestratorTrigger {
  kind: TriggerKind;
  text?: string;
  channel?: OrchestratorChannel;
  approvalId?: string;
  goalId?: string;
  sessionId?: string;
  taskId?: string;
}

// ── API request bodies ───────────────────────────────────────────────────────
export const PostOwnerMessageSchema = z.object({
  text: z.string().min(1),
  channel: OrchestratorChannelSchema.optional(),
});
export type PostOwnerMessage = z.infer<typeof PostOwnerMessageSchema>;

export const UpdateOrchestratorConfigSchema = OrchestratorConfigSchema.partial();
export type UpdateOrchestratorConfig = z.infer<typeof UpdateOrchestratorConfigSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/shared/orchestrator-schemas.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/orchestrator.ts tests/shared/orchestrator-schemas.test.ts
git commit -m "feat(orchestrator): shared types and zod schemas"
```

---

### Task 3: OrchestratorStateService (state + config)

**Files:**
- Create: `server/services/orchestrator-state-service.ts`
- Test: `tests/server/services/orchestrator-state-service.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/server/services/orchestrator-state-service.test.ts
// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';
import { OrchestratorStateService } from '../../../server/services/orchestrator-state-service';

function freshDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

describe('OrchestratorStateService', () => {
  let svc: OrchestratorStateService;
  beforeEach(() => { svc = new OrchestratorStateService(freshDb()); });

  it('reads the seeded singleton with defaults', () => {
    const state = svc.get();
    expect(state.status).toBe('idle');
    expect(state.config.persona_name).toBe('Hawat');
    expect(state.config.enabled).toBe(false);
  });

  it('setStatus persists and stamps last_wake_at on waking', () => {
    svc.setStatus('waking', 123);
    const state = svc.get();
    expect(state.status).toBe('waking');
    expect(state.last_wake_at).toBe(123);
  });

  it('updateConfig merges, validates, and persists', () => {
    const next = svc.updateConfig({ enabled: true, persona_name: 'Thufir', idle_timeout_ms: 60_000 });
    expect(next.enabled).toBe(true);
    expect(next.persona_name).toBe('Thufir');
    expect(next.idle_timeout_ms).toBe(60_000);
    expect(svc.get().config.model).toBe('haiku'); // untouched field preserved
  });

  it('updateConfig rejects an invalid idle_timeout_ms below the floor', () => {
    expect(() => svc.updateConfig({ idle_timeout_ms: 5 })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/services/orchestrator-state-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the service**

```ts
// server/services/orchestrator-state-service.ts
import type Database from 'better-sqlite3';
import {
  OrchestratorConfigSchema,
  DEFAULT_ORCHESTRATOR_CONFIG,
  type OrchestratorConfig,
  type OrchestratorStateRecord,
  type OrchestratorStatus,
  type UpdateOrchestratorConfig,
} from '../../src/shared/orchestrator';

interface StateRow {
  id: number;
  status: OrchestratorStatus;
  last_wake_at: number | null;
  last_active_at: number | null;
  config_json: string;
  updated_at: number;
}

/**
 * CRUD for the orchestrator's single-row lifecycle + config state.
 * The `orchestrator_state` table always has exactly one row (id = 1), seeded by migration 015.
 */
export class OrchestratorStateService {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** Reads the singleton state, parsing + defaulting the embedded config. */
  get(): OrchestratorStateRecord {
    const row = this.db.prepare('SELECT * FROM orchestrator_state WHERE id = 1').get() as StateRow | undefined;
    if (!row) {
      // Defensive: seed should exist, but never throw on a fresh/corrupt row.
      return {
        status: 'idle',
        last_wake_at: null,
        last_active_at: null,
        config: DEFAULT_ORCHESTRATOR_CONFIG,
      };
    }
    const config = OrchestratorConfigSchema.parse({
      ...DEFAULT_ORCHESTRATOR_CONFIG,
      ...(JSON.parse(row.config_json) as Record<string, unknown>),
    });
    return {
      status: row.status,
      last_wake_at: row.last_wake_at,
      last_active_at: row.last_active_at,
      config,
    };
  }

  /** Persists a lifecycle status transition. Stamps last_wake_at when entering 'waking'. */
  setStatus(status: OrchestratorStatus, now: number): void {
    if (status === 'waking') {
      this.db
        .prepare('UPDATE orchestrator_state SET status = ?, last_wake_at = ?, updated_at = ? WHERE id = 1')
        .run(status, now, now);
    } else if (status === 'active') {
      this.db
        .prepare('UPDATE orchestrator_state SET status = ?, last_active_at = ?, updated_at = ? WHERE id = 1')
        .run(status, now, now);
    } else {
      this.db
        .prepare('UPDATE orchestrator_state SET status = ?, updated_at = ? WHERE id = 1')
        .run(status, now);
    }
  }

  /** Merges a partial config over the current one, validates, and persists. Returns the new config. */
  updateConfig(partial: UpdateOrchestratorConfig): OrchestratorConfig {
    const current = this.get().config;
    const merged = OrchestratorConfigSchema.parse({ ...current, ...partial });
    this.db
      .prepare('UPDATE orchestrator_state SET config_json = ?, updated_at = ? WHERE id = 1')
      .run(JSON.stringify(merged), Date.now());
    return merged;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/services/orchestrator-state-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/orchestrator-state-service.ts tests/server/services/orchestrator-state-service.test.ts
git commit -m "feat(orchestrator): state + config service (singleton row)"
```

---

### Task 4: OrchestratorMessageService (chat thread)

**Files:**
- Create: `server/services/orchestrator-message-service.ts`
- Test: `tests/server/services/orchestrator-message-service.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/server/services/orchestrator-message-service.test.ts
// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';
import { OrchestratorMessageService } from '../../../server/services/orchestrator-message-service';

function freshDb() { const db = new Database(':memory:'); runMigrations(db); return db; }

describe('OrchestratorMessageService', () => {
  let svc: OrchestratorMessageService;
  beforeEach(() => { svc = new OrchestratorMessageService(freshDb()); });

  it('appends a message and returns it with a generated id', () => {
    const m = svc.append({ role: 'owner', channel: 'app', content: 'status?', tool_calls_json: null, trigger_kind: 'owner_message' });
    expect(m.id).toBeTruthy();
    expect(m.created_at).toBeGreaterThan(0);
    expect(m.content).toBe('status?');
  });

  it('lists messages in chronological order, newest last', () => {
    svc.append({ role: 'owner', channel: 'app', content: 'first', tool_calls_json: null, trigger_kind: 'owner_message' });
    svc.append({ role: 'orchestrator', channel: 'app', content: 'second', tool_calls_json: null, trigger_kind: null });
    const all = svc.list(50);
    expect(all.map((m) => m.content)).toEqual(['first', 'second']);
  });

  it('recent(n) returns the last n in chronological order', () => {
    for (let i = 0; i < 5; i++) {
      svc.append({ role: 'owner', channel: 'app', content: `m${i}`, tool_calls_json: null, trigger_kind: null });
    }
    expect(svc.recent(2).map((m) => m.content)).toEqual(['m3', 'm4']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/services/orchestrator-message-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the service**

```ts
// server/services/orchestrator-message-service.ts
import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import type { OrchestratorMessage, OrchestratorRole, OrchestratorChannel, TriggerKind } from '../../src/shared/orchestrator';

export interface AppendMessageInput {
  role: OrchestratorRole;
  channel: OrchestratorChannel;
  content: string;
  tool_calls_json: string | null;
  trigger_kind: TriggerKind | null;
}

interface MessageRow {
  id: string;
  role: OrchestratorRole;
  channel: OrchestratorChannel;
  content: string;
  tool_calls_json: string | null;
  trigger_kind: TriggerKind | null;
  created_at: number;
}

function rowToMessage(row: MessageRow): OrchestratorMessage {
  return {
    id: row.id,
    role: row.role,
    channel: row.channel,
    content: row.content,
    tool_calls_json: row.tool_calls_json,
    trigger_kind: row.trigger_kind,
    created_at: row.created_at,
  };
}

/** Persistence for the single orchestrator conversation thread (shared across faces). */
export class OrchestratorMessageService {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** Appends a message and returns the persisted row. */
  append(input: AppendMessageInput): OrchestratorMessage {
    const id = uuid();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO orchestrator_messages (id, role, channel, content, tool_calls_json, trigger_kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.role, input.channel, input.content, input.tool_calls_json, input.trigger_kind, now);
    return { id, ...input, created_at: now };
  }

  /** Returns the most recent `limit` messages in chronological order (oldest first). */
  list(limit: number): OrchestratorMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM orchestrator_messages ORDER BY created_at ASC, id ASC LIMIT ?')
      .all(limit) as MessageRow[];
    return rows.map(rowToMessage);
  }

  /** Returns the last `n` messages in chronological order (for the context bundle). */
  recent(n: number): OrchestratorMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM orchestrator_messages ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(n) as MessageRow[];
    return rows.reverse().map(rowToMessage);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/services/orchestrator-message-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/orchestrator-message-service.ts tests/server/services/orchestrator-message-service.test.ts
git commit -m "feat(orchestrator): chat thread persistence service"
```

---

### Task 5: MemoryStore (durable memory.md)

**Files:**
- Create: `server/orchestrator/memory-store.ts`
- Test: `tests/server/orchestrator/memory-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/server/orchestrator/memory-store.test.ts
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../../server/orchestrator/memory-store';

describe('MemoryStore', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orch-mem-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns a seeded default when the file does not exist', () => {
    const store = new MemoryStore(dir);
    const text = store.read();
    expect(text).toContain('# Orchestrator Memory');
    expect(existsSync(join(dir, 'orchestrator', 'memory.md'))).toBe(false); // read does not create
  });

  it('write then read round-trips and creates the directory', () => {
    const store = new MemoryStore(dir);
    store.write('# Orchestrator Memory\n\nWatching goal X.');
    expect(store.read()).toContain('Watching goal X.');
    expect(existsSync(join(dir, 'orchestrator', 'memory.md'))).toBe(true);
  });

  it('write is atomic (no partial file left on the final path name)', () => {
    const store = new MemoryStore(dir);
    store.write('first');
    store.write('second');
    expect(readFileSync(join(dir, 'orchestrator', 'memory.md'), 'utf8')).toBe('second');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/orchestrator/memory-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```ts
// server/orchestrator/memory-store.ts
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SEED = `# Orchestrator Memory

_This file is the orchestrator's durable memory. It is loaded on every wake and
rewritten as the orchestrator acts. It is human-readable and may be edited by hand._

## Standing instructions

(none yet)

## What I've done

(nothing yet)

## Open threads awaiting a decision

(none yet)
`;

/**
 * Durable markdown memory for the orchestrator, stored at `<dataDir>/orchestrator/memory.md`.
 * Reads return a seeded default if the file is absent (without creating it).
 * Writes are atomic (write to a temp file, then rename).
 */
export class MemoryStore {
  private readonly dir: string;
  private readonly path: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'orchestrator');
    this.path = join(this.dir, 'memory.md');
  }

  /** The seeded default content used when the file is absent. */
  get seed(): string {
    return SEED;
  }

  /** Reads memory.md, or returns the seed if it does not exist. */
  read(): string {
    if (!existsSync(this.path)) return SEED;
    return readFileSync(this.path, 'utf8');
  }

  /** Atomically writes memory.md, creating the directory if needed. */
  write(content: string): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, this.path);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/orchestrator/memory-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/orchestrator/memory-store.ts tests/server/orchestrator/memory-store.test.ts
git commit -m "feat(orchestrator): durable memory.md store with atomic writes"
```

---

### Task 6: Live board snapshot

**Files:**
- Create: `server/orchestrator/snapshot.ts`
- Test: `tests/server/orchestrator/snapshot.test.ts`

The snapshot reads directly from existing tables (`goals`, `sessions`, `approvals`) so it always reflects the live board. Column names below match `001_init.sql` / `002_add_permission_request.sql` conventions seen in the codebase (`goals.id/title/status`, `sessions.id/goal_id/ended_at`, `approvals.id/tool_name/status/goal_id/requested_at`).

- [ ] **Step 1: Write the failing test**

```ts
// tests/server/orchestrator/snapshot.test.ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';
import { buildSnapshot } from '../../../server/orchestrator/snapshot';

function seed(db: Database.Database) {
  const now = Date.now();
  db.prepare(`INSERT INTO goals (id, title, status, created_at, updated_at) VALUES ('g1','Build feature','active',?,?)`).run(now, now);
  db.prepare(`INSERT INTO goals (id, title, status, created_at, updated_at) VALUES ('g2','Old done','complete',?,?)`).run(now, now);
  db.prepare(`INSERT INTO sessions (id, goal_id, started_at, ended_at) VALUES ('s1','g1',?,NULL)`).run(now);
  db.prepare(`INSERT INTO approvals (id, session_id, goal_id, tool_name, tool_args, status, requested_at) VALUES ('a1','s1','g1','Bash','{}','pending',?)`).run(now);
}

describe('buildSnapshot', () => {
  it('summarizes active goals, live sessions, and pending approvals', () => {
    const db = new Database(':memory:'); runMigrations(db); seed(db);
    const snap = buildSnapshot(db);
    expect(snap.activeGoals.find((g) => g.id === 'g1')).toBeTruthy();
    expect(snap.activeGoals.find((g) => g.id === 'g2')).toBeFalsy(); // complete is excluded
    expect(snap.liveSessions.map((s) => s.id)).toContain('s1');
    expect(snap.pendingApprovals[0]?.tool_name).toBe('Bash');
    db.close();
  });

  it('renders to a compact markdown block for the prompt', () => {
    const db = new Database(':memory:'); runMigrations(db); seed(db);
    const md = buildSnapshot(db).toMarkdown();
    expect(md).toContain('Build feature');
    expect(md).toContain('Pending approvals');
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/orchestrator/snapshot.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```ts
// server/orchestrator/snapshot.ts
import type Database from 'better-sqlite3';

export interface SnapshotGoal { id: string; title: string; status: string; }
export interface SnapshotSession { id: string; goal_id: string | null; }
export interface SnapshotApproval { id: string; tool_name: string; goal_id: string | null; requested_at: number; }

export interface BoardSnapshot {
  activeGoals: SnapshotGoal[];
  liveSessions: SnapshotSession[];
  pendingApprovals: SnapshotApproval[];
  toMarkdown(): string;
}

/**
 * Reads a live snapshot of the board from existing tables. Pure read — never mutates.
 * "Active" goals exclude complete/archived. "Live" sessions have ended_at IS NULL.
 */
export function buildSnapshot(db: Database.Database): BoardSnapshot {
  const activeGoals = db
    .prepare(`SELECT id, title, status FROM goals WHERE status NOT IN ('complete','archived') ORDER BY updated_at DESC LIMIT 30`)
    .all() as SnapshotGoal[];
  const liveSessions = db
    .prepare(`SELECT id, goal_id FROM sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 30`)
    .all() as SnapshotSession[];
  const pendingApprovals = db
    .prepare(`SELECT id, tool_name, goal_id, requested_at FROM approvals WHERE status = 'pending' ORDER BY requested_at ASC LIMIT 30`)
    .all() as SnapshotApproval[];

  return {
    activeGoals,
    liveSessions,
    pendingApprovals,
    toMarkdown(): string {
      const goals = activeGoals.length
        ? activeGoals.map((g) => `- [${g.status}] ${g.title} (${g.id})`).join('\n')
        : '- (none)';
      const sessions = liveSessions.length
        ? liveSessions.map((s) => `- session ${s.id}${s.goal_id ? ` → goal ${s.goal_id}` : ''}`).join('\n')
        : '- (none)';
      const approvals = pendingApprovals.length
        ? pendingApprovals.map((a) => `- ${a.tool_name}${a.goal_id ? ` (goal ${a.goal_id})` : ''} [${a.id}]`).join('\n')
        : '- (none)';
      return `### Active goals\n${goals}\n\n### Live sessions\n${sessions}\n\n### Pending approvals\n${approvals}`;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/orchestrator/snapshot.test.ts`
Expected: PASS. (If a column name mismatches the live schema, adjust the SELECT to match `001_init.sql`; the test seeds the same columns it queries.)

- [ ] **Step 5: Commit**

```bash
git add server/orchestrator/snapshot.ts tests/server/orchestrator/snapshot.test.ts
git commit -m "feat(orchestrator): live board snapshot reader"
```

---

### Task 7: Context bundle assembler

**Files:**
- Create: `server/orchestrator/context-bundle.ts`
- Test: `tests/server/orchestrator/context-bundle.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/server/orchestrator/context-bundle.test.ts
import { describe, it, expect } from 'vitest';
import { buildContextPrompt } from '../../../server/orchestrator/context-bundle';

describe('buildContextPrompt', () => {
  const base = {
    personaName: 'Hawat',
    memory: '# Orchestrator Memory\n\nWatching g1.',
    snapshotMd: '### Active goals\n- [active] Build (g1)',
    recentTurns: [
      { role: 'owner' as const, content: 'status?' },
      { role: 'orchestrator' as const, content: 'All green.' },
    ],
  };

  it('embeds persona, memory, snapshot, and recent turns', () => {
    const p = buildContextPrompt({ ...base, trigger: { kind: 'owner_message', text: 'what now?' } });
    expect(p).toContain('You are Hawat');
    expect(p).toContain('Watching g1.');
    expect(p).toContain('Build (g1)');
    expect(p).toContain('what now?');
    expect(p).toContain('<memory-update>'); // instructs the memory-write protocol
  });

  it('frames an approval trigger as a recommendation request', () => {
    const p = buildContextPrompt({ ...base, trigger: { kind: 'approval', approvalId: 'a1', goalId: 'g1' } });
    expect(p.toLowerCase()).toContain('recommendation');
    expect(p).toContain('a1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/orchestrator/context-bundle.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```ts
// server/orchestrator/context-bundle.ts
import type { OrchestratorTrigger, OrchestratorRole } from '../../src/shared/orchestrator';

export interface ContextInput {
  personaName: string;
  memory: string;
  snapshotMd: string;
  recentTurns: Array<{ role: OrchestratorRole; content: string }>;
  trigger: OrchestratorTrigger;
}

/** Describes the triggering event in natural language for the brain. */
function describeTrigger(t: OrchestratorTrigger): string {
  switch (t.kind) {
    case 'owner_message':
      return `The owner sent you a message:\n"""\n${t.text ?? ''}\n"""\nRespond and act as needed.`;
    case 'approval':
      return `A supervised session raised an APPROVAL request (approvalId=${t.approvalId ?? '?'}${t.goalId ? `, goal=${t.goalId}` : ''}). Review the situation using your tools, then produce a concise RECOMMENDATION (allow / deny + why) for the owner to ratify. Do NOT resolve it yourself.`;
    case 'session_ended':
      return `A session ended/stalled (session=${t.sessionId ?? '?'}${t.goalId ? `, goal=${t.goalId}` : ''}). Assess whether it needs attention and produce a RECOMMENDATION for the owner.`;
    case 'scheduled':
      return `A scheduled task fired${t.goalId ? ` and created goal ${t.goalId}` : ''} (task=${t.taskId ?? '?'}). Supervise it and report.`;
    case 'heartbeat':
      return `Heartbeat sweep. Check the board for anything needing attention. If nothing is actionable, reply briefly that all is quiet — do not invent work.`;
  }
}

/**
 * Assembles the full prompt handed to the headless brain. The brain must end its
 * reply with an updated memory block delimited by <memory-update>...</memory-update>;
 * the runner extracts it and persists it (Task 8/9).
 */
export function buildContextPrompt(input: ContextInput): string {
  const turns = input.recentTurns.length
    ? input.recentTurns.map((t) => `${t.role}: ${t.content}`).join('\n')
    : '(no prior conversation)';

  return `You are ${input.personaName}, the always-on orchestrator for Claude Deck — a control plane for multiple Claude Code sessions. You triage, route, summarize, and dispatch work through the claude-deck MCP tools. You keep the owner in the loop on consequential decisions and never act unilaterally on irreversible or outward-facing actions.

# Your durable memory
${input.memory}

# Live board snapshot (read-only, current)
${input.snapshotMd}

# Recent conversation
${turns}

# This wake was triggered by
${describeTrigger(input.trigger)}

# Rules
- Act through the claude-deck MCP tools. Everything you do is visible to the owner.
- For approvals/stalls: review and RECOMMEND; the owner ratifies.
- Respect rate limits; if you cannot complete, say so plainly.
- Be concise.

# Required: update your memory
End your reply with your full updated memory document, wrapped exactly like:
<memory-update>
# Orchestrator Memory
...your updated memory...
</memory-update>
If nothing changed, echo the current memory unchanged inside the block.`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/orchestrator/context-bundle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/orchestrator/context-bundle.ts tests/server/orchestrator/context-bundle.test.ts
git commit -m "feat(orchestrator): context bundle prompt assembler"
```

---

### Task 8: BrainProvider — arg building, stream parsing, memory extraction

**Files:**
- Create: `server/orchestrator/brain-provider.ts`
- Test: `tests/server/orchestrator/brain-provider.test.ts`

**Prerequisite seam:** `resolveBinary()` below routes through the agent-adapter foundation when present. If the foundation is not yet built, use the `resolveClaudeBinaryDirect()` fallback noted in the code comment (a one-line swap).

- [ ] **Step 1: Write the failing test**

```ts
// tests/server/orchestrator/brain-provider.test.ts
import { describe, it, expect } from 'vitest';
import { ClaudeBrainProvider, parseStreamLine, extractMemoryUpdate } from '../../../server/orchestrator/brain-provider';

describe('ClaudeBrainProvider.buildInvocation', () => {
  it('builds headless print-mode args with model, mcp config, and output format', () => {
    const p = new ClaudeBrainProvider('/usr/bin/claude');
    const inv = p.buildInvocation({
      prompt: 'hello',
      model: 'haiku',
      mcpConfigJson: '{"mcpServers":{}}',
      permissionMode: 'supervised',
    });
    expect(inv.command).toBe('/usr/bin/claude');
    expect(inv.args).toContain('-p');
    expect(inv.args).toContain('hello');
    expect(inv.args).toContain('--model');
    expect(inv.args).toContain('haiku');
    expect(inv.args).toContain('--output-format');
    expect(inv.args).toContain('stream-json');
  });
});

describe('parseStreamLine', () => {
  it('extracts assistant text', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi there' }] } });
    expect(parseStreamLine(line)).toEqual([{ kind: 'text', text: 'hi there' }]);
  });
  it('extracts tool_use as a tool event', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'create_goal', input: { title: 'X' } }] } });
    expect(parseStreamLine(line)).toEqual([{ kind: 'tool', tool: 'create_goal', summary: expect.stringContaining('X') }]);
  });
  it('returns [] for non-JSON or irrelevant lines', () => {
    expect(parseStreamLine('not json')).toEqual([]);
    expect(parseStreamLine(JSON.stringify({ type: 'result', result: 'done' }))).toEqual([]);
  });
});

describe('extractMemoryUpdate', () => {
  it('pulls the memory block out of the full transcript text', () => {
    const full = 'All good.\n<memory-update>\n# Orchestrator Memory\nWatching g1.\n</memory-update>';
    expect(extractMemoryUpdate(full)).toBe('# Orchestrator Memory\nWatching g1.');
  });
  it('returns null when no block is present', () => {
    expect(extractMemoryUpdate('no block here')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/orchestrator/brain-provider.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```ts
// server/orchestrator/brain-provider.ts

export type BrainStreamEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; tool: string; summary: string };

export interface BrainInvocationInput {
  prompt: string;
  model: string;
  mcpConfigJson: string;            // serialized { mcpServers: {...} }
  permissionMode: 'autonomous' | 'supervised';
}

export interface BrainInvocation {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface BrainProvider {
  buildInvocation(input: BrainInvocationInput): BrainInvocation;
  parseLine(line: string): BrainStreamEvent[];
}

/** Parses one stream-json line from `claude -p --output-format stream-json`. */
export function parseStreamLine(line: string): BrainStreamEvent[] {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return [];
  }
  const o = obj as { type?: string; message?: { content?: Array<Record<string, unknown>> } };
  if (o.type !== 'assistant' || !o.message?.content) return [];
  const events: BrainStreamEvent[] = [];
  for (const block of o.message.content) {
    if (block['type'] === 'text' && typeof block['text'] === 'string') {
      events.push({ kind: 'text', text: block['text'] });
    } else if (block['type'] === 'tool_use' && typeof block['name'] === 'string') {
      events.push({ kind: 'tool', tool: block['name'], summary: JSON.stringify(block['input'] ?? {}).slice(0, 200) });
    }
  }
  return events;
}

const MEMORY_RE = /<memory-update>\s*([\s\S]*?)\s*<\/memory-update>/;

/** Extracts the delimited memory block from the brain's full text output, or null. */
export function extractMemoryUpdate(fullText: string): string | null {
  const m = MEMORY_RE.exec(fullText);
  return m ? m[1].trim() : null;
}

/**
 * Claude Code headless brain provider. Builds `claude -p` print-mode args.
 *
 * PREREQUISITE SEAM: the binary is resolved by the caller and passed in. The caller
 * (BrainRunner wiring, Task 14) should obtain it from the agent-adapter foundation:
 *   adapterForModel(model, enabledProviders).resolveBinary()
 * If the foundation is not yet built, the caller may use a direct resolver instead
 * (e.g. process.env.CLAUDE_BIN ?? 'claude'). This module stays provider-agnostic.
 */
export class ClaudeBrainProvider implements BrainProvider {
  private readonly binary: string;
  constructor(binary: string) {
    this.binary = binary;
  }

  buildInvocation(input: BrainInvocationInput): BrainInvocation {
    return {
      command: this.binary,
      args: [
        '-p', input.prompt,
        '--model', input.model,
        '--output-format', 'stream-json',
        '--verbose',
        '--permission-mode', input.permissionMode === 'autonomous' ? 'bypassPermissions' : 'default',
        '--mcp-config', input.mcpConfigJson,
      ],
      env: {},
    };
  }

  parseLine(line: string): BrainStreamEvent[] {
    return parseStreamLine(line);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/orchestrator/brain-provider.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/orchestrator/brain-provider.ts tests/server/orchestrator/brain-provider.test.ts
git commit -m "feat(orchestrator): Claude brain provider — args, stream parse, memory extraction"
```

---

### Task 9: BrainRunner — spawn, stream, result

**Files:**
- Create: `server/orchestrator/brain-runner.ts`
- Test: `tests/server/orchestrator/brain-runner.test.ts`

`BrainRunner` spawns the headless process via an **injectable spawn function** so tests never launch a real CLI. It accumulates text, emits stream events to an `onEvent` callback (for mirroring), enforces a silence-timeout watchdog, and returns the full text + extracted memory on clean exit.

- [ ] **Step 1: Write the failing test**

```ts
// tests/server/orchestrator/brain-runner.test.ts
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { BrainRunner } from '../../../server/orchestrator/brain-runner';
import { ClaudeBrainProvider, type BrainStreamEvent } from '../../../server/orchestrator/brain-provider';

/** Builds a fake child process whose stdout emits the given lines then exits 0. */
function fakeChild(lines: string[], exitCode = 0) {
  const child = new EventEmitter() as EventEmitter & { stdout: Readable; stderr: Readable; kill: () => void };
  child.stdout = Readable.from(lines.map((l) => l + '\n'));
  child.stderr = Readable.from([]);
  child.kill = vi.fn();
  // emit close after stdout drains
  child.stdout.on('end', () => setImmediate(() => child.emit('close', exitCode)));
  return child;
}

describe('BrainRunner', () => {
  it('streams text events and returns the full text + extracted memory', async () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'All green. ' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '<memory-update>\n# Orchestrator Memory\nWatching g1.\n</memory-update>' }] } }),
      JSON.stringify({ type: 'result', result: 'ok' }),
    ];
    const spawnFn = vi.fn(() => fakeChild(lines));
    const events: BrainStreamEvent[] = [];
    const runner = new BrainRunner(new ClaudeBrainProvider('claude'), { spawnFn, silenceTimeoutMs: 1000 });

    const result = await runner.run(
      { prompt: 'p', model: 'haiku', mcpConfigJson: '{}', permissionMode: 'supervised' },
      (e) => events.push(e),
    );

    expect(spawnFn).toHaveBeenCalledOnce();
    expect(events.some((e) => e.kind === 'text' && e.text.includes('All green'))).toBe(true);
    expect(result.fullText).toContain('All green');
    expect(result.memory).toBe('# Orchestrator Memory\nWatching g1.');
    expect(result.exitCode).toBe(0);
  });

  it('reports a non-zero exit as ok=false', async () => {
    const spawnFn = vi.fn(() => fakeChild([], 1));
    const runner = new BrainRunner(new ClaudeBrainProvider('claude'), { spawnFn, silenceTimeoutMs: 1000 });
    const result = await runner.run({ prompt: 'p', model: 'haiku', mcpConfigJson: '{}', permissionMode: 'supervised' }, () => {});
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/orchestrator/brain-runner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```ts
// server/orchestrator/brain-runner.ts
import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import * as readline from 'node:readline';
import type { BrainProvider, BrainInvocationInput, BrainStreamEvent } from './brain-provider';
import { extractMemoryUpdate } from './brain-provider';
import logger from '../logger';

/** A minimal child-process shape so tests can inject fakes. */
export interface Spawnable {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill(signal?: string): void;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}
export type SpawnFn = (command: string, args: string[], env: Record<string, string>) => Spawnable;

export interface BrainRunnerOptions {
  spawnFn?: SpawnFn;
  silenceTimeoutMs?: number; // abort if no stdout line for this long
}

export interface BrainResult {
  ok: boolean;
  exitCode: number | null;
  fullText: string;
  memory: string | null;
  aborted: boolean;
}

const defaultSpawn: SpawnFn = (command, args, env) =>
  nodeSpawn(command, args, { env: { ...process.env, ...env } }) as unknown as ChildProcessWithoutNullStreams;

/**
 * Runs a single bounded, headless brain invocation. Streams assistant text/tool events
 * to `onEvent` for live mirroring, enforces a silence-timeout watchdog (lesson from
 * ORCHESTRATION-STATUS.md), and returns the accumulated text + extracted memory.
 */
export class BrainRunner {
  private readonly provider: BrainProvider;
  private readonly spawnFn: SpawnFn;
  private readonly silenceTimeoutMs: number;

  constructor(provider: BrainProvider, opts: BrainRunnerOptions = {}) {
    this.provider = provider;
    this.spawnFn = opts.spawnFn ?? defaultSpawn;
    this.silenceTimeoutMs = opts.silenceTimeoutMs ?? 90_000;
  }

  run(input: BrainInvocationInput, onEvent: (e: BrainStreamEvent) => void): Promise<BrainResult> {
    const inv = this.provider.buildInvocation(input);
    const child = this.spawnFn(inv.command, inv.args, inv.env);

    return new Promise<BrainResult>((resolve) => {
      let fullText = '';
      let aborted = false;
      let settled = false;

      const rl = readline.createInterface({ input: child.stdout });

      let silenceTimer: ReturnType<typeof setTimeout>;
      const resetSilence = () => {
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
          aborted = true;
          logger.warn('Orchestrator brain run aborted: silence timeout');
          child.kill('SIGKILL');
        }, this.silenceTimeoutMs);
      };
      resetSilence();

      rl.on('line', (line) => {
        resetSilence();
        for (const e of this.provider.parseLine(line)) {
          if (e.kind === 'text') fullText += e.text;
          onEvent(e);
        }
      });

      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(silenceTimer);
        rl.close();
        resolve({
          ok: !aborted && exitCode === 0,
          exitCode,
          fullText,
          memory: extractMemoryUpdate(fullText),
          aborted,
        });
      };

      child.on('close', (code) => finish(code));
      child.on('error', (err) => {
        logger.error({ err }, 'Orchestrator brain spawn error');
        finish(null);
      });
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/orchestrator/brain-runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/orchestrator/brain-runner.ts tests/server/orchestrator/brain-runner.test.ts
git commit -m "feat(orchestrator): bounded headless brain runner with silence watchdog"
```

---

### Task 10: OrchestratorService — queue, lifecycle, mirror

**Files:**
- Create: `server/orchestrator/orchestrator-service.ts`
- Test: `tests/server/orchestrator/orchestrator-service.test.ts`

`OrchestratorService` ties everything together. Dependencies are injected (state service, message service, memory store, a `snapshotFn`, a `runFn` that wraps BrainRunner, a `broadcastFn`, and a `mcpConfigJson` supplier) so the test drives it with fakes — no DB-of-record assumptions beyond the injected services and no real CLI.

- [ ] **Step 1: Write the failing test**

```ts
// tests/server/orchestrator/orchestrator-service.test.ts
// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';
import { OrchestratorStateService } from '../../../server/services/orchestrator-state-service';
import { OrchestratorMessageService } from '../../../server/services/orchestrator-message-service';
import { OrchestratorService } from '../../../server/orchestrator/orchestrator-service';

function makeService(overrides: Partial<Parameters<typeof OrchestratorService.prototype.constructor>[0]> = {}) {
  const db = new Database(':memory:'); runMigrations(db);
  const stateSvc = new OrchestratorStateService(db);
  stateSvc.updateConfig({ enabled: true, idle_timeout_ms: 50, model: 'haiku' });
  const msgSvc = new OrchestratorMessageService(db);
  const broadcasts: unknown[] = [];

  const runFn = vi.fn(async (_prompt: string, onEvent: (e: { kind: 'text'; text: string }) => void) => {
    onEvent({ kind: 'text', text: 'Done. ' });
    return { ok: true, exitCode: 0, fullText: 'Done.', memory: '# Orchestrator Memory\nUpdated.', aborted: false };
  });

  const svc = new OrchestratorService({
    stateService: stateSvc,
    messageService: msgSvc,
    memoryStore: { read: () => '# Orchestrator Memory\nold', write: vi.fn() } as never,
    snapshotMd: () => '### Active goals\n- (none)',
    mcpConfigJson: () => '{}',
    runFn: runFn as never,
    broadcast: (e) => broadcasts.push(e),
    ...overrides,
  });
  return { svc, stateSvc, msgSvc, runFn, broadcasts };
}

describe('OrchestratorService', () => {
  it('processes an owner_message: persists owner + orchestrator turns and writes memory', async () => {
    const { svc, msgSvc } = makeService();
    await svc.trigger({ kind: 'owner_message', text: 'status?', channel: 'app' });
    await svc.drain(); // wait for queue to empty
    const msgs = msgSvc.list(10);
    expect(msgs[0]?.role).toBe('owner');
    expect(msgs[0]?.content).toBe('status?');
    expect(msgs.some((m) => m.role === 'orchestrator' && m.content.includes('Done'))).toBe(true);
  });

  it('writes the extracted memory on a clean run', async () => {
    const writeMock = vi.fn();
    const { svc } = makeService({ memoryStore: { read: () => 'old', write: writeMock } as never });
    await svc.trigger({ kind: 'heartbeat' });
    await svc.drain();
    expect(writeMock).toHaveBeenCalledWith('# Orchestrator Memory\nUpdated.');
  });

  it('does nothing when disabled', async () => {
    const { svc, stateSvc, runFn } = makeService();
    stateSvc.updateConfig({ enabled: false });
    await svc.trigger({ kind: 'heartbeat' });
    await svc.drain();
    expect(runFn).not.toHaveBeenCalled();
  });

  it('serializes concurrent triggers (one run at a time)', async () => {
    let concurrent = 0; let maxConcurrent = 0;
    const runFn = vi.fn(async (_p: string, onEvent: (e: { kind: 'text'; text: string }) => void) => {
      concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 10));
      concurrent--;
      onEvent({ kind: 'text', text: 'x' });
      return { ok: true, exitCode: 0, fullText: 'x', memory: null, aborted: false };
    });
    const { svc } = makeService({ runFn: runFn as never });
    await Promise.all([svc.trigger({ kind: 'heartbeat' }), svc.trigger({ kind: 'heartbeat' })]);
    await svc.drain();
    expect(maxConcurrent).toBe(1);
  });

  it('returns to idle after the idle timeout', async () => {
    const { svc, stateSvc } = makeService();
    await svc.trigger({ kind: 'heartbeat' });
    await svc.drain();
    await new Promise((r) => setTimeout(r, 80)); // > idle_timeout_ms (50)
    expect(stateSvc.get().status).toBe('idle');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/orchestrator/orchestrator-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```ts
// server/orchestrator/orchestrator-service.ts
import type { ServerEvent } from '../../src/shared/events';
import type { OrchestratorTrigger, OrchestratorChannel } from '../../src/shared/orchestrator';
import type { OrchestratorStateService } from '../services/orchestrator-state-service';
import type { OrchestratorMessageService } from '../services/orchestrator-message-service';
import type { MemoryStore } from './memory-store';
import type { BrainStreamEvent, BrainResult } from './brain-provider';
import { buildContextPrompt } from './context-bundle';
import logger from '../logger';

export type RunFn = (
  prompt: string,
  onEvent: (e: BrainStreamEvent) => void,
) => Promise<BrainResult>;

export interface OrchestratorServiceDeps {
  stateService: OrchestratorStateService;
  messageService: OrchestratorMessageService;
  memoryStore: Pick<MemoryStore, 'read' | 'write'>;
  snapshotMd: () => string;
  mcpConfigJson: () => string;
  runFn: RunFn;
  broadcast: (event: ServerEvent) => void;
}

const RECENT_TURNS = 10;

/**
 * The orchestrator dispatcher. Owns a serialized trigger queue and a lifecycle state
 * machine (idle → waking → active → cooling → idle). Each trigger assembles a context
 * bundle, runs the headless brain via `runFn`, mirrors output to the chat thread + WS,
 * and persists the brain's updated memory on a clean run.
 */
export class OrchestratorService {
  private readonly deps: OrchestratorServiceDeps;
  private queue: OrchestratorTrigger[] = [];
  private processing = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private drainWaiters: Array<() => void> = [];

  constructor(deps: OrchestratorServiceDeps) {
    this.deps = deps;
  }

  /** Enqueues a trigger and kicks the queue. No-op (logs) when disabled. */
  async trigger(t: OrchestratorTrigger): Promise<void> {
    if (!this.deps.stateService.get().config.enabled) {
      logger.debug({ kind: t.kind }, 'Orchestrator trigger ignored (disabled)');
      return;
    }
    this.queue.push(t);
    void this.pump();
  }

  /** Resolves once the queue is empty and no run is in flight (test/shutdown helper). */
  drain(): Promise<void> {
    if (!this.processing && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  private async pump(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }

    try {
      while (this.queue.length > 0) {
        const t = this.queue.shift()!;
        await this.handle(t);
      }
    } finally {
      this.processing = false;
      this.startIdleTimer();
      const waiters = this.drainWaiters;
      this.drainWaiters = [];
      for (const w of waiters) w();
    }
  }

  private async handle(t: OrchestratorTrigger): Promise<void> {
    const now = Date.now();
    const { stateService, messageService, memoryStore, broadcast } = this.deps;
    const config = stateService.get().config;

    // Record the owner's message as a turn (so the thread shows it).
    if (t.kind === 'owner_message' && t.text) {
      const channel: OrchestratorChannel = t.channel ?? 'app';
      const ownerMsg = messageService.append({
        role: 'owner', channel, content: t.text, tool_calls_json: null, trigger_kind: 'owner_message',
      });
      broadcast({ type: 'orchestrator:message', message: ownerMsg });
    }

    stateService.setStatus('waking', now);
    broadcast({ type: 'orchestrator:status', status: 'waking' });

    const prompt = buildContextPrompt({
      personaName: config.persona_name,
      memory: memoryStore.read(),
      snapshotMd: this.deps.snapshotMd(),
      recentTurns: messageService.recent(RECENT_TURNS).map((m) => ({ role: m.role, content: m.content })),
      trigger: t,
    });

    stateService.setStatus('active', Date.now());
    broadcast({ type: 'orchestrator:status', status: 'active' });

    const toolCalls: Array<{ tool: string; summary: string }> = [];
    let result: BrainResult;
    try {
      result = await this.deps.runFn(prompt, (e) => {
        if (e.kind === 'tool') {
          toolCalls.push({ tool: e.tool, summary: e.summary });
          broadcast({ type: 'orchestrator:tool', tool: e.tool, summary: e.summary });
        }
      });
    } catch (err) {
      logger.error({ err, kind: t.kind }, 'Orchestrator run threw');
      const sysMsg = messageService.append({
        role: 'system', channel: 'internal',
        content: `Run failed: ${err instanceof Error ? err.message : String(err)}`,
        tool_calls_json: null, trigger_kind: t.kind,
      });
      broadcast({ type: 'orchestrator:message', message: sysMsg });
      return;
    }

    // Strip the memory block from the visible reply.
    const visible = result.fullText.replace(/<memory-update>[\s\S]*?<\/memory-update>/g, '').trim();
    const reply = messageService.append({
      role: 'orchestrator', channel: 'app',
      content: visible.length ? visible : (result.aborted ? '(run aborted — no output)' : '(no reply)'),
      tool_calls_json: toolCalls.length ? JSON.stringify(toolCalls) : null,
      trigger_kind: t.kind,
    });
    broadcast({ type: 'orchestrator:message', message: reply });

    // Persist updated memory only on a clean run.
    if (result.ok && result.memory) {
      memoryStore.write(result.memory);
    }
  }

  private startIdleTimer(): void {
    const { idle_timeout_ms } = this.deps.stateService.get().config;
    this.deps.stateService.setStatus('cooling', Date.now());
    this.deps.broadcast({ type: 'orchestrator:status', status: 'cooling' });
    this.idleTimer = setTimeout(() => {
      this.deps.stateService.setStatus('idle', Date.now());
      this.deps.broadcast({ type: 'orchestrator:status', status: 'idle' });
    }, idle_timeout_ms);
    this.idleTimer.unref?.();
  }

  /** Clears timers on shutdown. */
  shutdown(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.deps.stateService.setStatus('idle', Date.now());
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/orchestrator/orchestrator-service.test.ts`
Expected: PASS. (This test depends on the `orchestrator:*` events added in Task 12 being valid `ServerEvent`s. If running Task 10 before Task 12, the `broadcast(...)` calls will fail typecheck — implement Task 12 first or temporarily cast. Recommended order: do Task 12 immediately after this test is written.)

- [ ] **Step 5: Commit**

```bash
git add server/orchestrator/orchestrator-service.ts tests/server/orchestrator/orchestrator-service.test.ts
git commit -m "feat(orchestrator): dispatcher service — queue, lifecycle, mirror, memory persist"
```

---

### Task 11: Governance — fan-out & depth caps

**Files:**
- Modify: `server/orchestrator/orchestrator-service.ts`
- Test: `tests/server/orchestrator/orchestrator-governance.test.ts`

The orchestrator can create goals (children) via MCP. Governance caps how many children may be live and how deep the spawn chain may go. The service exposes a guard the wiring consults before allowing a child-spawning MCP action, and surfaces a cap hit as a recommendation message rather than a silent block.

- [ ] **Step 1: Write the failing test**

```ts
// tests/server/orchestrator/orchestrator-governance.test.ts
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';
import { OrchestratorStateService } from '../../../server/services/orchestrator-state-service';
import { OrchestratorMessageService } from '../../../server/services/orchestrator-message-service';
import { OrchestratorService } from '../../../server/orchestrator/orchestrator-service';

function makeSvc() {
  const db = new Database(':memory:'); runMigrations(db);
  const stateSvc = new OrchestratorStateService(db);
  stateSvc.updateConfig({ enabled: true, max_concurrent_children: 2, max_depth: 1 });
  const svc = new OrchestratorService({
    stateService: stateSvc,
    messageService: new OrchestratorMessageService(db),
    memoryStore: { read: () => '', write: vi.fn() } as never,
    snapshotMd: () => '', mcpConfigJson: () => '{}',
    runFn: (async () => ({ ok: true, exitCode: 0, fullText: '', memory: null, aborted: false })) as never,
    broadcast: () => {},
  });
  return svc;
}

describe('OrchestratorService governance', () => {
  it('allows spawning under the concurrency cap', () => {
    const svc = makeSvc();
    expect(svc.canSpawnChild({ liveChildren: 1, depth: 0 }).allowed).toBe(true);
  });
  it('blocks spawning at the concurrency cap', () => {
    const svc = makeSvc();
    const v = svc.canSpawnChild({ liveChildren: 2, depth: 0 });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('concurrent');
  });
  it('blocks spawning beyond the depth cap', () => {
    const svc = makeSvc();
    const v = svc.canSpawnChild({ liveChildren: 0, depth: 1 });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('depth');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/orchestrator/orchestrator-governance.test.ts`
Expected: FAIL — `canSpawnChild` is not a function.

- [ ] **Step 3: Add the guard to `orchestrator-service.ts`**

Add this method to the `OrchestratorService` class (e.g. just above `shutdown()`):

```ts
  /**
   * Governance guard for orchestrator-spawned children. Consulted by the wiring
   * before permitting a child-spawning MCP action. Returns allow + reason.
   */
  canSpawnChild(ctx: { liveChildren: number; depth: number }): { allowed: boolean; reason: string } {
    const { max_concurrent_children, max_depth } = this.deps.stateService.get().config;
    if (ctx.depth >= max_depth) {
      return { allowed: false, reason: `orchestration depth cap reached (max_depth=${max_depth})` };
    }
    if (ctx.liveChildren >= max_concurrent_children) {
      return { allowed: false, reason: `concurrent children cap reached (max_concurrent_children=${max_concurrent_children})` };
    }
    return { allowed: true, reason: 'ok' };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/orchestrator/orchestrator-governance.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/orchestrator/orchestrator-service.ts tests/server/orchestrator/orchestrator-governance.test.ts
git commit -m "feat(orchestrator): fan-out and depth governance guard"
```

---

### Task 12: Orchestrator WebSocket events

**Files:**
- Modify: `src/shared/events.ts`
- Modify: `server/ws.ts:99-123` (the `getEventGoalId` switch)
- Test: `tests/shared/orchestrator-events.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/shared/orchestrator-events.test.ts
import { describe, it, expect } from 'vitest';
import { ServerEventSchema } from '../../src/shared/events';

describe('orchestrator server events', () => {
  it('validates orchestrator:message', () => {
    const ev = {
      type: 'orchestrator:message',
      message: { id: 'm1', role: 'orchestrator', channel: 'app', content: 'hi', tool_calls_json: null, trigger_kind: null, created_at: 1 },
    };
    expect(ServerEventSchema.parse(ev).type).toBe('orchestrator:message');
  });
  it('validates orchestrator:status', () => {
    expect(ServerEventSchema.parse({ type: 'orchestrator:status', status: 'active' }).type).toBe('orchestrator:status');
  });
  it('validates orchestrator:tool', () => {
    expect(ServerEventSchema.parse({ type: 'orchestrator:tool', tool: 'create_goal', summary: '{}' }).type).toBe('orchestrator:tool');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/shared/orchestrator-events.test.ts`
Expected: FAIL — these event types are not in the union.

- [ ] **Step 3: Add the event schemas**

In `src/shared/events.ts`, add the import and three schemas, then register them in the union.

At the top, extend the schema import from `./schemas`/add a new import:

```ts
import { OrchestratorMessageSchema, OrchestratorStatusSchema } from './orchestrator';
```

Add near the other event schemas (e.g. after `ConversationUpdatedEventSchema`):

```ts
export const OrchestratorMessageEventSchema = z.object({
  type: z.literal('orchestrator:message'),
  message: OrchestratorMessageSchema,
});

export const OrchestratorStatusEventSchema = z.object({
  type: z.literal('orchestrator:status'),
  status: OrchestratorStatusSchema,
});

export const OrchestratorToolEventSchema = z.object({
  type: z.literal('orchestrator:tool'),
  tool: z.string(),
  summary: z.string(),
});
```

Add the three to the `ServerEventSchema` discriminated union array:

```ts
  OrchestratorMessageEventSchema,
  OrchestratorStatusEventSchema,
  OrchestratorToolEventSchema,
```

- [ ] **Step 4: Make `getEventGoalId` return null for the new events**

In `server/ws.ts`, the `getEventGoalId` switch already returns `null` from its `default` branch, so orchestrator events (which have no goal) broadcast to all subscribed clients with no change required. Add an explicit case for clarity (optional but preferred):

```ts
    case 'orchestrator:message':
    case 'orchestrator:status':
    case 'orchestrator:tool':
      return null;
```

(Place these cases just before `default:`.)

- [ ] **Step 5: Run test + typecheck**

Run: `npx vitest run tests/shared/orchestrator-events.test.ts && npm run typecheck`
Expected: PASS, no type errors. (This also unblocks the `broadcast(...)` calls in Task 10.)

- [ ] **Step 6: Commit**

```bash
git add src/shared/events.ts server/ws.ts tests/shared/orchestrator-events.test.ts
git commit -m "feat(orchestrator): websocket events (message, status, tool)"
```

---

### Task 13: REST routes

**Files:**
- Create: `server/routes/orchestrator.ts`
- Test: `tests/server/routes/orchestrator-routes.test.ts`

Routes follow the existing `createXRouter(...)` pattern (see `server/routes/scheduled.ts`). Endpoints:
- `GET  /api/orchestrator` → `{ state, messages }`
- `POST /api/orchestrator/messages` → posts an owner message (triggers the service), returns 202
- `PUT  /api/orchestrator/config` → updates config
- `POST /api/orchestrator/decision` → ratify/deny an approval the orchestrator recommended on (proxies to the approval coordinator)

- [ ] **Step 1: Write the failing test**

This test follows the existing route-test idiom (`tests/server/routes/scheduled.test.ts`): a real `http.Server` on a random port driven by native `fetch`, with `ws` and `logger` mocked. **No `supertest` dependency** (it is not installed in this repo).

```ts
// tests/server/routes/orchestrator-routes.test.ts
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';
import { OrchestratorStateService } from '../../../server/services/orchestrator-state-service';
import { OrchestratorMessageService } from '../../../server/services/orchestrator-message-service';
import { createOrchestratorRouter } from '../../../server/routes/orchestrator';

vi.mock('../../../server/ws', () => ({ broadcast: vi.fn() }));
vi.mock('../../../server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('orchestrator routes', () => {
  let server: http.Server;
  let port: number;
  let trigger: ReturnType<typeof vi.fn>;
  let ratify: ReturnType<typeof vi.fn>;

  const url = (p: string) => `http://127.0.0.1:${port}/api${p}`;

  beforeEach(async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const stateService = new OrchestratorStateService(db);
    const messageService = new OrchestratorMessageService(db);
    trigger = vi.fn(async () => {});
    ratify = vi.fn(() => true);

    const app = express();
    app.use(express.json());
    app.use('/api', createOrchestratorRouter({ stateService, messageService, trigger, ratifyApproval: ratify }));

    port = await new Promise<number>((resolve) => {
      server = http.createServer(app);
      server.listen(0, () => {
        const addr = server.address();
        resolve(addr && typeof addr === 'object' ? addr.port : 0);
      });
    });
  });

  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('GET /api/orchestrator returns state + messages', async () => {
    const res = await fetch(url('/orchestrator'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state.config.persona_name).toBe('Hawat');
    expect(Array.isArray(body.messages)).toBe(true);
  });

  it('POST /api/orchestrator/messages triggers the service and returns 202', async () => {
    const res = await fetch(url('/orchestrator/messages'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'status?' }),
    });
    expect(res.status).toBe(202);
    expect(trigger).toHaveBeenCalledWith({ kind: 'owner_message', text: 'status?', channel: 'app' });
  });

  it('POST /api/orchestrator/messages rejects empty text with 400', async () => {
    const res = await fetch(url('/orchestrator/messages'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('PUT /api/orchestrator/config updates and returns the new config', async () => {
    const res = await fetch(url('/orchestrator/config'), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, persona_name: 'Thufir' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).persona_name).toBe('Thufir');
  });

  it('POST /api/orchestrator/decision ratifies via the coordinator', async () => {
    const res = await fetch(url('/orchestrator/decision'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approvalId: 'a1', decision: 'approved' }),
    });
    expect(res.status).toBe(200);
    expect(ratify).toHaveBeenCalledWith('a1', 'approved', undefined);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/routes/orchestrator-routes.test.ts`
Expected: FAIL — module `server/routes/orchestrator` not found.

- [ ] **Step 3: Write the router**

```ts
// server/routes/orchestrator.ts
import { Router } from 'express';
import { ZodError } from 'zod';
import {
  PostOwnerMessageSchema,
  UpdateOrchestratorConfigSchema,
  type OrchestratorTrigger,
} from '../../src/shared/orchestrator';
import { ApprovalDecisionSchema } from '../../src/shared/schemas';
import type { OrchestratorStateService } from '../services/orchestrator-state-service';
import type { OrchestratorMessageService } from '../services/orchestrator-message-service';
import logger from '../logger';

export interface OrchestratorRouterDeps {
  stateService: OrchestratorStateService;
  messageService: OrchestratorMessageService;
  trigger: (t: OrchestratorTrigger) => Promise<void>;
  /** Resolves an approval through the ApprovalCoordinator. Returns false if stale. */
  ratifyApproval: (approvalId: string, decision: 'approved' | 'denied', reason?: string) => boolean;
}

const MESSAGE_PAGE = 200;

/** REST API for the orchestrator (thread, owner messages, config, ratify decisions). */
export function createOrchestratorRouter(deps: OrchestratorRouterDeps): Router {
  const router = Router();

  router.get('/orchestrator', (_req, res) => {
    res.json({
      state: deps.stateService.get(),
      messages: deps.messageService.list(MESSAGE_PAGE),
    });
  });

  router.post('/orchestrator/messages', (req, res) => {
    const parsed = PostOwnerMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid message', issues: parsed.error.issues });
      return;
    }
    void deps.trigger({ kind: 'owner_message', text: parsed.data.text, channel: parsed.data.channel ?? 'app' });
    res.status(202).json({ accepted: true });
  });

  router.put('/orchestrator/config', (req, res) => {
    const parsed = UpdateOrchestratorConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid config', issues: parsed.error.issues });
      return;
    }
    try {
      res.json(deps.stateService.updateConfig(parsed.data));
    } catch (err) {
      if (err instanceof ZodError) { res.status(400).json({ error: 'Invalid config', issues: err.issues }); return; }
      throw err;
    }
  });

  router.post('/orchestrator/decision', (req, res) => {
    const body = req.body as { approvalId?: unknown; decision?: unknown; reason?: unknown };
    if (typeof body.approvalId !== 'string') { res.status(400).json({ error: 'approvalId required' }); return; }
    const decision = ApprovalDecisionSchema.safeParse(body.decision);
    if (!decision.success || (decision.data !== 'approved' && decision.data !== 'denied')) {
      res.status(400).json({ error: 'decision must be approved or denied' });
      return;
    }
    const reason = typeof body.reason === 'string' ? body.reason : undefined;
    const ok = deps.ratifyApproval(body.approvalId, decision.data, reason);
    if (!ok) { res.status(409).json({ error: 'approval not pending (stale or already resolved)' }); return; }
    logger.info({ approvalId: body.approvalId, decision: decision.data }, 'Orchestrator decision ratified');
    res.json({ ok: true });
  });

  return router;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/routes/orchestrator-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes/orchestrator.ts tests/server/routes/orchestrator-routes.test.ts
git commit -m "feat(orchestrator): REST routes (thread, messages, config, decision)"
```

---

### Task 14: Wire triggers + service into the server

**Files:**
- Modify: `server/approval-coordinator.ts` (add optional observer)
- Modify: `server/scheduler.ts` (add optional `onFire`)
- Modify: `server/index.ts` (instantiate, wire triggers, heartbeat, shutdown)
- Test: `tests/server/orchestrator/wiring.test.ts`

- [ ] **Step 1: Write the failing test (approval observer + scheduler onFire)**

```ts
// tests/server/orchestrator/wiring.test.ts
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';
import { ApprovalCoordinator } from '../../../server/approval-coordinator';

describe('ApprovalCoordinator observer', () => {
  it('invokes onApprovalPending with the approval id when a supervised approval is requested', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const observer = vi.fn();
    const coord = new ApprovalCoordinator(db, 30 * 60 * 1000, observer);
    // fire-and-forget: request() resolves only on decision/timeout
    void coord.request({ session_id: 's1', goal_id: 'g1', tool_name: 'Bash', tool_args: '{}' }, false);
    await new Promise((r) => setImmediate(r));
    expect(observer).toHaveBeenCalledWith(expect.objectContaining({ goal_id: 'g1', tool_name: 'Bash' }));
  });

  it('does NOT invoke the observer for autonomous (auto-approved) requests', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const observer = vi.fn();
    const coord = new ApprovalCoordinator(db, 1000, observer);
    await coord.request({ session_id: 's1', goal_id: 'g1', tool_name: 'Read', tool_args: '{}' }, true);
    expect(observer).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/orchestrator/wiring.test.ts`
Expected: FAIL — `ApprovalCoordinator` constructor takes 2 args, observer not supported.

- [ ] **Step 3a: Add the observer to `ApprovalCoordinator`**

In `server/approval-coordinator.ts`, extend the constructor and call the observer in `request()` on the supervised path (after broadcasting pending, before creating the deferred):

```ts
// Add field + constructor param:
  private onApprovalPending: ((approval: Approval) => void) | undefined;

  constructor(
    db: Database.Database,
    timeoutMs: number = 30 * 60 * 1000,
    onApprovalPending?: (approval: Approval) => void,
  ) {
    this.db = db;
    this.timeoutMs = timeoutMs;
    this.onApprovalPending = onApprovalPending;
  }
```

In `request()`, immediately after the `broadcast({ type: 'approval:pending', ... })` call and BEFORE the `if (isAutonomous)` block, notify the observer only for supervised requests:

```ts
    if (!isAutonomous && this.onApprovalPending) {
      try { this.onApprovalPending(approval); } catch (err) {
        logger.warn({ err }, 'onApprovalPending observer threw');
      }
    }
```

- [ ] **Step 3b: Add `onFire` to `Scheduler`**

In `server/scheduler.ts`, add an optional callback param and invoke it inside `fireTask` after the goal is created:

```ts
// constructor signature becomes:
  constructor(
    taskService: ScheduledTaskService,
    createGoal: GoalCreator,
    onFire?: (info: { taskId: string; goalId: string }) => void,
  ) {
    this.taskService = taskService;
    this.createGoal = createGoal;
    this.onFire = onFire;
  }
  private readonly onFire: ((info: { taskId: string; goalId: string }) => void) | undefined;
```

In `fireTask`, after `const goal = this.createGoal(goalInput);` and `recordRun(...)`:

```ts
    if (this.onFire) {
      try { this.onFire({ taskId: task.id, goalId: goal.id }); } catch (err) {
        logger.warn({ taskId: task.id, err }, 'Scheduler onFire callback threw');
      }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/orchestrator/wiring.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire everything in `server/index.ts`**

This step has no new unit test (it is composition of already-tested units; verified by `npm run typecheck` + a manual smoke). Add the following.

Imports (top of file, with the other imports):

```ts
import { OrchestratorStateService } from './services/orchestrator-state-service';
import { OrchestratorMessageService } from './services/orchestrator-message-service';
import { MemoryStore } from './orchestrator/memory-store';
import { buildSnapshot } from './orchestrator/snapshot';
import { ClaudeBrainProvider } from './orchestrator/brain-provider';
import { BrainRunner } from './orchestrator/brain-runner';
import { OrchestratorService } from './orchestrator/orchestrator-service';
import { createOrchestratorRouter } from './routes/orchestrator';
import cron from 'node-cron';
```

After the existing services are constructed (after the `approvalCoordinator` line ~111) — note we must build the orchestrator BEFORE the approval coordinator so the observer can reference it, OR use a late-bound reference. Use a late-bound holder to avoid ordering issues:

```ts
// Late-bound so the approval observer can reach the orchestrator built below.
let orchestrator: OrchestratorService | null = null;
```

Change the `approvalCoordinator` construction to pass an observer:

```ts
const approvalCoordinator = new ApprovalCoordinator(db, 30 * 60 * 1000, (approval) => {
  void orchestrator?.trigger({ kind: 'approval', approvalId: approval.id, goalId: approval.goal_id ?? undefined });
});
```

After `messageService` is constructed (~line 127), build the orchestrator stack:

```ts
// ── Orchestrator ─────────────────────────────────────────────────────────────
const orchestratorStateService = new OrchestratorStateService(db);
const orchestratorMessageService = new OrchestratorMessageService(db);
const memoryStore = new MemoryStore(env.dataDir);

/** Serializes the claude-deck MCP descriptor the brain attaches to (same server the UI uses). */
function orchestratorMcpConfigJson(): string {
  // Mirrors mcp/dist/index.js registration; CLAUDE_DECK_URL points the MCP at this server.
  const mcpPath = join(process.cwd(), 'mcp', 'dist', 'index.js');
  return JSON.stringify({
    mcpServers: {
      'claude-deck': { command: 'node', args: [mcpPath], env: { CLAUDE_DECK_URL: `http://127.0.0.1:${env.port}` } },
    },
  });
}

// Brain binary resolution. PREREQUISITE SEAM: once the agent-adapter foundation is
// built, replace this with: adapterForModel(cfg.model, ['claude']).resolveBinary().
const brainBinary = process.env['CLAUDE_BIN'] ?? 'claude';
const brainRunner = new BrainRunner(new ClaudeBrainProvider(brainBinary));

orchestrator = new OrchestratorService({
  stateService: orchestratorStateService,
  messageService: orchestratorMessageService,
  memoryStore,
  snapshotMd: () => buildSnapshot(db).toMarkdown(),
  mcpConfigJson: orchestratorMcpConfigJson,
  runFn: (prompt, onEvent) => brainRunner.run(
    {
      prompt,
      model: orchestratorStateService.get().config.model,
      mcpConfigJson: orchestratorMcpConfigJson(),
      permissionMode: 'supervised',
    },
    onEvent,
  ),
  broadcast,
});
```

Wire the scheduler `onFire` (modify the existing `new Scheduler(...)` at ~line 224):

```ts
const scheduler = new Scheduler(scheduledTaskService, createGoal, (info) => {
  void orchestrator?.trigger({ kind: 'scheduled', taskId: info.taskId, goalId: info.goalId });
});
```

Register the router (add to the `createApp({ apiRouters: [...] })` array ~line 296):

```ts
const orchestratorRouter = createOrchestratorRouter({
  stateService: orchestratorStateService,
  messageService: orchestratorMessageService,
  trigger: (t) => orchestrator!.trigger(t),
  ratifyApproval: (id, decision, reason) => approvalCoordinator.resolve(id, decision, reason),
});
// ...add `orchestratorRouter` to the apiRouters array.
```

Add the heartbeat after `scheduler.start();` (~line 305):

```ts
// Orchestrator heartbeat sweep — every 3 minutes, only fires a trigger when enabled.
const heartbeatJob = cron.schedule('*/3 * * * *', () => {
  if (orchestratorStateService.get().config.enabled) {
    void orchestrator?.trigger({ kind: 'heartbeat' });
  }
});
```

In `shutdown()` (~line 313), stop the heartbeat and the orchestrator (add near `scheduler.stop()`):

```ts
  heartbeatJob.stop();
  orchestrator?.shutdown();
```

- [ ] **Step 6: Typecheck + full test run + manual smoke**

Run:
```bash
npm run typecheck
npx vitest run tests/server/orchestrator tests/server/services/orchestrator-state-service.test.ts tests/server/services/orchestrator-message-service.test.ts tests/server/routes/orchestrator-routes.test.ts tests/shared/orchestrator-schemas.test.ts tests/shared/orchestrator-events.test.ts
```
Expected: typecheck clean; all orchestrator tests PASS.

Manual smoke (server running via `npm run dev`):
```bash
# Enable the orchestrator
curl -X PUT http://127.0.0.1:4100/api/orchestrator/config -H 'content-type: application/json' -d '{"enabled":true}'
# Post a message
curl -X POST http://127.0.0.1:4100/api/orchestrator/messages -H 'content-type: application/json' -d '{"text":"What is on the board?"}'
# Read the thread back
curl http://127.0.0.1:4100/api/orchestrator
```
Expected: the GET returns the owner message and (after the brain run) an orchestrator reply; `<dataDir>/orchestrator/memory.md` is created/updated.

- [ ] **Step 7: Commit**

```bash
git add server/approval-coordinator.ts server/scheduler.ts server/index.ts tests/server/orchestrator/wiring.test.ts
git commit -m "feat(orchestrator): wire triggers, heartbeat, and service into the server"
```

---

## Self-Review

**Spec coverage** (against `2026-06-08-orchestrator-design.md`):
- §3 two faces/one brain → message thread + events (Tasks 4, 12); Discord face is Plan 2.
- §4.1 dispatcher → Task 10. §4.2 triggers → Tasks 10/14 (owner, approval, session via approval/scheduler, heartbeat). **Note:** true mid-run "stall" detection is approximated by approval + scheduler triggers in v1; a dedicated PtyManager silence signal is deferred (called out below).
- §4.3 headless brain via adapter → Tasks 8/9/14 (with prerequisite seam). §4.6 memory + snapshot → Tasks 5/6/7.
- §5 wake cycle → Task 10. §6 governance → Task 11. §7 idle-stop → Task 10. §10 watchdog/backoff → Task 9 (silence timeout); rate-limit backoff is surfaced by the brain reporting it (deferred hard-backoff noted below). §11 data model → Tasks 1/3/4/5. §4.5 visible thread/recommendation cards → events here, UI in Plan 2.
- §4.7 persona config → Tasks 1/3 (stored), editable via Task 13 `PUT /config`; Settings UI is Plan 2.

**Known deferrals (intentional, documented):**
1. **Mid-session stall detection** — v1 triggers on approval + session-ended + scheduled + heartbeat. A PtyManager "no output for N seconds" signal is a follow-on enhancement.
2. **Hard rate-limit backoff** (pause queue on 429) — v1 relies on the brain reporting it cannot proceed; a structured 429 detector on the stream is a follow-on.
3. **Child accounting for governance** — `canSpawnChild` is implemented and unit-tested; wiring it into the MCP create-goal path (counting live orchestrator children + tracking depth) is completed in Plan 2 / a follow-on when the MCP gains an orchestrator-origin tag.
4. **memory-write via MCP tool** — resolved in favor of the delimited `<memory-update>` block (Task 7/8), avoiding an 11th MCP tool and giving the runner full control.

**Placeholder scan:** none — every step contains runnable code/commands.

**Type consistency:** `OrchestratorTrigger`, `OrchestratorConfig`, `BrainResult`, `BrainStreamEvent`, `OrchestratorService` deps, and the `orchestrator:*` event shapes are defined once (Tasks 2/8/9/10/12) and referenced consistently. `ratifyApproval` maps to `ApprovalCoordinator.resolve(id, decision, reason)` (Task 13/14). Migration version is **15** (14 is taken by `hook_events_session_index`).

---

## Execution note

Recommended task order is sequential 1→14, with one exception: **do Task 12 (events) right after writing Task 10's test**, because Task 10's `broadcast(...)` calls reference the `orchestrator:*` events. The plan calls this out inline in Task 10 Step 4.
