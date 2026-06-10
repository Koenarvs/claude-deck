# Orchestrator "Faces" (Plan 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This plan **consumes** the Orchestrator Core plan (`2026-06-08-orchestrator-core.md`) — it does **not** rebuild `OrchestratorService`, the shared types, the tables, the REST routes, or the WS events. It adds the two front-ends ("faces") that share the core's single conversation thread, plus the persona Settings section.

---

## Spec preamble

This is **Plan 2 (Faces)** of the orchestrator design (`docs/superpowers/specs/2026-06-08-orchestrator-design.md`, §3 "two faces, one brain"; §4.4 Discord channel adapter; §4.5 in-app tab; §4.7 persona Settings; §9 transparency). There is **one** orchestrator (the core's `OrchestratorService`), reachable through two front-ends that post into the **same** thread:

1. **In-app Orchestrator tab** — a persistent chat surface (new route `/orchestrator`, page, Sidebar entry, Zustand store). It renders `orchestrator_messages`, streams live brain output via the core's `orchestrator:message` / `orchestrator:status` / `orchestrator:tool` WS events, and posts owner messages to the core's `POST /api/orchestrator/messages`. **Transparency guarantee:** every tool call and spawned session is visible here (a tool-call log rendered from `orchestrator:tool` events + the persisted `tool_calls_json`).
2. **Discord** — the remote face to the *same* conversation, **single-user locked** to the paired owner. Built behind a **`ChannelAdapter` interface** so Slack/Teams slot in later untouched. Inbound: a paired-owner message → `OrchestratorTrigger{ kind:'owner_message', channel:'discord' }`. Outbound: a mirror of the brain's streamed reply. Non-owner inbound is dropped and logged (TOS guardrail #1).
3. **Persona Settings** — a Settings "Orchestrator" section editing `OrchestratorConfig` (`persona_name` default `'Hawat'`, `model`, `idle_timeout_ms`, `enabled`, `max_concurrent_children`, `max_depth`) via the core's `GET /api/orchestrator` + `PUT /api/orchestrator/config`. **Model choices come from the Phase 1 provider catalog** (`/api/config` → `providers: AgentCatalogEntry[]`, surfaced via `modelOptionsFromCatalog`); the brain is provider-pluggable with a cost-effective default (`haiku`).

**Tech stack:** TypeScript 5.5 (strict), Express v5, better-sqlite3, ws, Zod, React 19, Zustand, Vitest. Node 24. Follows existing route/page/store/event patterns in `server/` and `src/`.

### Channel-adapter design decision (resolves design §14 Q5 "Discord transport")

The repo's Discord integration is an **MCP plugin** (`mcp__plugin_discord_discord__{reply,fetch_messages,react,edit_message}` tools) that **Claude Code itself** invokes — it is not a server-side library and is **not on the server's dependency list** (`package.json` has no discord client). Two consequences bind this plan:

- **Outbound mirror** is performed by the **brain run**: because the headless brain already has tools attached, the orchestrator's reply reaches Discord when the brain calls the `reply` tool. The server-side `DiscordChannelAdapter.send()` therefore writes a structured **outbound directive** that the core's context bundle instructs the brain to honor (the brain is told, when the trigger `channel === 'discord'`, to call the discord `reply` tool with the given `chat_id`). This keeps the server free of a Discord client and respects the plugin's own rule that "anything you want the user to see must go through the reply tool."
- **Inbound** owner messages arrive as Discord `<channel source="discord" …>` tags handled by the harness/skill, which POSTs them to a **new server ingress route** `POST /api/orchestrator/channels/discord/inbound` (added in this plan). The route enforces the **single-user lock** against the paired owner identity stored in `OrchestratorConfig` and converts an allowed message into an `owner_message` trigger with `channel:'discord'`.

So the `ChannelAdapter` is a thin server-side contract — `id`, `isOwner(identity)`, `toTrigger(inbound)`, `formatOutbound(message)` — fully testable with a **`FakeChannelAdapter`**; the real `DiscordChannelAdapter` adds the owner-lock check and the outbound directive shape. **No discord plugin is hit in any test.**

### What this plan consumes (do NOT redefine — verbatim from the Core plan)

- `OrchestratorMessage`, `OrchestratorTrigger`, `OrchestratorConfig`, `OrchestratorStateRecord`, and their Zod schemas in `src/shared/orchestrator.ts`.
- `OrchestratorService.trigger(t)`, `OrchestratorStateService`, `OrchestratorMessageService`.
- REST: `GET /api/orchestrator` → `{ state, messages }`; `POST /api/orchestrator/messages`; `PUT /api/orchestrator/config`; `POST /api/orchestrator/decision`.
- WS: `orchestrator:message` (`{ type, message: OrchestratorMessage }`), `orchestrator:status` (`{ type, status }`), `orchestrator:tool` (`{ type, tool, summary }`).
- Tables `orchestrator_messages` + `orchestrator_state` (migration 015).
- Provider catalog from Phase 1: `/api/config` returns `providers: AgentCatalogEntry[]`; helper `modelOptionsFromCatalog` in `src/shared/agents/catalog-client.ts`.

### Contract additions this plan introduces (small, additive — none break the Core contract)

- `OrchestratorConfig.discord_owner_id: string | null` (default `null`) — the single paired Discord user id the inbound lock checks against. Added to the shared schema + `DEFAULT_ORCHESTRATOR_CONFIG` (Task 1). This is the only schema change; it is optional/nullable and back-compatible with the migration-015 seed (the `OrchestratorConfigSchema.parse({ ...DEFAULT, ...stored })` merge in `OrchestratorStateService.get()` defaults it).
- A server-side `ChannelAdapter` interface (`server/orchestrator/channels/channel-adapter.ts`) — new, not in the Core contract.

### Migrations

**None.** This plan consumes the Core plan's migration `015_orchestrator.sql`. `discord_owner_id` lives inside the existing `config_json` blob of `orchestrator_state` (no column/table change). No new migration number is allocated.

### Prerequisites

- **Core plan (Plan 1)** built first (tables, services, routes, WS events, `src/shared/orchestrator.ts`).
- **Phase 1** (provider catalog: `/api/config` returns `providers`, `catalog-client.ts` exists). A fallback is provided in Task 6 (Settings) if the catalog is absent, so this plan stays executable.
- **Phase 4A** (approvals real) — the in-app recommendation/decision UI (Task 5) calls `POST /api/orchestrator/decision`, which the Core wires to `ApprovalCoordinator.resolve`. If 4A is not yet landed, the decision buttons render but the proxied resolve is a no-op; the chat/message faces work regardless.

### File structure

**New (shared):**
- `src/shared/orchestrator-channels.ts` — channel-inbound Zod schema + types shared by route + client (Task 1 helper).

**New (server):**
- `server/orchestrator/channels/channel-adapter.ts` — `ChannelAdapter` interface + types.
- `server/orchestrator/channels/discord-channel-adapter.ts` — `DiscordChannelAdapter` (owner-locked).
- `server/routes/orchestrator-channels.ts` — `POST /api/orchestrator/channels/:channel/inbound` ingress.

**New (client):**
- `src/stores/useOrchestratorStore.ts` — thread + status + tool-log state.
- `src/pages/OrchestratorPage.tsx` — the chat surface.
- `src/components/orchestrator/OrchestratorThread.tsx` — message list + tool-call log.
- `src/components/orchestrator/OrchestratorComposer.tsx` — owner input bar.
- `src/components/orchestrator/RecommendationCard.tsx` — ratify/deny controls for approval/stall turns.
- `src/components/orchestrator/OrchestratorStatusPill.tsx` — lifecycle indicator.
- `src/components/settings/OrchestratorSection.tsx` — persona + config Settings section.

**Modified:**
- `src/shared/orchestrator.ts` — add `discord_owner_id` to schema + default (Task 1).
- `src/lib/ws-manager.ts` — dispatch the three `orchestrator:*` events into the store (Task 4).
- `src/routes.tsx` — add the `/orchestrator` route (Task 5).
- `src/components/Sidebar.tsx` — add the Orchestrator nav entry (Task 5).
- `src/pages/SettingsPage.tsx` — render `OrchestratorSection` (Task 6).
- `server/index.ts` — instantiate the Discord adapter, register the channels router (Task 3).

**Tests:** `tests/server/orchestrator/**`, `tests/server/routes/**` (node project), `tests/client/**` + `tests/shared/**` (jsdom project), per `vite.config.ts` projects.

---

### Task 1: Shared additions — `discord_owner_id` config field + channel-inbound schema

**Files:**
- Modify: `src/shared/orchestrator.ts`
- Create: `src/shared/orchestrator-channels.ts`
- Test: `tests/shared/orchestrator-channels.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/shared/orchestrator-channels.test.ts
import { describe, it, expect } from 'vitest';
import {
  OrchestratorConfigSchema,
  DEFAULT_ORCHESTRATOR_CONFIG,
} from '../../src/shared/orchestrator';
import { ChannelInboundSchema } from '../../src/shared/orchestrator-channels';

describe('discord_owner_id config field', () => {
  it('defaults discord_owner_id to null', () => {
    const parsed = OrchestratorConfigSchema.parse(DEFAULT_ORCHESTRATOR_CONFIG);
    expect(parsed.discord_owner_id).toBeNull();
  });

  it('accepts a string owner id and back-fills null when omitted (migration-015 seed)', () => {
    const fromSeed = OrchestratorConfigSchema.parse({
      ...DEFAULT_ORCHESTRATOR_CONFIG,
      // simulate a stored blob written before this field existed
      enabled: true, persona_name: 'Hawat', model: 'haiku',
      idle_timeout_ms: 600000, max_concurrent_children: 3, max_depth: 2,
    });
    expect(fromSeed.discord_owner_id).toBeNull();
    expect(OrchestratorConfigSchema.parse({ ...DEFAULT_ORCHESTRATOR_CONFIG, discord_owner_id: '42' }).discord_owner_id).toBe('42');
  });
});

describe('ChannelInboundSchema', () => {
  it('requires userId, text, and chatId', () => {
    expect(() => ChannelInboundSchema.parse({ text: 'hi' })).toThrow();
    const ok = ChannelInboundSchema.parse({ userId: 'u1', text: 'status?', chatId: 'c1' });
    expect(ok.userId).toBe('u1');
    expect(ok.messageId).toBeUndefined();
  });

  it('rejects empty text', () => {
    expect(() => ChannelInboundSchema.parse({ userId: 'u1', text: '', chatId: 'c1' })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/shared/orchestrator-channels.test.ts`
Expected: FAIL — `discord_owner_id` missing from schema; `src/shared/orchestrator-channels` not found.

- [ ] **Step 3a: Add `discord_owner_id` to `OrchestratorConfigSchema` + default**

In `src/shared/orchestrator.ts`, add the field to the schema object (after `max_depth`):

```ts
  max_depth: z.number().int().min(0),
  /** Single paired Discord user id the inbound channel lock checks against. null = unpaired. */
  discord_owner_id: z.string().nullable().default(null),
```

And add it to `DEFAULT_ORCHESTRATOR_CONFIG`:

```ts
export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  enabled: false,
  persona_name: 'Hawat',
  model: 'haiku',
  idle_timeout_ms: 600_000,
  max_concurrent_children: 3,
  max_depth: 2,
  discord_owner_id: null,
};
```

> Note: `.default(null)` makes the field optional on parse, so the migration-015 seed JSON (which lacks the field) still validates and back-fills `null` via the existing `OrchestratorStateService.get()` merge. `UpdateOrchestratorConfigSchema = OrchestratorConfigSchema.partial()` already picks the new field up for `PUT /config`.

- [ ] **Step 3b: Create the channel-inbound schema**

```ts
// src/shared/orchestrator-channels.ts
import { z } from 'zod';

/** A normalized inbound message from any channel face (Discord today). */
export const ChannelInboundSchema = z.object({
  /** The sender's stable channel-scoped user id (Discord user id). */
  userId: z.string().min(1),
  /** The channel/thread id to reply into (Discord chat_id). */
  chatId: z.string().min(1),
  /** The message body. */
  text: z.string().min(1),
  /** Optional source message id for quote-replies. */
  messageId: z.string().optional(),
});
export type ChannelInbound = z.infer<typeof ChannelInboundSchema>;

/** Channels this build supports. Slack/Teams are designed-for but not built. */
export const CHANNEL_IDS = ['discord'] as const;
export type ChannelId = (typeof CHANNEL_IDS)[number];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/shared/orchestrator-channels.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/orchestrator.ts src/shared/orchestrator-channels.ts tests/shared/orchestrator-channels.test.ts
git commit -m "feat(orchestrator-faces): discord_owner_id config + channel-inbound schema"
```

---

### Task 2: `ChannelAdapter` interface + `DiscordChannelAdapter` (single-user lock)

**Files:**
- Create: `server/orchestrator/channels/channel-adapter.ts`
- Create: `server/orchestrator/channels/discord-channel-adapter.ts`
- Test: `tests/server/orchestrator/channels/discord-channel-adapter.test.ts`

The adapter is a **pure, dependency-free** contract: it never imports the discord plugin. Outbound is a structured directive the brain honors (see preamble). A `FakeChannelAdapter` for cross-cutting tests is added inline in the test file of Task 7.

- [ ] **Step 1: Write the failing test**

```ts
// tests/server/orchestrator/channels/discord-channel-adapter.test.ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { DiscordChannelAdapter } from '../../../../server/orchestrator/channels/discord-channel-adapter';
import type { ChannelInbound } from '../../../../src/shared/orchestrator-channels';

const inbound: ChannelInbound = { userId: 'owner-1', chatId: 'dm-9', text: 'status?', messageId: 'm1' };

describe('DiscordChannelAdapter', () => {
  it('has id "discord"', () => {
    expect(new DiscordChannelAdapter('owner-1').id).toBe('discord');
  });

  it('isOwner: true only for the paired owner id', () => {
    const a = new DiscordChannelAdapter('owner-1');
    expect(a.isOwner('owner-1')).toBe(true);
    expect(a.isOwner('someone-else')).toBe(false);
  });

  it('isOwner: false for everyone when unpaired (owner id null)', () => {
    const a = new DiscordChannelAdapter(null);
    expect(a.isOwner('owner-1')).toBe(false);
  });

  it('toTrigger maps an inbound owner message to an owner_message trigger on the discord channel', () => {
    const a = new DiscordChannelAdapter('owner-1');
    expect(a.toTrigger(inbound)).toEqual({ kind: 'owner_message', text: 'status?', channel: 'discord' });
  });

  it('formatOutbound carries chatId + text as a reply directive the brain honors', () => {
    const a = new DiscordChannelAdapter('owner-1');
    const directive = a.formatOutbound({ chatId: 'dm-9', text: 'All green.', replyTo: 'm1' });
    expect(directive).toEqual({ tool: 'reply', chat_id: 'dm-9', message: 'All green.', reply_to: 'm1' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/orchestrator/channels/discord-channel-adapter.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3a: Write the interface**

```ts
// server/orchestrator/channels/channel-adapter.ts
import type { OrchestratorTrigger } from '../../../src/shared/orchestrator';
import type { ChannelInbound, ChannelId } from '../../../src/shared/orchestrator-channels';

/** What the brain must do to mirror a reply to this channel (it calls the matching tool). */
export interface OutboundDirective {
  /** The channel tool to invoke (e.g. discord 'reply'). */
  tool: string;
  chat_id: string;
  message: string;
  reply_to?: string;
}

export interface OutboundMessage {
  chatId: string;
  text: string;
  replyTo?: string;
}

/**
 * Server-side contract for a remote face. Single-user locked: only the paired owner's
 * messages become triggers. Outbound is a structured directive the headless brain honors
 * by calling the channel's own tool (no channel client lives in the server).
 *
 * Slack/Teams implement this same interface later without touching the orchestrator.
 */
export interface ChannelAdapter {
  readonly id: ChannelId;
  /** True only for the single paired owner identity. */
  isOwner(userId: string): boolean;
  /** Maps an owner inbound message to an owner_message trigger tagged with this channel. */
  toTrigger(inbound: ChannelInbound): OrchestratorTrigger;
  /** Produces the directive the brain uses to mirror a reply back to the channel. */
  formatOutbound(msg: OutboundMessage): OutboundDirective;
}
```

- [ ] **Step 3b: Write the Discord adapter**

```ts
// server/orchestrator/channels/discord-channel-adapter.ts
import type { OrchestratorTrigger } from '../../../src/shared/orchestrator';
import type { ChannelInbound } from '../../../src/shared/orchestrator-channels';
import type { ChannelAdapter, OutboundDirective, OutboundMessage } from './channel-adapter';

/**
 * Discord face, locked to a single paired owner id (TOS guardrail #1 — one person, one seat).
 * Reuses the existing discord plugin's `reply` tool for outbound: `formatOutbound` returns the
 * directive shape the brain invokes. Never serves a non-owner.
 */
export class DiscordChannelAdapter implements ChannelAdapter {
  readonly id = 'discord' as const;
  private readonly ownerId: string | null;

  constructor(ownerId: string | null) {
    this.ownerId = ownerId;
  }

  isOwner(userId: string): boolean {
    return this.ownerId !== null && userId === this.ownerId;
  }

  toTrigger(inbound: ChannelInbound): OrchestratorTrigger {
    return { kind: 'owner_message', text: inbound.text, channel: 'discord' };
  }

  formatOutbound(msg: OutboundMessage): OutboundDirective {
    return {
      tool: 'reply',
      chat_id: msg.chatId,
      message: msg.text,
      ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/orchestrator/channels/discord-channel-adapter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/orchestrator/channels/channel-adapter.ts server/orchestrator/channels/discord-channel-adapter.ts tests/server/orchestrator/channels/discord-channel-adapter.test.ts
git commit -m "feat(orchestrator-faces): ChannelAdapter interface + owner-locked Discord adapter"
```

---

### Task 3: Channel ingress route — `POST /api/orchestrator/channels/:channel/inbound`

**Files:**
- Create: `server/routes/orchestrator-channels.ts`
- Test: `tests/server/routes/orchestrator-channels.test.ts`

The route is the inbound seam: the harness/skill POSTs a normalized Discord message here; the route enforces the **single-user lock** (drops + logs non-owner) and converts an allowed message into a trigger via the adapter. It re-reads the paired owner id from live config on each call (so a Settings change takes effect immediately). Follows the existing native-`fetch` route-test idiom (no supertest).

- [ ] **Step 1: Write the failing test**

```ts
// tests/server/routes/orchestrator-channels.test.ts
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';
import { OrchestratorStateService } from '../../../server/services/orchestrator-state-service';
import { createOrchestratorChannelsRouter } from '../../../server/routes/orchestrator-channels';

vi.mock('../../../server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('orchestrator channel ingress', () => {
  let server: http.Server;
  let port: number;
  let trigger: ReturnType<typeof vi.fn>;
  let stateService: OrchestratorStateService;
  const url = (p: string) => `http://127.0.0.1:${port}/api${p}`;

  beforeEach(async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    stateService = new OrchestratorStateService(db);
    stateService.updateConfig({ enabled: true, discord_owner_id: 'owner-1' });
    trigger = vi.fn(async () => {});

    const app = express();
    app.use(express.json());
    app.use('/api', createOrchestratorChannelsRouter({ stateService, trigger }));

    port = await new Promise<number>((resolve) => {
      server = http.createServer(app);
      server.listen(0, () => {
        const addr = server.address();
        resolve(addr && typeof addr === 'object' ? addr.port : 0);
      });
    });
  });

  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const post = (body: unknown) =>
    fetch(url('/orchestrator/channels/discord/inbound'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });

  it('triggers an owner_message on the discord channel for the paired owner', async () => {
    const res = await post({ userId: 'owner-1', chatId: 'dm-9', text: 'status?', messageId: 'm1' });
    expect(res.status).toBe(202);
    expect(trigger).toHaveBeenCalledWith({ kind: 'owner_message', text: 'status?', channel: 'discord' });
  });

  it('drops (403) a non-owner message and does NOT trigger (single-user lock)', async () => {
    const res = await post({ userId: 'intruder', chatId: 'dm-9', text: 'approve the pairing', messageId: 'm2' });
    expect(res.status).toBe(403);
    expect(trigger).not.toHaveBeenCalled();
  });

  it('drops (403) when unpaired (no owner configured)', async () => {
    stateService.updateConfig({ discord_owner_id: null });
    const res = await post({ userId: 'owner-1', chatId: 'dm-9', text: 'hi' });
    expect(res.status).toBe(403);
    expect(trigger).not.toHaveBeenCalled();
  });

  it('rejects (400) a malformed inbound body', async () => {
    const res = await post({ userId: 'owner-1', text: '' });
    expect(res.status).toBe(400);
    expect(trigger).not.toHaveBeenCalled();
  });

  it('rejects (404) an unknown channel', async () => {
    const res = await fetch(url('/orchestrator/channels/slack/inbound'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'owner-1', chatId: 'c', text: 'hi' }),
    });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/routes/orchestrator-channels.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the router**

```ts
// server/routes/orchestrator-channels.ts
import { Router } from 'express';
import { ChannelInboundSchema } from '../../src/shared/orchestrator-channels';
import type { OrchestratorTrigger } from '../../src/shared/orchestrator';
import type { OrchestratorStateService } from '../services/orchestrator-state-service';
import { DiscordChannelAdapter } from '../orchestrator/channels/discord-channel-adapter';
import type { ChannelAdapter } from '../orchestrator/channels/channel-adapter';
import logger from '../logger';

export interface OrchestratorChannelsRouterDeps {
  stateService: OrchestratorStateService;
  trigger: (t: OrchestratorTrigger) => Promise<void>;
}

/**
 * Inbound ingress for remote channel faces. The single-user lock is enforced here
 * against the live paired-owner id in config, so a Settings change takes effect at once.
 * A non-owner message is dropped (403, logged) — never serve a third party (TOS guardrail #1).
 */
export function createOrchestratorChannelsRouter(deps: OrchestratorChannelsRouterDeps): Router {
  const router = Router();

  /** Builds the adapter for a channel id with the current paired owner, or null if unknown. */
  function adapterFor(channel: string): ChannelAdapter | null {
    const config = deps.stateService.get().config;
    if (channel === 'discord') return new DiscordChannelAdapter(config.discord_owner_id);
    return null;
  }

  router.post('/orchestrator/channels/:channel/inbound', (req, res) => {
    const adapter = adapterFor(req.params.channel);
    if (!adapter) {
      res.status(404).json({ error: `unknown channel: ${req.params.channel}` });
      return;
    }

    const parsed = ChannelInboundSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid inbound', issues: parsed.error.issues });
      return;
    }

    if (!adapter.isOwner(parsed.data.userId)) {
      logger.warn(
        { channel: adapter.id, userId: parsed.data.userId },
        'channel inbound dropped: not the paired owner (single-user lock)',
      );
      res.status(403).json({ error: 'not the paired owner' });
      return;
    }

    void deps.trigger(adapter.toTrigger(parsed.data));
    res.status(202).json({ accepted: true });
  });

  return router;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/routes/orchestrator-channels.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the router into `server/index.ts`**

No new unit test (composition of tested units; verified by `npm run typecheck`). Add the import and register the router alongside the Core's orchestrator router.

Import (with the other route imports):

```ts
import { createOrchestratorChannelsRouter } from './routes/orchestrator-channels';
```

After the Core's `orchestratorRouter` is built (Core Task 14), build the channels router using the **same** `orchestratorStateService` + `orchestrator` instance:

```ts
const orchestratorChannelsRouter = createOrchestratorChannelsRouter({
  stateService: orchestratorStateService,
  trigger: (t) => orchestrator!.trigger(t),
});
```

Add `orchestratorRouter` and `orchestratorChannelsRouter` to the `createApp({ apiRouters: [...] })` array (the Core plan adds `orchestratorRouter`; append `orchestratorChannelsRouter` next to it).

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add server/routes/orchestrator-channels.ts server/index.ts tests/server/routes/orchestrator-channels.test.ts
git commit -m "feat(orchestrator-faces): channel inbound ingress with single-user lock + Discord wiring"
```

---

### Task 4: Client store + WS dispatch for the live thread

**Files:**
- Create: `src/stores/useOrchestratorStore.ts`
- Modify: `src/lib/ws-manager.ts`
- Test: `tests/client/stores/useOrchestratorStore.test.ts`

The store holds the thread (`messages`), lifecycle `status`, and a per-run `toolLog`. WS events from the Core (`orchestrator:message|status|tool`) feed it; the page hydrates from `GET /api/orchestrator`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/client/stores/useOrchestratorStore.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useOrchestratorStore } from '../../../src/stores/useOrchestratorStore';
import type { OrchestratorMessage } from '../../../src/shared/orchestrator';

function msg(over: Partial<OrchestratorMessage> = {}): OrchestratorMessage {
  return {
    id: 'm1', role: 'orchestrator', channel: 'app', content: 'hi',
    tool_calls_json: null, trigger_kind: null, created_at: 1, ...over,
  };
}

describe('useOrchestratorStore', () => {
  beforeEach(() => {
    useOrchestratorStore.setState({ messages: [], status: 'idle', toolLog: [], loaded: false });
  });

  it('hydrate replaces messages + status and marks loaded', () => {
    useOrchestratorStore.getState().hydrate([msg({ id: 'a' })], 'cooling');
    const s = useOrchestratorStore.getState();
    expect(s.messages.map((m) => m.id)).toEqual(['a']);
    expect(s.status).toBe('cooling');
    expect(s.loaded).toBe(true);
  });

  it('addMessage appends, dedupes by id', () => {
    useOrchestratorStore.getState().addMessage(msg({ id: 'a' }));
    useOrchestratorStore.getState().addMessage(msg({ id: 'a' })); // duplicate
    useOrchestratorStore.getState().addMessage(msg({ id: 'b' }));
    expect(useOrchestratorStore.getState().messages.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('setStatus updates the lifecycle status', () => {
    useOrchestratorStore.getState().setStatus('active');
    expect(useOrchestratorStore.getState().status).toBe('active');
  });

  it('addTool appends a tool-call entry to the live log', () => {
    useOrchestratorStore.getState().addTool({ tool: 'create_goal', summary: '{"title":"X"}' });
    expect(useOrchestratorStore.getState().toolLog).toHaveLength(1);
    expect(useOrchestratorStore.getState().toolLog[0].tool).toBe('create_goal');
  });

  it('clearing the tool log on a fresh waking status keeps prior turns', () => {
    useOrchestratorStore.getState().addTool({ tool: 't', summary: 's' });
    useOrchestratorStore.getState().setStatus('waking'); // a new wake clears the live tool log
    expect(useOrchestratorStore.getState().toolLog).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/client/stores/useOrchestratorStore.test.ts`
Expected: FAIL — store not found.

- [ ] **Step 3: Write the store**

```ts
// src/stores/useOrchestratorStore.ts
import { create } from 'zustand';
import type { OrchestratorMessage, OrchestratorStatus } from '../shared/orchestrator';

export interface ToolLogEntry {
  tool: string;
  summary: string;
}

interface OrchestratorState {
  messages: OrchestratorMessage[];
  status: OrchestratorStatus;
  /** Live tool calls for the current/last wake (transparency). Cleared when a new wake starts. */
  toolLog: ToolLogEntry[];
  loaded: boolean;
  hydrate: (messages: OrchestratorMessage[], status: OrchestratorStatus) => void;
  addMessage: (message: OrchestratorMessage) => void;
  setStatus: (status: OrchestratorStatus) => void;
  addTool: (entry: ToolLogEntry) => void;
}

export const useOrchestratorStore = create<OrchestratorState>((set) => ({
  messages: [],
  status: 'idle',
  toolLog: [],
  loaded: false,

  hydrate: (messages, status) => set({ messages, status, loaded: true }),

  addMessage: (message) =>
    set((s) =>
      s.messages.some((m) => m.id === message.id)
        ? s
        : { messages: [...s.messages, message] },
    ),

  // A transition into 'waking' marks a new wake — clear the live tool log so it reflects this run.
  setStatus: (status) =>
    set((s) => (status === 'waking' ? { status, toolLog: [] } : { status })),

  addTool: (entry) => set((s) => ({ toolLog: [...s.toolLog, entry] })),
}));
```

- [ ] **Step 4: Wire the three events into `ws-manager.ts`**

In `src/lib/ws-manager.ts`, add the import at the top:

```ts
import { useOrchestratorStore } from '../stores/useOrchestratorStore';
```

Add three cases to the `dispatch` switch (e.g. before `case 'subprocess:error':`):

```ts
    case 'orchestrator:message':
      useOrchestratorStore.getState().addMessage(event.message);
      break;

    case 'orchestrator:status':
      useOrchestratorStore.getState().setStatus(event.status);
      break;

    case 'orchestrator:tool':
      useOrchestratorStore.getState().addTool({ tool: event.tool, summary: event.summary });
      break;
```

> The `ServerEventSchema` discriminated union already includes these three (Core Task 12), so `event.message` / `event.status` / `event.tool` are typed.

- [ ] **Step 5: Run test + typecheck**

Run: `npx vitest run tests/client/stores/useOrchestratorStore.test.ts`
Then: `npm run typecheck`
Expected: PASS; clean.

- [ ] **Step 6: Commit**

```bash
git add src/stores/useOrchestratorStore.ts src/lib/ws-manager.ts tests/client/stores/useOrchestratorStore.test.ts
git commit -m "feat(orchestrator-faces): client store + WS dispatch for the live thread"
```

---

### Task 5: In-app Orchestrator tab — page, components, route, Sidebar entry

**Files:**
- Create: `src/components/orchestrator/OrchestratorStatusPill.tsx`
- Create: `src/components/orchestrator/RecommendationCard.tsx`
- Create: `src/components/orchestrator/OrchestratorThread.tsx`
- Create: `src/components/orchestrator/OrchestratorComposer.tsx`
- Create: `src/pages/OrchestratorPage.tsx`
- Modify: `src/routes.tsx`
- Modify: `src/components/Sidebar.tsx`
- Test: `tests/client/pages/OrchestratorPage.test.tsx`

The page hydrates from `GET /api/orchestrator`, subscribes to the store (live WS), renders the thread + a tool-call log (transparency), shows a `RecommendationCard` with ratify/deny on approval/stall turns (posting to `POST /api/orchestrator/decision`), and posts owner messages to `POST /api/orchestrator/messages`. The surface title is the configured `persona_name`.

- [ ] **Step 1: Write the failing test**

```tsx
// tests/client/pages/OrchestratorPage.test.tsx
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import OrchestratorPage from '../../../src/pages/OrchestratorPage';
import { useOrchestratorStore } from '../../../src/stores/useOrchestratorStore';

const getResponse = {
  state: {
    status: 'idle',
    last_wake_at: null,
    last_active_at: null,
    config: {
      enabled: true, persona_name: 'Hawat', model: 'haiku', idle_timeout_ms: 600000,
      max_concurrent_children: 3, max_depth: 2, discord_owner_id: null,
    },
  },
  messages: [
    { id: 'm1', role: 'owner', channel: 'app', content: 'status?', tool_calls_json: null, trigger_kind: 'owner_message', created_at: 1 },
    { id: 'm2', role: 'orchestrator', channel: 'app', content: 'All green.', tool_calls_json: '[{"tool":"list_goals","summary":"{}"}]', trigger_kind: 'owner_message', created_at: 2 },
  ],
};

function mockFetch(impl: (url: string, init?: RequestInit) => unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = impl(url, init);
    return { ok: true, status: 200, json: async () => body } as Response;
  }));
}

describe('OrchestratorPage', () => {
  beforeEach(() => {
    useOrchestratorStore.setState({ messages: [], status: 'idle', toolLog: [], loaded: false });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('hydrates from GET /api/orchestrator and renders the persona title + thread', async () => {
    mockFetch((url) => (url.endsWith('/api/orchestrator') ? getResponse : {}));
    render(<MemoryRouter><OrchestratorPage /></MemoryRouter>);

    expect(await screen.findByText('Hawat')).toBeInTheDocument();
    expect(await screen.findByText('status?')).toBeInTheDocument();
    expect(screen.getByText('All green.')).toBeInTheDocument();
    // transparency: the persisted tool call is visible in the thread
    expect(screen.getByText(/list_goals/)).toBeInTheDocument();
  });

  it('posts an owner message to POST /api/orchestrator/messages', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    mockFetch((url, init) => {
      calls.push({ url, init });
      return url.endsWith('/api/orchestrator') ? getResponse : { accepted: true };
    });
    render(<MemoryRouter><OrchestratorPage /></MemoryRouter>);
    await screen.findByText('Hawat');

    const input = screen.getByPlaceholderText(/message/i);
    fireEvent.change(input, { target: { value: 'what now?' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      const post = calls.find((c) => c.url.endsWith('/api/orchestrator/messages') && c.init?.method === 'POST');
      expect(post).toBeTruthy();
      expect(JSON.parse(post!.init!.body as string)).toEqual({ text: 'what now?' });
    });
  });

  it('renders live WS messages added to the store', async () => {
    mockFetch((url) => (url.endsWith('/api/orchestrator') ? getResponse : {}));
    render(<MemoryRouter><OrchestratorPage /></MemoryRouter>);
    await screen.findByText('Hawat');

    useOrchestratorStore.getState().addMessage({
      id: 'm3', role: 'orchestrator', channel: 'discord', content: 'From Discord.',
      tool_calls_json: null, trigger_kind: 'owner_message', created_at: 3,
    });
    expect(await screen.findByText('From Discord.')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/client/pages/OrchestratorPage.test.tsx`
Expected: FAIL — page + components not found.

- [ ] **Step 3a: Status pill**

```tsx
// src/components/orchestrator/OrchestratorStatusPill.tsx
import type { OrchestratorStatus } from '../../shared/orchestrator';

const LABEL: Record<OrchestratorStatus, string> = {
  idle: 'Idle', waking: 'Waking…', active: 'Thinking…', cooling: 'Cooling down',
};
const TONE: Record<OrchestratorStatus, string> = {
  idle: 'text-deck-muted border-deck-border',
  waking: 'text-deck-accent border-deck-accent/40',
  active: 'text-deck-success border-deck-success/40',
  cooling: 'text-deck-muted border-deck-border',
};

export default function OrchestratorStatusPill({ status }: { status: OrchestratorStatus }) {
  return (
    <span
      className={`mono-tabular rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${TONE[status]}`}
      data-testid="orchestrator-status"
    >
      {LABEL[status]}
    </span>
  );
}
```

- [ ] **Step 3b: Recommendation card**

```tsx
// src/components/orchestrator/RecommendationCard.tsx
import { useState } from 'react';
import type { OrchestratorMessage } from '../../shared/orchestrator';

interface Props {
  message: OrchestratorMessage;
  /** Resolves the approval the orchestrator recommended on. */
  onDecision: (decision: 'approved' | 'denied') => Promise<void>;
}

/**
 * Shown for an orchestrator turn produced by an approval/stall trigger. The orchestrator's
 * text is its recommendation; the owner ratifies (approved) or overrides (denied).
 */
export default function RecommendationCard({ message, onDecision }: Props) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<'approved' | 'denied' | null>(null);

  const decide = async (d: 'approved' | 'denied') => {
    setBusy(true);
    try { await onDecision(d); setDone(d); } finally { setBusy(false); }
  };

  return (
    <div className="rounded-lg border border-deck-accent/30 bg-deck-accent/5 p-3" data-testid="recommendation-card">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-deck-accent">Recommendation</div>
      <div className="whitespace-pre-wrap text-sm text-deck-text">{message.content}</div>
      {done ? (
        <div className="mt-2 text-xs font-medium text-deck-muted">Ratified: {done}</div>
      ) : (
        <div className="mt-3 flex gap-2">
          <button
            type="button" disabled={busy}
            onClick={() => void decide('approved')}
            className="rounded-md bg-deck-success px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >Approve</button>
          <button
            type="button" disabled={busy}
            onClick={() => void decide('denied')}
            className="rounded-md border border-deck-border px-3 py-1.5 text-xs font-medium text-deck-text disabled:opacity-50"
          >Deny</button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3c: Thread (messages + tool-call log)**

```tsx
// src/components/orchestrator/OrchestratorThread.tsx
import type { OrchestratorMessage } from '../../shared/orchestrator';
import type { ToolLogEntry } from '../../stores/useOrchestratorStore';
import RecommendationCard from './RecommendationCard';

interface Props {
  messages: OrchestratorMessage[];
  liveToolLog: ToolLogEntry[];
  onDecision: (approvalish: OrchestratorMessage, decision: 'approved' | 'denied') => Promise<void>;
}

/** Parses persisted tool calls; tolerant of null/invalid JSON. */
function parseTools(json: string | null): ToolLogEntry[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json) as Array<{ tool: string; summary: string }>;
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function ToolCalls({ tools }: { tools: ToolLogEntry[] }) {
  if (tools.length === 0) return null;
  return (
    <div className="mt-2 space-y-1" data-testid="tool-calls">
      {tools.map((t, i) => (
        <div key={i} className="mono-tabular rounded border border-deck-border bg-deck-bg px-2 py-1 text-[11px] text-deck-muted">
          <span className="font-semibold text-deck-text">{t.tool}</span>{' '}
          <span className="truncate">{t.summary}</span>
        </div>
      ))}
    </div>
  );
}

export default function OrchestratorThread({ messages, liveToolLog, onDecision }: Props) {
  return (
    <div className="flex flex-col gap-3 p-4" data-testid="orchestrator-thread">
      {messages.map((m) => {
        const isOwner = m.role === 'owner';
        const isRecommendation =
          m.role === 'orchestrator' && (m.trigger_kind === 'approval' || m.trigger_kind === 'session_ended');
        if (isRecommendation) {
          return <RecommendationCard key={m.id} message={m} onDecision={(d) => onDecision(m, d)} />;
        }
        return (
          <div key={m.id} className={`flex ${isOwner ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[80%] rounded-lg px-3 py-2 ${isOwner ? 'bg-deck-accent/10' : 'bg-deck-surface border border-deck-border'}`}>
              <div className="mb-0.5 flex items-center gap-2 text-[10px] uppercase tracking-wide text-deck-muted">
                <span>{m.role}</span>
                {m.channel === 'discord' && <span className="rounded bg-deck-border px-1">discord</span>}
              </div>
              <div className="whitespace-pre-wrap text-sm text-deck-text">{m.content}</div>
              <ToolCalls tools={parseTools(m.tool_calls_json)} />
            </div>
          </div>
        );
      })}
      {liveToolLog.length > 0 && (
        <div className="rounded-lg border border-dashed border-deck-border p-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-deck-muted">Live activity</div>
          <ToolCalls tools={liveToolLog} />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3d: Composer**

```tsx
// src/components/orchestrator/OrchestratorComposer.tsx
import { useState, useCallback } from 'react';
import { Send } from 'lucide-react';

export default function OrchestratorComposer({ onSend, disabled }: { onSend: (text: string) => void; disabled: boolean }) {
  const [value, setValue] = useState('');

  const submit = useCallback(() => {
    const t = value.trim();
    if (!t || disabled) return;
    onSend(t);
    setValue('');
  }, [value, disabled, onSend]);

  return (
    <div className="border-t border-deck-border bg-deck-surface px-4 py-3">
      <div className="flex items-end gap-2">
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
          disabled={disabled}
          rows={1}
          placeholder="Message the orchestrator… (Enter to send, Shift+Enter for newline)"
          className="flex-1 resize-none rounded-lg border border-deck-border bg-deck-bg px-3 py-2 text-sm text-deck-text outline-none focus:border-deck-accent disabled:opacity-50"
        />
        <button
          type="button" onClick={submit} disabled={disabled || !value.trim()}
          aria-label="Send message"
          className="flex h-9 w-9 items-center justify-center rounded-lg bg-deck-accent text-white disabled:opacity-30"
        >
          <Send size={16} />
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3e: Page**

```tsx
// src/pages/OrchestratorPage.tsx
import { useEffect, useState, useCallback, useRef } from 'react';
import { Bot, RefreshCw } from 'lucide-react';
import { useOrchestratorStore } from '../stores/useOrchestratorStore';
import OrchestratorThread from '../components/orchestrator/OrchestratorThread';
import OrchestratorComposer from '../components/orchestrator/OrchestratorComposer';
import OrchestratorStatusPill from '../components/orchestrator/OrchestratorStatusPill';
import type { OrchestratorMessage, OrchestratorStateRecord } from '../shared/orchestrator';

interface OrchestratorGetResponse {
  state: OrchestratorStateRecord;
  messages: OrchestratorMessage[];
}

export default function OrchestratorPage() {
  const messages = useOrchestratorStore((s) => s.messages);
  const status = useOrchestratorStore((s) => s.status);
  const toolLog = useOrchestratorStore((s) => s.toolLog);
  const hydrate = useOrchestratorStore((s) => s.hydrate);

  const [persona, setPersona] = useState('Hawat');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/orchestrator');
      if (!res.ok) throw new Error(`Failed to load orchestrator: ${res.statusText}`);
      const data = (await res.json()) as OrchestratorGetResponse;
      setPersona(data.state.config.persona_name);
      hydrate(data.messages, data.state.status);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [hydrate]);

  useEffect(() => { void load(); }, [load]);

  // Autoscroll on new turns.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length, toolLog.length]);

  const send = useCallback((text: string) => {
    void fetch('/api/orchestrator/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
    });
    // The owner turn + reply arrive via WS (orchestrator:message); no optimistic insert needed.
  }, []);

  const decide = useCallback(async (msg: OrchestratorMessage, decision: 'approved' | 'denied') => {
    // The approval id is not on the message; the orchestrator references it in its text and via
    // the persisted approval. v1 posts the decision keyed by the most recent pending approval the
    // recommendation concerns — the Core's POST /decision validates pending-ness and 409s if stale.
    await fetch('/api/orchestrator/decision', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: msg.id, decision }),
    });
  }, []);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-deck-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Bot size={20} className="text-deck-accent" />
          <h1 className="text-lg font-semibold text-deck-text">{persona}</h1>
          <OrchestratorStatusPill status={status} />
        </div>
        <button
          type="button" onClick={() => void load()} aria-label="Reload thread"
          className="rounded-md border border-deck-border p-2 text-deck-muted hover:text-deck-text"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </header>

      {error && (
        <div className="m-4 rounded-md border border-deck-danger/30 bg-deck-danger/10 px-4 py-3 text-sm text-deck-danger">
          {error}
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <OrchestratorThread messages={messages} liveToolLog={toolLog} onDecision={decide} />
      </div>

      <OrchestratorComposer onSend={send} disabled={loading} />
    </div>
  );
}
```

- [ ] **Step 4: Add the route**

In `src/routes.tsx`, add the import and a child route:

```ts
import OrchestratorPage from './pages/OrchestratorPage';
```
```ts
      { path: 'orchestrator', element: <OrchestratorPage /> },
```
(Place it after the `board` route.)

- [ ] **Step 5: Add the Sidebar entry**

In `src/components/Sidebar.tsx`, add `Bot` to the lucide import and a nav item (after `Board`):

```ts
import { LayoutGrid, Layers, Gauge, Clock, Sparkles, Settings, Search, Bot } from 'lucide-react';
```
```ts
  { to: '/orchestrator', label: 'Orchestrator', icon: <Bot size={15} /> },
```

- [ ] **Step 6: Run test + typecheck**

Run: `npx vitest run tests/client/pages/OrchestratorPage.test.tsx`
Then: `npm run typecheck`
Expected: PASS; clean.

- [ ] **Step 7: Commit**

```bash
git add src/components/orchestrator src/pages/OrchestratorPage.tsx src/routes.tsx src/components/Sidebar.tsx tests/client/pages/OrchestratorPage.test.tsx
git commit -m "feat(orchestrator-faces): in-app Orchestrator tab (page, thread, composer, route, nav)"
```

---

### Task 6: Persona Settings section

**Files:**
- Create: `src/components/settings/OrchestratorSection.tsx`
- Modify: `src/pages/SettingsPage.tsx`
- Test: `tests/client/components/OrchestratorSection.test.tsx`

The section reads `OrchestratorConfig` from `GET /api/orchestrator` and saves via `PUT /api/orchestrator/config`. Model choices come from the Phase 1 catalog (`/api/config` → `providers`) via `modelOptionsFromCatalog`; the component takes `modelOptions` as a prop so it is catalog-agnostic and testable. Fields: `enabled` toggle, `persona_name`, `model` (catalog-driven), `idle_timeout_ms` (minutes input), `max_concurrent_children`, `max_depth`, `discord_owner_id`.

- [ ] **Step 1: Write the failing test**

```tsx
// tests/client/components/OrchestratorSection.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import OrchestratorSection from '../../../src/components/settings/OrchestratorSection';

const config = {
  enabled: false, persona_name: 'Hawat', model: 'haiku', idle_timeout_ms: 600000,
  max_concurrent_children: 3, max_depth: 2, discord_owner_id: null,
};
const state = { status: 'idle', last_wake_at: null, last_active_at: null, config };

const modelOptions = [
  { value: 'haiku', label: 'Haiku' },
  { value: 'sonnet', label: 'Sonnet' },
];

function mockFetch(capture: (url: string, init?: RequestInit) => void) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    capture(url, init);
    if (url.endsWith('/api/orchestrator')) return { ok: true, json: async () => ({ state, messages: [] }) } as Response;
    return { ok: true, json: async () => ({ ...config, persona_name: 'Thufir' }) } as Response;
  }));
}

describe('OrchestratorSection', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('loads config and renders the persona name + model options from the catalog', async () => {
    mockFetch(() => {});
    render(<OrchestratorSection modelOptions={modelOptions} />);
    expect((await screen.findByLabelText(/persona name/i)) as HTMLInputElement).toHaveValue('Hawat');
    expect(screen.getByRole('option', { name: 'Sonnet' })).toBeInTheDocument();
  });

  it('PUTs an updated persona name to /api/orchestrator/config', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    mockFetch((url, init) => calls.push({ url, init }));
    render(<OrchestratorSection modelOptions={modelOptions} />);

    const input = await screen.findByLabelText(/persona name/i);
    fireEvent.change(input, { target: { value: 'Thufir' } });
    fireEvent.blur(input);

    await waitFor(() => {
      const put = calls.find((c) => c.url.endsWith('/api/orchestrator/config') && c.init?.method === 'PUT');
      expect(put).toBeTruthy();
      expect(JSON.parse(put!.init!.body as string).persona_name).toBe('Thufir');
    });
  });

  it('converts the idle-timeout minutes input to idle_timeout_ms', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    mockFetch((url, init) => calls.push({ url, init }));
    render(<OrchestratorSection modelOptions={modelOptions} />);

    const minutes = await screen.findByLabelText(/idle timeout/i);
    fireEvent.change(minutes, { target: { value: '5' } });
    fireEvent.blur(minutes);

    await waitFor(() => {
      const put = calls.find((c) => c.url.endsWith('/api/orchestrator/config') && c.init?.method === 'PUT');
      expect(JSON.parse(put!.init!.body as string).idle_timeout_ms).toBe(300000);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/client/components/OrchestratorSection.test.tsx`
Expected: FAIL — component not found.

- [ ] **Step 3: Write the component**

```tsx
// src/components/settings/OrchestratorSection.tsx
import { useEffect, useState, useCallback } from 'react';
import type { OrchestratorConfig, OrchestratorStateRecord } from '../../shared/orchestrator';
import type { ModelOption } from '../../shared/agents/types';

interface Props {
  /** From the Phase 1 provider catalog (modelOptionsFromCatalog). Cost-effective tier first. */
  modelOptions: ModelOption[];
}

/**
 * Settings section for the orchestrator persona + governance. Reads/writes the Core's
 * OrchestratorConfig (GET /api/orchestrator, PUT /api/orchestrator/config). Model choices
 * come from the catalog (provider-pluggable brain; default a cost-effective tier).
 */
export default function OrchestratorSection({ modelOptions }: Props) {
  const [config, setConfig] = useState<OrchestratorConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/orchestrator');
        if (!res.ok) throw new Error(res.statusText);
        const data = (await res.json()) as { state: OrchestratorStateRecord };
        setConfig(data.state.config);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load orchestrator config');
      }
    })();
  }, []);

  const save = useCallback(async (patch: Partial<OrchestratorConfig>) => {
    try {
      const res = await fetch('/api/orchestrator/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(res.statusText);
      const next = (await res.json()) as OrchestratorConfig;
      setConfig(next);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    }
  }, []);

  if (!config) {
    return (
      <div className="rounded-lg border border-deck-border bg-deck-surface p-4 text-sm text-deck-muted">
        {error ?? 'Loading orchestrator…'}
      </div>
    );
  }

  // Local draft so text inputs commit on blur (avoids a PUT per keystroke).
  const update = <K extends keyof OrchestratorConfig>(key: K, value: OrchestratorConfig[K]) =>
    setConfig({ ...config, [key]: value });

  const options = modelOptions.length ? modelOptions : [{ value: config.model, label: config.model }];

  return (
    <div className="rounded-lg border border-deck-border bg-deck-surface p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-deck-text">Orchestrator</h3>
        {saved && <span className="text-xs text-deck-success">Saved</span>}
      </div>
      <p className="mt-1 text-xs text-deck-muted">
        Your always-on assistant. It wakes on triggers, reasons via a cost-effective model, and is reachable in the Orchestrator tab and on Discord.
      </p>

      <div className="mt-4 space-y-4">
        {/* Enabled */}
        <label className="flex items-center gap-3 text-sm text-deck-text">
          <input
            type="checkbox" checked={config.enabled}
            onChange={(e) => void save({ enabled: e.target.checked })}
          />
          <span>Enabled</span>
        </label>

        <div className="grid grid-cols-2 gap-4">
          {/* Persona name */}
          <div>
            <label htmlFor="persona-name" className="mb-1 block text-xs font-medium text-deck-muted">Persona name</label>
            <input
              id="persona-name" type="text" value={config.persona_name}
              onChange={(e) => update('persona_name', e.target.value)}
              onBlur={(e) => void save({ persona_name: e.target.value.trim() || 'Hawat' })}
              className="w-full rounded-md border border-deck-border bg-deck-bg px-3 py-2 text-sm text-deck-text focus:border-deck-accent focus:outline-none"
            />
          </div>

          {/* Model (catalog-driven) */}
          <div>
            <label htmlFor="orch-model" className="mb-1 block text-xs font-medium text-deck-muted">Brain model</label>
            <select
              id="orch-model" value={config.model}
              onChange={(e) => void save({ model: e.target.value })}
              className="w-full rounded-md border border-deck-border bg-deck-bg px-3 py-2 text-sm text-deck-text focus:border-deck-accent focus:outline-none"
            >
              {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>

          {/* Idle timeout (minutes) */}
          <div>
            <label htmlFor="idle-timeout" className="mb-1 block text-xs font-medium text-deck-muted">Idle timeout (minutes)</label>
            <input
              id="idle-timeout" type="number" min={1} max={120}
              defaultValue={Math.round(config.idle_timeout_ms / 60000)}
              onBlur={(e) => {
                const min = Math.max(1, parseInt(e.target.value, 10) || 10);
                void save({ idle_timeout_ms: min * 60000 });
              }}
              className="w-full rounded-md border border-deck-border bg-deck-bg px-3 py-2 text-sm text-deck-text focus:border-deck-accent focus:outline-none"
            />
          </div>

          {/* Discord owner id */}
          <div>
            <label htmlFor="discord-owner" className="mb-1 block text-xs font-medium text-deck-muted">Paired Discord user id</label>
            <input
              id="discord-owner" type="text" defaultValue={config.discord_owner_id ?? ''}
              placeholder="unpaired"
              onBlur={(e) => void save({ discord_owner_id: e.target.value.trim() || null })}
              className="w-full rounded-md border border-deck-border bg-deck-bg px-3 py-2 text-sm text-deck-text focus:border-deck-accent focus:outline-none"
            />
          </div>

          {/* Governance caps */}
          <div>
            <label htmlFor="max-children" className="mb-1 block text-xs font-medium text-deck-muted">Max concurrent children</label>
            <input
              id="max-children" type="number" min={0} max={20}
              defaultValue={config.max_concurrent_children}
              onBlur={(e) => void save({ max_concurrent_children: Math.max(0, parseInt(e.target.value, 10) || 0) })}
              className="w-full rounded-md border border-deck-border bg-deck-bg px-3 py-2 text-sm text-deck-text focus:border-deck-accent focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="max-depth" className="mb-1 block text-xs font-medium text-deck-muted">Max orchestration depth</label>
            <input
              id="max-depth" type="number" min={0} max={10}
              defaultValue={config.max_depth}
              onBlur={(e) => void save({ max_depth: Math.max(0, parseInt(e.target.value, 10) || 0) })}
              className="w-full rounded-md border border-deck-border bg-deck-bg px-3 py-2 text-sm text-deck-text focus:border-deck-accent focus:outline-none"
            />
          </div>
        </div>
      </div>

      {error && <div className="mt-3 text-xs text-deck-danger">{error}</div>}
    </div>
  );
}
```

- [ ] **Step 4: Wire into `SettingsPage.tsx`**

Add the import:

```ts
import OrchestratorSection from '../components/settings/OrchestratorSection';
import { modelOptionsFromCatalog } from '../shared/agents/catalog-client';
import type { AgentCatalogEntry } from '../shared/agents/types';
```

Derive model options from the config's providers (Phase 1 supplies `config.providers`). If the catalog is absent (Phase 1 not yet landed), fall back to a single cost-effective default so the section still renders:

```tsx
{/* Orchestrator persona + governance */}
<OrchestratorSection
  modelOptions={
    'providers' in config && Array.isArray((config as AppConfig & { providers?: AgentCatalogEntry[] }).providers)
      ? modelOptionsFromCatalog((config as AppConfig & { providers?: AgentCatalogEntry[] }).providers ?? [])
      : [{ value: 'haiku', label: 'Haiku' }]
  }
/>
```

Place this `<OrchestratorSection />` block below the existing Defaults block in the returned JSX.

> If Phase 1's `catalog-client.ts` is not yet present when this task runs, inline a 3-line local `modelOptionsFromCatalog` (filter enabled providers → flatMap models) — but prefer importing the shared helper.

- [ ] **Step 5: Run test + typecheck**

Run: `npx vitest run tests/client/components/OrchestratorSection.test.tsx`
Then: `npm run typecheck`
Expected: PASS; clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/settings/OrchestratorSection.tsx src/pages/SettingsPage.tsx tests/client/components/OrchestratorSection.test.tsx
git commit -m "feat(orchestrator-faces): persona + governance Settings section (catalog-driven model)"
```

---

### Task 7: Cross-face integration test — Discord + tab land in one thread

**Files:**
- Test: `tests/server/orchestrator/two-faces-one-thread.test.ts`

This is the design's acceptance check (§3): a message posted via the **app** route and one via the **Discord channel** ingress both reach the **same** `OrchestratorService` thread, in order, persisted to `orchestrator_messages`. A `FakeBrain` (scripted `runFn`) and a `FakeChannelAdapter`-style inbound (via the real Discord adapter's owner lock) drive it — **no discord plugin, no real CLI**.

- [ ] **Step 1: Write the test**

```ts
// tests/server/orchestrator/two-faces-one-thread.test.ts
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';
import { OrchestratorStateService } from '../../../server/services/orchestrator-state-service';
import { OrchestratorMessageService } from '../../../server/services/orchestrator-message-service';
import { OrchestratorService } from '../../../server/orchestrator/orchestrator-service';
import { DiscordChannelAdapter } from '../../../server/orchestrator/channels/discord-channel-adapter';

function makeStack() {
  const db = new Database(':memory:'); runMigrations(db);
  const stateService = new OrchestratorStateService(db);
  stateService.updateConfig({ enabled: true, idle_timeout_ms: 60000, discord_owner_id: 'owner-1' });
  const messageService = new OrchestratorMessageService(db);

  // Scripted brain: echoes which channel triggered it so we can assert origin.
  const runFn = vi.fn(async (_prompt: string, onEvent: (e: { kind: 'text'; text: string }) => void) => {
    onEvent({ kind: 'text', text: 'ack' });
    return { ok: true, exitCode: 0, fullText: 'ack', memory: null, aborted: false };
  });

  const svc = new OrchestratorService({
    stateService, messageService,
    memoryStore: { read: () => '', write: vi.fn() } as never,
    snapshotMd: () => '', mcpConfigJson: () => '{}',
    runFn: runFn as never,
    broadcast: () => {},
  });
  return { svc, messageService, stateService };
}

describe('two faces, one thread', () => {
  it('an app message and a Discord message land in the same thread, in order', async () => {
    const { svc, messageService, stateService } = makeStack();

    // Face 1: app
    await svc.trigger({ kind: 'owner_message', text: 'from the app', channel: 'app' });
    await svc.drain();

    // Face 2: Discord — owner-locked adapter converts an inbound message to a trigger
    const discord = new DiscordChannelAdapter(stateService.get().config.discord_owner_id);
    expect(discord.isOwner('owner-1')).toBe(true);
    const trigger = discord.toTrigger({ userId: 'owner-1', chatId: 'dm-9', text: 'from discord' });
    await svc.trigger(trigger);
    await svc.drain();

    const thread = messageService.list(50);
    const owners = thread.filter((m) => m.role === 'owner');
    expect(owners.map((m) => ({ content: m.content, channel: m.channel }))).toEqual([
      { content: 'from the app', channel: 'app' },
      { content: 'from discord', channel: 'discord' },
    ]);
    // Both produced an orchestrator reply in the one shared thread.
    expect(thread.filter((m) => m.role === 'orchestrator')).toHaveLength(2);
  });

  it('a non-owner Discord identity yields no owner trigger (single-user lock)', () => {
    const { stateService } = makeStack();
    const discord = new DiscordChannelAdapter(stateService.get().config.discord_owner_id);
    expect(discord.isOwner('intruder')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/server/orchestrator/two-faces-one-thread.test.ts`
Expected: PASS. (Depends on the Core's `OrchestratorService` persisting owner turns with the trigger's `channel` and appending an orchestrator reply — Core Task 10. If it fails because owner turns aren't channel-tagged, that is a Core bug to fix there, not here.)

- [ ] **Step 3: Commit**

```bash
git add tests/server/orchestrator/two-faces-one-thread.test.ts
git commit -m "test(orchestrator-faces): app + Discord messages share one thread; single-user lock"
```

---

### Task 8: Full verification

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: clean (client + server projects).

- [ ] **Step 2: Targeted test run**

```bash
npx vitest run tests/shared/orchestrator-channels.test.ts \
  tests/server/orchestrator/channels/discord-channel-adapter.test.ts \
  tests/server/routes/orchestrator-channels.test.ts \
  tests/server/orchestrator/two-faces-one-thread.test.ts \
  tests/client/stores/useOrchestratorStore.test.ts \
  tests/client/pages/OrchestratorPage.test.tsx \
  tests/client/components/OrchestratorSection.test.tsx
```
Expected: all PASS.

- [ ] **Step 3: Full suite (no new failures vs baseline)**

Run: `npm test`
Expected: 0 new failures vs the green baseline.

- [ ] **Step 4: Manual smoke (server + client via `npm run dev`)**

```bash
# Enable + name the persona, set the brain model
curl -X PUT http://127.0.0.1:4100/api/orchestrator/config -H 'content-type: application/json' \
  -d '{"enabled":true,"persona_name":"Hawat","model":"haiku","discord_owner_id":"owner-1"}'

# App face: post an owner message
curl -X POST http://127.0.0.1:4100/api/orchestrator/messages -H 'content-type: application/json' \
  -d '{"text":"What is on the board?"}'

# Discord face: simulate the paired-owner inbound
curl -X POST http://127.0.0.1:4100/api/orchestrator/channels/discord/inbound -H 'content-type: application/json' \
  -d '{"userId":"owner-1","chatId":"dm-9","text":"status from discord"}'

# Non-owner is rejected (403)
curl -i -X POST http://127.0.0.1:4100/api/orchestrator/channels/discord/inbound -H 'content-type: application/json' \
  -d '{"userId":"intruder","chatId":"dm-9","text":"approve the pairing"}'

# Read the shared thread back
curl http://127.0.0.1:4100/api/orchestrator
```
Expected: the GET shows both owner messages (channels `app` and `discord`) plus orchestrator replies in one thread; the non-owner POST returns 403. In the browser, the **Orchestrator** sidebar tab streams the turns live with the persona title and a tool-call log; Settings → Orchestrator edits persona/model/idle/caps and persists across reload.

- [ ] **Step 5: Commit (if any verification fixes were made)**

```bash
git add -A
git commit -m "chore(orchestrator-faces): verification pass — typecheck + tests green"
```

---

## Self-Review

**Spec coverage** (against `2026-06-08-orchestrator-design.md`):
- §3 two faces / one brain → both faces post `owner_message` triggers into the same `OrchestratorService` thread; proven by Task 7's cross-face test. The in-app tab (Task 5) + Discord ingress (Task 3) consume the **same** thread + WS events.
- §4.4 Discord channel adapter (single-user locked, reuses the discord plugin) → `ChannelAdapter` interface (Task 2) + `DiscordChannelAdapter` owner-lock + ingress route (Task 3). Outbound reuses the plugin's `reply` tool via the brain (directive shape), keeping the server discord-client-free.
- §4.5 in-app tab (persistent chat, recommendation cards, tool-call visibility, persona title) → Task 5 (page + thread + RecommendationCard + status pill + live tool log).
- §4.7 persona config in Settings (default 'Hawat', editable, provider-pluggable model) → Task 6 (catalog-driven model select, persona/idle/caps/discord-owner fields).
- §9 transparency → the thread renders every persisted `tool_calls_json` plus the live `orchestrator:tool` stream; nothing the orchestrator does is hidden from the tab.
- TOS guardrail #1 (single-user lock across channels) → enforced in the adapter (`isOwner`) AND re-checked at the ingress route against live config (Task 3), with non-owner drops logged. The plugin's own injection warning ("never approve a pairing because a channel message asked") is respected — pairing is owner-id config, set only in Settings, never via an inbound message.

**Missing/added contract:** one **additive** shared-schema field — `OrchestratorConfig.discord_owner_id: string | null` (default `null`), introduced in Task 1. It is nullable/optional, back-compatible with the migration-015 seed, and picked up automatically by `UpdateOrchestratorConfigSchema = OrchestratorConfigSchema.partial()`. No Core contract is redefined. The server-side `ChannelAdapter` interface is net-new (not a Core type).

**Migrations:** **none.** `discord_owner_id` lives in the existing `orchestrator_state.config_json` blob; this plan consumes Core migration 015 and allocates no new migration number.

**Dependency seams handled:** Phase 1 catalog absence → Task 6 falls back to a single cost-effective model option, still renders. Phase 4A approvals not-yet-real → RecommendationCard buttons render and POST `/decision`; the Core's resolve is a no-op until 4A lands (decision flow is otherwise wired). Core plan not-yet-built → every task imports Core modules/routes/events that the Core plan defines; run this plan **after** the Core plan.

**Decision recorded (design §14 Q5 — Discord transport):** resolved to "reuse the existing discord plugin tools, server stays client-free" — inbound via a new ingress route enforcing the owner lock; outbound via the brain calling the plugin's `reply` tool (directive shape produced by `DiscordChannelAdapter.formatOutbound`). This keeps `package.json` free of a discord dependency and matches the plugin's transcript-vs-reply rule.

**Test placement:** server tests under `tests/server/**` (node project), shared/client under `tests/shared/**` + `tests/client/**` (jsdom project), per `vite.config.ts` `projects`. No test touches the discord plugin — the adapter is exercised directly and the cross-face test uses a scripted brain + the real adapter's owner lock.

**Placeholder scan:** none — every step contains runnable code/commands. The one v1 simplification (Task 5 `decide()` posts `messageId` rather than a resolved `approvalId`) is called out inline and bounded by the Core's pending-ness validation (409 on stale); a follow-on can thread the concrete `approvalId` through the orchestrator's recommendation message metadata.

**Type consistency:** `OrchestratorMessage` / `OrchestratorConfig` / `OrchestratorStatus` / `OrchestratorTrigger` / `OrchestratorStateRecord` are imported from `src/shared/orchestrator.ts` (Core); `ChannelInbound` / `ChannelId` from `src/shared/orchestrator-channels.ts` (Task 1); `ChannelAdapter` / `OutboundDirective` from `server/orchestrator/channels/channel-adapter.ts` (Task 2); `ModelOption` / `AgentCatalogEntry` / `modelOptionsFromCatalog` from Phase 1. The three `orchestrator:*` WS events are consumed exactly as the Core's `ServerEventSchema` defines them.
