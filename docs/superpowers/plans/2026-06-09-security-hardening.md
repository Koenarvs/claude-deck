# Phase 0B — Security Hardening (localhost bind + shared-secret auth + cwd/path/model containment)

> **Status:** Implementation plan (bite-sized TDD). **Gate:** HARD — must land before the orchestrator (Phase 6) and any git-write feature (Phase 5B). Closes the unauthenticated-LAN-RCE holes found in the 2026-06-09 review.
>
> **Roadmap ref:** `docs/superpowers/plans/2026-06-09-master-roadmap.md` — "Phase 0 → 0B" + §2 decision 6.
>
> **Locked contract consumed:** Phase 0A provides `src/shared/agents/model-registry.ts` → `resolveModel(raw: string | null): ModelEntry | null`. Task 7 imports it. If 0A has not landed when 0B executes, see the **Missing-contract fallback** note in Task 7.
>
> **Migrations:** none. All new config is environment-driven (no DB schema change).

---

## Why this exists (the holes)

The review found four unauthenticated-LAN-RCE-class issues. Each line below is a real seam verified in the current tree:

1. **`server/index.ts:308`** — `server.listen(env.port, () => {...})` has **no host arg**, so Node binds `0.0.0.0` (all interfaces). On a LAN/Docker host the dashboard is reachable by any peer.
2. **No auth anywhere.** `POST /api/goals` with `permission_mode: 'autonomous'` spawns `claude --permission-mode bypassPermissions` in an attacker-chosen `cwd` (`server/pty-manager.ts:86-88`). `server/ws.ts` has no `verifyClient`/origin/token check and `terminal:input` writes straight to PTY stdin (`server/ws.ts:69-71`, `server/index.ts:210-214`).
3. **`server/routes/system.ts:64-95`** — `GET /api/skill-content?path=` rejects a literal `'..'` and requires `.md`, but does **no base-dir containment** → arbitrary `.md` read anywhere on disk (e.g. a Windows path with no `..`, or a symlink).
4. **`server/pty-manager.ts:89-91`** — `goal.model` flows unvalidated into `--model <argv>`; `GoalModelSchema = z.string()` (`src/shared/schemas.ts:13`) accepts anything; `goal.cwd` is unvalidated (`cwd: z.string().min(1)`).

**Design spine (frictionless local dev, fail-closed on LAN):**
- Bind `127.0.0.1` by default; LAN exposure is an explicit opt-in (`CLAUDE_DECK_BIND=0.0.0.0`).
- A shared bearer token (`CLAUDE_DECK_TOKEN`) gates `/api` and the WS upgrade.
- **Token-requirement rule (the only place the gate bites):**
  - bound to **loopback** AND **no token set** → **allow** (zero-friction local dev).
  - bound to a **non-loopback** host AND **no token set** → **refuse to start** with a clear error (fail-closed).
  - token set (any bind) → **require** it on `/api` and WS.
- `cwd` must be absolute, exist, and resolve within an allow-list (`CLAUDE_DECK_ALLOWED_ROOTS`, defaulting to the owner's repo dir). **Phase 5A handoff:** the Project Registry's `ProjectService.isPathAllowed()` supersedes this env list; the resolver is written behind a single function so 5A swaps the source without touching call sites.
- `skill-content` path is resolved and asserted prefix-within the known skill roots.
- `goal.model` is validated against Phase 0A's `resolveModel` (or rejected) before it reaches `pty.spawn` argv.

**Test env:** all new tests go under `tests/server/**` and run in the `server` (node) Vitest project (`vite.config.ts:44-52` — `include: ['tests/server/**/*.test.ts']`). Run with `npm test`. The `tests/shared/**` security helper (Task 1) runs in **both** projects per `vite.config.ts`, but we keep the security module server-only by placing its test under `tests/server/**`.

**Commit discipline:** one commit per task, message ending with the `Co-Authored-By` trailer. Work on the current branch `feat/multi-agent-foundation` (already a feature branch).

---

## Task 0 — Centralize security env parsing (`CLAUDE_DECK_BIND`, `CLAUDE_DECK_TOKEN`, `CLAUDE_DECK_ALLOWED_ROOTS`)

**Goal:** Extend `loadEnv()` so the server has a single typed source for bind host, token, and allowed roots, including the fail-closed start rule.

**Files:**
- Modify: `server/env.ts`
- Test: `tests/server/env.test.ts` (new)

### Step 0.1 — Write the test first (RED)

Create `tests/server/env.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadEnv } from '../../server/env';

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  }
}

describe('loadEnv — security fields', () => {
  it('defaults bindHost to 127.0.0.1 and token to null', () => {
    withEnv({ CLAUDE_DECK_BIND: undefined, CLAUDE_DECK_TOKEN: undefined, CLAUDE_DECK_ALLOWED_ROOTS: undefined }, () => {
      const env = loadEnv();
      expect(env.bindHost).toBe('127.0.0.1');
      expect(env.token).toBeNull();
      expect(env.isLoopback).toBe(true);
    });
  });

  it('marks ::1 and localhost as loopback', () => {
    withEnv({ CLAUDE_DECK_BIND: '::1' }, () => expect(loadEnv().isLoopback).toBe(true));
    withEnv({ CLAUDE_DECK_BIND: 'localhost' }, () => expect(loadEnv().isLoopback).toBe(true));
  });

  it('marks 0.0.0.0 / LAN IP as non-loopback', () => {
    withEnv({ CLAUDE_DECK_BIND: '0.0.0.0', CLAUDE_DECK_TOKEN: 'x' }, () =>
      expect(loadEnv().isLoopback).toBe(false),
    );
  });

  it('REFUSES to start when bound non-loopback with no token (fail-closed)', () => {
    withEnv({ CLAUDE_DECK_BIND: '0.0.0.0', CLAUDE_DECK_TOKEN: undefined }, () => {
      expect(() => loadEnv()).toThrow(/CLAUDE_DECK_TOKEN/);
    });
  });

  it('allows non-loopback bind when a token is set', () => {
    withEnv({ CLAUDE_DECK_BIND: '192.168.1.50', CLAUDE_DECK_TOKEN: 'secret' }, () => {
      const env = loadEnv();
      expect(env.bindHost).toBe('192.168.1.50');
      expect(env.token).toBe('secret');
    });
  });

  it('parses CLAUDE_DECK_ALLOWED_ROOTS into absolute resolved roots', () => {
    withEnv({ CLAUDE_DECK_ALLOWED_ROOTS: 'C:\\github\\claude-deck;C:\\github\\other' }, () => {
      const env = loadEnv();
      expect(env.allowedRoots.length).toBe(2);
      // resolved + normalized
      expect(env.allowedRoots[0].toLowerCase()).toContain('claude-deck');
    });
  });

  it('rejects a blank token (whitespace-only) as unset', () => {
    withEnv({ CLAUDE_DECK_BIND: '127.0.0.1', CLAUDE_DECK_TOKEN: '   ' }, () => {
      expect(loadEnv().token).toBeNull();
    });
  });
});
```

Run: `npm test -- tests/server/env.test.ts` → **FAIL** (fields don't exist).

### Step 0.2 — Implement (GREEN)

Rewrite `server/env.ts`:

```ts
import path from 'node:path';
import os from 'node:os';

export interface ServerEnv {
  port: number;
  dataDir: string;
  logLevel: string;
  /** Host the HTTP/WS server binds to. Default loopback. */
  bindHost: string;
  /** Whether bindHost is a loopback address (127.0.0.1, ::1, localhost). */
  isLoopback: boolean;
  /** Shared bearer token, or null when none configured. */
  token: string | null;
  /** Absolute, resolved roots a goal cwd must live within. */
  allowedRoots: string[];
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '0:0:0:0:0:0:0:1']);

function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (LOOPBACK_HOSTS.has(h)) return true;
  // 127.0.0.0/8 is all loopback
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

/**
 * Splits an OS-path list. Accepts ';' (Windows) and ':' is ambiguous on
 * Windows (drive letters) so we ONLY split on ';' and ',' — never ':'.
 */
function parseRoots(raw: string | undefined): string[] {
  if (!raw || raw.trim().length === 0) {
    // Default allow-list: the directory the server runs in (the owner's repo).
    return [path.resolve(process.cwd())];
  }
  return raw
    .split(/[;,]/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => path.resolve(p));
}

/**
 * Loads and validates server environment variables, including the
 * security-relevant bind host, shared token, and cwd allow-list.
 *
 * Fail-closed rule: refuses to start if bound to a non-loopback host
 * with no token set.
 */
export function loadEnv(): ServerEnv {
  const rawPort = process.env['PORT'] ?? '4100';
  const port = parseInt(rawPort, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${rawPort}. Must be between 1 and 65535.`);
  }

  const rawDataDir = process.env['DATA_DIR'] ?? './data';
  const dataDir = path.resolve(rawDataDir);

  const logLevel = process.env['LOG_LEVEL'] ?? 'info';

  const bindHost = (process.env['CLAUDE_DECK_BIND'] ?? '127.0.0.1').trim();
  const isLoopback = isLoopbackHost(bindHost);

  const rawToken = process.env['CLAUDE_DECK_TOKEN'];
  const token = rawToken && rawToken.trim().length > 0 ? rawToken : null;

  // Fail-closed: a LAN-exposed server with no token is an open RCE endpoint.
  if (!isLoopback && token === null) {
    throw new Error(
      `Refusing to start: CLAUDE_DECK_BIND=${bindHost} exposes the server beyond loopback ` +
        `but CLAUDE_DECK_TOKEN is not set. Set CLAUDE_DECK_TOKEN to a shared secret, ` +
        `or bind to 127.0.0.1 for local-only access.`,
    );
  }

  const allowedRoots = parseRoots(process.env['CLAUDE_DECK_ALLOWED_ROOTS']);

  void os; // os reserved for future home-dir default; keep import stable
  return { port, dataDir, logLevel, bindHost, isLoopback, token, allowedRoots };
}
```

> The `void os;` line is a deliberate placeholder so a later default (`~`) can be wired without re-adding the import; remove it if your linter forbids it and drop the `os` import.

Run: `npm test -- tests/server/env.test.ts` → **GREEN**.

### Step 0.3 — Verify & commit

```
npm test -- tests/server/env.test.ts
npm run typecheck
git add server/env.ts tests/server/env.test.ts
git commit
```

Commit message:

```
feat(security): centralize bind/token/allowed-roots env parsing with fail-closed rule

server/env.ts now exposes bindHost, isLoopback, token, allowedRoots and
refuses to start when bound non-loopback with no CLAUDE_DECK_TOKEN.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## Task 1 — Bind to `127.0.0.1` by default (LAN via explicit opt-in)

**Goal:** `server.listen` uses `env.bindHost` so the default is loopback-only; LAN requires `CLAUDE_DECK_BIND`.

**Files:**
- Modify: `server/index.ts` (the `server.listen(...)` near the end, ~line 308)
- Test: `tests/server/bind.test.ts` (new)

> We don't import `server/index.ts` in a test (it boots the whole app). Instead we test the **behavior contract** of binding to a host via a tiny http server using `env.bindHost`, proving loopback default rejects an external-style connection attempt only at the address level. The high-value assertion is that `loadEnv().bindHost` is `127.0.0.1` by default (covered in Task 0) and that `index.ts` passes it to `listen`. To make the wiring testable, extract the listen host into the existing flow without changing structure.

### Step 1.1 — Write the test (RED)

Create `tests/server/bind.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * Proves that listening on the loopback host yields an address bound to
 * 127.0.0.1 (not 0.0.0.0). This is the contract index.ts must satisfy by
 * passing env.bindHost to server.listen.
 */
function listenOn(host: string): Promise<{ address: string; close: () => void }> {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, host, () => {
      const addr = srv.address() as AddressInfo;
      resolve({ address: addr.address, close: () => srv.close() });
    });
  });
}

describe('server bind host', () => {
  it('binds to 127.0.0.1 when host is loopback', async () => {
    const { address, close } = await listenOn('127.0.0.1');
    expect(address).toBe('127.0.0.1');
    close();
  });

  it('binds to 0.0.0.0 only when explicitly requested', async () => {
    const { address, close } = await listenOn('0.0.0.0');
    expect(address).toBe('0.0.0.0');
    close();
  });
});
```

Run: `npm test -- tests/server/bind.test.ts` → **GREEN already** (this is a guard test documenting the contract; the real change is the one-liner in index.ts). Keep it: it locks the platform behavior we rely on.

### Step 1.2 — Implement the one-line wiring change

In `server/index.ts`, change the listen call:

```ts
// Start listening — bind to loopback by default; LAN exposure requires
// CLAUDE_DECK_BIND. env.loadEnv() already fail-closes a non-loopback bind
// that has no token.
server.listen(env.port, env.bindHost, () => {
  logger.info({ port: env.port, host: env.bindHost, lan: !env.isLoopback }, 'claude-deck server listening');
});
```

(Replaces the existing `server.listen(env.port, () => { ... })` at ~line 308.)

### Step 1.3 — Verify & commit

```
npm test -- tests/server/bind.test.ts
npm run typecheck
git add server/index.ts tests/server/bind.test.ts
git commit
```

```
feat(security): bind to 127.0.0.1 by default; LAN via CLAUDE_DECK_BIND

server.listen now passes env.bindHost. Default is loopback-only.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## Task 2 — Shared-secret auth middleware for `/api`

**Goal:** A bearer-token middleware that enforces `CLAUDE_DECK_TOKEN` on `/api` when a token is required, and is a frictionless no-op for loopback dev with no token. Exempt `/api/health` so container liveness probes work without the secret.

**Files:**
- Create: `server/middleware/auth.ts`
- Modify: `server/app.ts` (mount the middleware before the API routers), `server/index.ts` (pass auth config into `createApp`)
- Test: `tests/server/middleware/auth.test.ts` (new)

### Step 2.1 — Write the test (RED)

Create `tests/server/middleware/auth.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import http from 'node:http';
import express from 'express';
import { createApiAuthMiddleware } from '../../../server/middleware/auth';

function appWith(token: string | null): { server: http.Server; portP: Promise<number> } {
  const app = express();
  app.use(express.json());
  app.use('/api', createApiAuthMiddleware({ token }));
  app.get('/api/health', (_req, res) => res.json({ ok: true })); // exempt
  app.get('/api/secret', (_req, res) => res.json({ data: 42 }));
  const server = http.createServer(app);
  const portP = new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const a = server.address();
      resolve(typeof a === 'object' && a ? a.port : 0);
    }),
  );
  return { server, portP };
}

describe('API auth middleware', () => {
  it('allows everything when no token is configured (loopback dev)', async () => {
    const { server, portP } = appWith(null);
    const port = await portP;
    const res = await fetch(`http://127.0.0.1:${port}/api/secret`);
    expect(res.status).toBe(200);
    server.close();
  });

  it('401s a protected route with no Authorization header when token required', async () => {
    const { server, portP } = appWith('s3cret');
    const port = await portP;
    const res = await fetch(`http://127.0.0.1:${port}/api/secret`);
    expect(res.status).toBe(401);
    server.close();
  });

  it('allows a protected route with the correct Bearer token', async () => {
    const { server, portP } = appWith('s3cret');
    const port = await portP;
    const res = await fetch(`http://127.0.0.1:${port}/api/secret`, {
      headers: { Authorization: 'Bearer s3cret' },
    });
    expect(res.status).toBe(200);
    server.close();
  });

  it('401s a protected route with a wrong token', async () => {
    const { server, portP } = appWith('s3cret');
    const port = await portP;
    const res = await fetch(`http://127.0.0.1:${port}/api/secret`, {
      headers: { Authorization: 'Bearer nope' },
    });
    expect(res.status).toBe(401);
    server.close();
  });

  it('exempts /api/health even when a token is required', async () => {
    const { server, portP } = appWith('s3cret');
    const port = await portP;
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(res.status).toBe(200);
    server.close();
  });

  it('accepts the token via X-Claude-Deck-Token header (for the hook client)', async () => {
    const { server, portP } = appWith('s3cret');
    const port = await portP;
    const res = await fetch(`http://127.0.0.1:${port}/api/secret`, {
      headers: { 'X-Claude-Deck-Token': 's3cret' },
    });
    expect(res.status).toBe(200);
    server.close();
  });
});
```

Run: `npm test -- tests/server/middleware/auth.test.ts` → **FAIL** (module missing).

### Step 2.2 — Implement (GREEN)

Create `server/middleware/auth.ts`:

```ts
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { timingSafeEqual } from 'node:crypto';
import logger from '../logger';

export interface ApiAuthConfig {
  /** Shared secret. null = no token configured → allow all (loopback dev). */
  token: string | null;
}

/** Paths under /api that never require the token (liveness probes). */
const EXEMPT_PATHS = new Set(['/health']);

/** Constant-time string compare that tolerates length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Extracts the presented token from the request: `Authorization: Bearer <t>`,
 * the `X-Claude-Deck-Token` header, or a `?token=` query param (WS-style
 * fallback for browsers that can't set headers). Returns null if absent.
 */
export function extractToken(req: Request): string | null {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length).trim() || null;
  }
  const hdr = req.headers['x-claude-deck-token'];
  if (typeof hdr === 'string' && hdr.trim().length > 0) return hdr.trim();
  const q = (req.query as Record<string, unknown>)['token'];
  if (typeof q === 'string' && q.length > 0) return q;
  return null;
}

/**
 * Creates the /api bearer-token middleware.
 * - token === null → no-op (frictionless loopback dev).
 * - token set → require a matching token on every /api request except EXEMPT_PATHS.
 */
export function createApiAuthMiddleware(config: ApiAuthConfig): RequestHandler {
  const { token } = config;
  return (req: Request, res: Response, next: NextFunction): void => {
    if (token === null) {
      next();
      return;
    }
    // req.path here is relative to the /api mount, e.g. '/health', '/goals'.
    if (EXEMPT_PATHS.has(req.path)) {
      next();
      return;
    }
    const presented = extractToken(req);
    if (presented !== null && safeEqual(presented, token)) {
      next();
      return;
    }
    logger.warn({ path: req.path, ip: req.ip }, 'Rejected unauthenticated /api request');
    res.status(401).json({ error: 'Unauthorized' });
  };
}
```

Wire it into `server/app.ts`. Extend the options and mount the middleware **before** the API routers, **after** CORS + JSON:

```ts
export interface AppRouters {
  /** Additional routers to mount under /api. */
  apiRouters?: Router[];
  /** Shared-secret auth config; token null = no-op (loopback dev). */
  auth?: { token: string | null };
}
```

In `createApp`, after `app.use(express.json({ limit: '10mb' }));` and before mounting health/routers, add:

```ts
import { createApiAuthMiddleware } from './middleware/auth';
// ...
  // Shared-secret gate on all /api routes (no-op when no token configured).
  app.use('/api', createApiAuthMiddleware({ token: options?.auth?.token ?? null }));
```

> Note ordering: health is mounted *after* the auth middleware, so the EXEMPT_PATHS check inside the middleware is what keeps `/api/health` open — not mount order.

In `server/index.ts`, pass the token into `createApp`:

```ts
const app = createApp({
  apiRouters: [scheduledRouter, goalsRouter, sessionsRouter, hooksRouter, approvalsRouter, systemRouterWithSkills, skillsRouter],
  auth: { token: env.token },
});
```

### Step 2.3 — Guard existing tests

Some existing route tests build their own Express app (e.g. `tests/server/routes/system.test.ts`, `tests/server/app.test.ts`) and call `createApp()` / mount routers directly with **no token**. Because `token` defaults to `null`, those remain green (no-op auth). Re-run the full suite to confirm:

```
npm test
```

Expected: no new failures vs the Phase 0 green baseline.

### Step 2.4 — Commit

```
git add server/middleware/auth.ts server/app.ts server/index.ts tests/server/middleware/auth.test.ts
git commit
```

```
feat(security): shared-secret bearer-token middleware on /api

createApiAuthMiddleware enforces CLAUDE_DECK_TOKEN (constant-time compare)
on all /api routes except /api/health. No-op when no token configured.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## Task 3 — Auth + Origin check on the WebSocket upgrade

**Goal:** Reject WS connections that (a) come from a disallowed Origin or (b) lack the token when one is required. Token may arrive via the `?token=` query param or the `Sec-WebSocket-Protocol` subprotocol header (browsers can't set arbitrary headers on WS).

**Files:**
- Modify: `server/ws.ts` (`setupWss` gains a config arg + `verifyClient`)
- Modify: `server/index.ts` (`setupWss(server, { token, allowedOrigins })`)
- Test: `tests/server/ws-auth.test.ts` (new)

### Step 3.1 — Write the test (RED)

Create `tests/server/ws-auth.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { WebSocket } from 'ws';
import { setupWss } from '../../server/ws';

let server: http.Server | null = null;

function start(opts: { token: string | null; allowedOrigins: string[] }): Promise<number> {
  return new Promise((resolve) => {
    const srv = http.createServer();
    setupWss(srv, opts);
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address();
      server = srv;
      resolve(typeof a === 'object' && a ? a.port : 0);
    });
  });
}

function tryConnect(url: string, headers?: Record<string, string>, protocols?: string): Promise<'open' | number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, protocols, headers ? { headers } : undefined);
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', () => resolve(-1));
  });
}

afterEach(() => { if (server) { server.close(); server = null; } });

describe('WebSocket upgrade auth', () => {
  it('accepts any connection when no token configured (loopback dev)', async () => {
    const port = await start({ token: null, allowedOrigins: [] });
    const result = await tryConnect(`ws://127.0.0.1:${port}/ws`);
    expect(result).toBe('open');
  });

  it('rejects a connection with a bad Origin even on loopback', async () => {
    const port = await start({ token: null, allowedOrigins: ['http://localhost:5173'] });
    const result = await tryConnect(`ws://127.0.0.1:${port}/ws`, { Origin: 'http://evil.example' });
    expect(result).not.toBe('open'); // 401/403 or socket error
  });

  it('rejects a connection with no token when a token is required', async () => {
    const port = await start({ token: 's3cret', allowedOrigins: ['http://localhost:5173'] });
    const result = await tryConnect(`ws://127.0.0.1:${port}/ws`, { Origin: 'http://localhost:5173' });
    expect(result).not.toBe('open');
  });

  it('accepts a connection with the token via query param', async () => {
    const port = await start({ token: 's3cret', allowedOrigins: ['http://localhost:5173'] });
    const result = await tryConnect(
      `ws://127.0.0.1:${port}/ws?token=s3cret`,
      { Origin: 'http://localhost:5173' },
    );
    expect(result).toBe('open');
  });

  it('accepts a connection with the token via subprotocol', async () => {
    const port = await start({ token: 's3cret', allowedOrigins: ['http://localhost:5173'] });
    const result = await tryConnect(
      `ws://127.0.0.1:${port}/ws`,
      { Origin: 'http://localhost:5173' },
      'claude-deck-token.s3cret',
    );
    expect(result).toBe('open');
  });
});
```

Run: `npm test -- tests/server/ws-auth.test.ts` → **FAIL** (`setupWss` doesn't take options).

### Step 3.2 — Implement (GREEN)

Modify `server/ws.ts`. Add a config arg and a `verifyClient` that checks Origin and token. Keep `setupWss`'s default behavior backward-compatible (no options ⇒ no token, no origin allow-list) so existing `tests/server/ws.test.ts` stays green.

Add near the top of the file:

```ts
import { timingSafeEqual } from 'node:crypto';

export interface WssAuthConfig {
  /** Shared secret. null = no token required. */
  token: string | null;
  /** Allowed Origin header values. Empty array = allow any origin. */
  allowedOrigins: string[];
}

const SUBPROTOCOL_PREFIX = 'claude-deck-token.';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Pulls a token out of the upgrade request: ?token= or the subprotocol header. */
function tokenFromUpgrade(reqUrl: string | undefined, protocolHeader: string | string[] | undefined): string | null {
  if (reqUrl) {
    const qIdx = reqUrl.indexOf('?');
    if (qIdx !== -1) {
      const params = new URLSearchParams(reqUrl.slice(qIdx + 1));
      const t = params.get('token');
      if (t) return t;
    }
  }
  const raw = Array.isArray(protocolHeader) ? protocolHeader.join(',') : protocolHeader;
  if (typeof raw === 'string') {
    for (const part of raw.split(',')) {
      const p = part.trim();
      if (p.startsWith(SUBPROTOCOL_PREFIX)) return p.slice(SUBPROTOCOL_PREFIX.length);
    }
  }
  return null;
}
```

Change the `setupWss` signature and replace the `WebSocketServer` construction:

```ts
export function setupWss(httpServer: HttpServer, auth?: WssAuthConfig): WebSocketServer {
  const token = auth?.token ?? null;
  const allowedOrigins = auth?.allowedOrigins ?? [];

  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    verifyClient: (info, done) => {
      // Origin check (only when an allow-list is configured).
      const origin = info.req.headers['origin'];
      if (allowedOrigins.length > 0) {
        if (typeof origin !== 'string' || !allowedOrigins.includes(origin)) {
          logger.warn({ origin }, 'WS rejected: disallowed Origin');
          done(false, 403, 'Forbidden');
          return;
        }
      }
      // Token check (only when a token is required).
      if (token !== null) {
        const presented = tokenFromUpgrade(info.req.url, info.req.headers['sec-websocket-protocol']);
        if (presented === null || !safeEqual(presented, token)) {
          logger.warn('WS rejected: missing/invalid token');
          done(false, 401, 'Unauthorized');
          return;
        }
      }
      done(true);
    },
  });

  // ... existing wss.on('connection', ...) body unchanged ...
  return wss;
}
```

> The rest of `setupWss` (the `wss.on('connection', ...)` handler, `broadcast`, `getEventGoalId`, `setTerminalHandler`) stays exactly as-is.

In `server/index.ts`, change the call:

```ts
// Build the WS Origin allow-list from the same set the CORS allow-list uses.
const wsAllowedOrigins = [
  'http://localhost:5173',
  'http://localhost:4100',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:4100',
];
setupWss(server, { token: env.token, allowedOrigins: wsAllowedOrigins });
```

> **Design note (LAN origins):** when bound to a LAN host, the browser Origin will be `http://<lan-ip>:5173`, which is not in the static list. Add the LAN host's origin via the same allow-list when `CLAUDE_DECK_BIND` is set. For this task we keep the static loopback list (matches CORS in `server/app.ts:26-31`); extending the allow-list to include the bind host is a one-line follow-up and is called out in the Self-Review as a known limitation. The token check is the primary gate on LAN; Origin is defense-in-depth against browser-driven CSRF from a malicious page.

### Step 3.3 — Verify existing WS test still passes

`tests/server/ws.test.ts` calls `setupWss(srv)` with no auth ⇒ `token=null`, `allowedOrigins=[]` ⇒ accepts any origin/no token. Confirm:

```
npm test -- tests/server/ws.test.ts tests/server/ws-auth.test.ts
npm run typecheck
```

### Step 3.4 — Commit

```
git add server/ws.ts server/index.ts tests/server/ws-auth.test.ts
git commit
```

```
feat(security): verifyClient + Origin check on WS upgrade

setupWss now takes { token, allowedOrigins }. Rejects bad Origin (403) and
missing/invalid token (401). Token via ?token= or claude-deck-token.<t>
subprotocol. No-op for loopback dev with no token.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## Task 4 — Token passthrough for the hook client and MCP client (clients send the token)

**Goal:** The local hook script (`hooks/client.js`) and the MCP server's API client (`mcp/src/api-client.ts`) must include the token on their `/api` calls, and `PtyManager` must inject the token into the MCP env of spawned sessions. Without this, enabling a token breaks the hook → server → approval path and the in-session orchestration tools.

**Files:**
- Modify: `hooks/client.js` (add `X-Claude-Deck-Token` header from `CLAUDE_DECK_TOKEN`)
- Modify: `mcp/src/api-client.ts` (add the token header from `CLAUDE_DECK_TOKEN`)
- Modify: `server/pty-manager.ts` (`buildMcpConfig` injects `CLAUDE_DECK_TOKEN` into the MCP server env)
- Test: `tests/server/mcp-api-client-auth.test.ts` (new) for the client header; `hooks/client.js` is plain JS stdlib and is covered by a focused unit test stub (see Step 4.1b).

### Step 4.1a — MCP api-client test (RED)

Create `tests/server/mcp-api-client-auth.test.ts`. The MCP client is in a separate tsconfig/package; we test the header behavior by importing the compiled-from-source class and pointing it at a throwaway HTTP server that echoes the received `authorization` header.

```ts
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { DashboardApiClient } from '../../mcp/src/api-client';

let server: http.Server | null = null;
afterEach(() => { if (server) { server.close(); server = null; } });

function echoServer(): Promise<{ port: number; lastAuth: () => string | undefined }> {
  let last: string | undefined;
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      last = req.headers['authorization'] as string | undefined;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify([])); // listGoals expects an array
    });
    srv.listen(0, '127.0.0.1', () => {
      server = srv;
      const a = srv.address();
      resolve({ port: typeof a === 'object' && a ? a.port : 0, lastAuth: () => last });
    });
  });
}

describe('MCP DashboardApiClient token passthrough', () => {
  it('sends Bearer token when CLAUDE_DECK_TOKEN is set', async () => {
    const { port, lastAuth } = await echoServer();
    const prev = process.env['CLAUDE_DECK_TOKEN'];
    process.env['CLAUDE_DECK_TOKEN'] = 'mcp-secret';
    try {
      const client = new DashboardApiClient(`http://127.0.0.1:${port}`);
      await client.listGoals();
      expect(lastAuth()).toBe('Bearer mcp-secret');
    } finally {
      if (prev === undefined) delete process.env['CLAUDE_DECK_TOKEN'];
      else process.env['CLAUDE_DECK_TOKEN'] = prev;
    }
  });

  it('sends no auth header when token unset', async () => {
    const { port, lastAuth } = await echoServer();
    const prev = process.env['CLAUDE_DECK_TOKEN'];
    delete process.env['CLAUDE_DECK_TOKEN'];
    try {
      const client = new DashboardApiClient(`http://127.0.0.1:${port}`);
      await client.listGoals();
      expect(lastAuth()).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env['CLAUDE_DECK_TOKEN'] = prev;
    }
  });
});
```

Run: `npm test -- tests/server/mcp-api-client-auth.test.ts` → **FAIL** (no header sent).

### Step 4.2a — Implement in `mcp/src/api-client.ts` (GREEN)

In the `request<T>` method, after building `headers`, read the token from env and attach it:

```ts
    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };
    const token = process.env['CLAUDE_DECK_TOKEN'];
    if (token && token.trim().length > 0) {
      headers['Authorization'] = `Bearer ${token}`;
    }
```

(Insert immediately after the existing `const headers: Record<string, string> = { 'Accept': 'application/json' };` block, before `const init: RequestInit = { method, headers };`.)

Run: `npm test -- tests/server/mcp-api-client-auth.test.ts` → **GREEN**.

### Step 4.1b/4.2b — Hook client passthrough

`hooks/client.js` is zero-dependency stdlib. Add the token header in `httpPostJson`'s `options.headers`:

```js
  var headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  };
  var token = process.env.CLAUDE_DECK_TOKEN;
  if (token && token.trim().length > 0) {
    headers['X-Claude-Deck-Token'] = token;
  }

  var options = {
    hostname: HOST,
    port: PORT,
    path: path,
    method: 'POST',
    headers: headers,
    timeout: timeoutMs,
  };
```

(Replace the inline `headers: { ... }` object in the existing `options` with the `headers` variable built above.)

Add a focused test `tests/server/hook-client-auth.test.ts` that spawns the script as a child process with `CLAUDE_DECK_TOKEN` set, pointed at an echo server, and asserts the header was received:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';

let server: http.Server | null = null;
afterEach(() => { if (server) { server.close(); server = null; } });

function echoServer(): Promise<{ port: number; received: Promise<string | undefined> }> {
  let resolveHdr: (v: string | undefined) => void;
  const received = new Promise<string | undefined>((r) => (resolveHdr = r));
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      resolveHdr(req.headers['x-claude-deck-token'] as string | undefined);
      res.end(JSON.stringify({ ok: true }));
    });
    srv.listen(0, '127.0.0.1', () => {
      server = srv;
      const a = srv.address();
      resolve({ port: typeof a === 'object' && a ? a.port : 0, received });
    });
  });
}

describe('hooks/client.js token passthrough', () => {
  it('sends X-Claude-Deck-Token when CLAUDE_DECK_TOKEN set', async () => {
    const { port, received } = await echoServer();
    const script = path.resolve(process.cwd(), 'hooks', 'client.js');
    const child = spawn(process.execPath, [script, 'post-tool-use'], {
      env: { ...process.env, CLAUDE_DECK_PORT: String(port), CLAUDE_DECK_HOST: '127.0.0.1', CLAUDE_DECK_TOKEN: 'hook-secret' },
    });
    child.stdin.write(JSON.stringify({ hook_event_name: 'PostToolUse' }));
    child.stdin.end();
    const hdr = await received;
    expect(hdr).toBe('hook-secret');
  });
});
```

Run: `npm test -- tests/server/hook-client-auth.test.ts` → should pass after the edit.

### Step 4.3 — PtyManager injects the token into spawned-session MCP env (GREEN)

In `server/pty-manager.ts`, `buildMcpConfig()` builds the MCP server env. Add the token so in-session MCP tools authenticate back to `/api`:

```ts
      const port = process.env['PORT'] ?? '4100';
      const baseUrl = `http://127.0.0.1:${port}`;

      const mcpEnv: Record<string, string> = {
        CLAUDE_DECK_URL: baseUrl,
        CLAUDE_DECK_GOAL_ID: this.goalId,
      };
      const token = process.env['CLAUDE_DECK_TOKEN'];
      if (token && token.trim().length > 0) {
        mcpEnv['CLAUDE_DECK_TOKEN'] = token;
      }

      return JSON.stringify({
        mcpServers: {
          'claude-deck': {
            command: 'node',
            args: [mcpEntry],
            env: mcpEnv,
          },
        },
      });
```

> The MCP client reads `CLAUDE_DECK_TOKEN` (Step 4.2a) and the server validates it (Task 2). The chain closes: spawned session → MCP server (has token in env) → `/api` (token accepted).

> **Note:** the MCP client currently hardcodes `DEFAULT_BASE_URL` / ignores `CLAUDE_DECK_URL`; the env injection above sets `CLAUDE_DECK_URL` (already passed today) and `CLAUDE_DECK_TOKEN`. If the MCP server entry doesn't yet read `CLAUDE_DECK_URL`, that is out of scope for 0B (the token is the security-relevant addition). The token read in 4.2a is env-based and works regardless of base-URL wiring.

### Step 4.4 — Verify & commit

```
npm test -- tests/server/mcp-api-client-auth.test.ts tests/server/hook-client-auth.test.ts
npm run typecheck
git add hooks/client.js mcp/src/api-client.ts server/pty-manager.ts tests/server/mcp-api-client-auth.test.ts tests/server/hook-client-auth.test.ts
git commit
```

```
feat(security): token passthrough for hook client, MCP client, spawned-session MCP env

hooks/client.js and mcp api-client send CLAUDE_DECK_TOKEN; PtyManager injects
it into the spawned session's MCP server env so in-session tools authenticate.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## Task 5 — `cwd` containment (absolute, exists, within allowed roots)

**Goal:** Reject goal creation when `cwd` is not absolute, does not exist, or resolves outside the `CLAUDE_DECK_ALLOWED_ROOTS` list. Centralize the check behind one function so Phase 5A's `ProjectService.isPathAllowed()` can replace the env source without touching call sites.

**Files:**
- Create: `server/security/path-allow.ts` (the single allow-list resolver)
- Modify: `server/routes/goals.ts` (validate `cwd` on `POST /goals` and `POST /goals/create-and-instruct`)
- Modify: `server/index.ts` (build the router with the allowed roots)
- Test: `tests/server/security/path-allow.test.ts` (new), `tests/server/routes/goals-cwd.test.ts` (new)

### Step 5.1 — Write the resolver test (RED)

Create `tests/server/security/path-allow.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createCwdValidator } from '../../../server/security/path-allow';

describe('cwd validator', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-root-'));
  const inside = fs.mkdtempSync(path.join(root, 'goal-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-out-'));
  const validate = createCwdValidator({ allowedRoots: [root] });

  it('accepts an existing dir inside an allowed root', () => {
    expect(validate(inside)).toEqual({ ok: true, resolved: fs.realpathSync(inside) });
  });

  it('rejects a relative path', () => {
    const r = validate('some/rel/path');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/absolute/i);
  });

  it('rejects a non-existent path', () => {
    const r = validate(path.join(root, 'does-not-exist'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/exist/i);
  });

  it('rejects a dir outside all allowed roots', () => {
    const r = validate(outside);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/allowed/i);
  });

  it('rejects a traversal that escapes the root after resolution', () => {
    const escape = path.join(inside, '..', '..', '..');
    const r = validate(escape);
    expect(r.ok).toBe(false);
  });

  it('accepts the root itself', () => {
    expect(validate(root).ok).toBe(true);
  });
});
```

Run: `npm test -- tests/server/security/path-allow.test.ts` → **FAIL** (module missing).

### Step 5.2 — Implement the resolver (GREEN)

Create `server/security/path-allow.ts`:

```ts
import path from 'node:path';
import fs from 'node:fs';

export type CwdValidation =
  | { ok: true; resolved: string }
  | { ok: false; reason: string };

export interface CwdValidatorConfig {
  /** Absolute roots a cwd must live within. */
  allowedRoots: string[];
}

/** True if `child` equals `parent` or is nested under it (case-insensitive on Windows). */
function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  // Same dir → '' ; nested → no leading '..' and not absolute.
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Builds a cwd validator over a fixed allow-list. The returned function:
 * - requires an absolute path,
 * - requires the path to exist (real, resolving symlinks),
 * - requires the resolved real path to be within one of the allowed roots.
 *
 * Phase 5A handoff: replace `allowedRoots` with ProjectService.isPathAllowed()
 * by swapping this factory's source — call sites take the returned function and
 * are unaffected.
 */
export function createCwdValidator(config: CwdValidatorConfig) {
  const roots = config.allowedRoots.map((r) => {
    try {
      return fs.realpathSync(path.resolve(r));
    } catch {
      return path.resolve(r);
    }
  });

  return function validate(rawCwd: string): CwdValidation {
    if (!path.isAbsolute(rawCwd)) {
      return { ok: false, reason: 'cwd must be an absolute path' };
    }
    let resolved: string;
    try {
      resolved = fs.realpathSync(rawCwd); // resolves symlinks; throws if missing
    } catch {
      return { ok: false, reason: 'cwd does not exist' };
    }
    const allowed = roots.some((root) => isWithin(root, resolved));
    if (!allowed) {
      return { ok: false, reason: 'cwd is not within an allowed root' };
    }
    return { ok: true, resolved };
  };
}

export type CwdValidator = ReturnType<typeof createCwdValidator>;
```

Run: `npm test -- tests/server/security/path-allow.test.ts` → **GREEN**.

### Step 5.3 — Wire into the goals router (RED → GREEN)

Create `tests/server/routes/goals-cwd.test.ts` (route-level: stand up the goals router with a validator and an in-memory DB). Mirror the structure of `tests/server/routes/goals.test.ts` for DB setup; the key additions:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';
import { createGoalService } from '../../../server/services/goal-service';
import { createGoalsRouter } from '../../../server/routes/goals';
import { createCwdValidator } from '../../../server/security/path-allow';

function appWith(allowedRoots: string[]): { server: http.Server; portP: Promise<number> } {
  const db = new Database(':memory:');
  runMigrations(db);
  const goalService = createGoalService(db);
  const validateCwd = createCwdValidator({ allowedRoots });
  const router = createGoalsRouter(goalService, undefined, undefined, { validateCwd });
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const server = http.createServer(app);
  const portP = new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const a = server.address();
      resolve(typeof a === 'object' && a ? a.port : 0);
    }),
  );
  return { server, portP };
}

describe('POST /goals cwd containment', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'goals-root-'));
  const inside = fs.mkdtempSync(path.join(root, 'g-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'goals-out-'));

  it('201s a goal whose cwd is inside an allowed root', async () => {
    const { server, portP } = appWith([root]);
    const port = await portP;
    const res = await fetch(`http://127.0.0.1:${port}/api/goals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'ok-goal', cwd: inside }),
    });
    expect(res.status).toBe(201);
    server.close();
  });

  it('400s a goal whose cwd is outside all allowed roots', async () => {
    const { server, portP } = appWith([root]);
    const port = await portP;
    const res = await fetch(`http://127.0.0.1:${port}/api/goals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'bad-goal', cwd: outside }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/allowed/i);
    server.close();
  });

  it('400s a relative cwd', async () => {
    const { server, portP } = appWith([root]);
    const port = await portP;
    const res = await fetch(`http://127.0.0.1:${port}/api/goals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'rel-goal', cwd: 'relative/path' }),
    });
    expect(res.status).toBe(400);
    server.close();
  });
});
```

Run: **FAIL** (router doesn't accept the 4th `security` arg).

Now extend `server/routes/goals.ts`. Add an optional `security` param carrying the validators (cwd here; model in Task 7), and validate `cwd` in both create handlers:

```ts
export interface GoalsRouterSecurity {
  validateCwd?: (cwd: string) => { ok: true; resolved: string } | { ok: false; reason: string };
  validateModel?: (model: string | undefined) => { ok: true } | { ok: false; reason: string };
}

export function createGoalsRouter(
  goalService: GoalService,
  spawnTerminal?: (goalId: string, initialPrompt?: string) => string,
  interGoalMessageService?: InterGoalMessageService,
  security?: GoalsRouterSecurity,
): Router {
```

In the `POST /goals` handler, immediately after `validateBody(CreateGoalInputSchema)` succeeds (i.e. at the top of the route callback, before `goalService.create`):

```ts
      if (security?.validateCwd) {
        const v = security.validateCwd(req.body.cwd);
        if (!v.ok) {
          res.status(400).json({ error: `Invalid cwd: ${v.reason}` });
          return;
        }
      }
```

Apply the same guard at the top of the `POST /goals/create-and-instruct` handler (it also takes `cwd`), right after the `interGoalMessageService` null-check:

```ts
        if (security?.validateCwd) {
          const v = security.validateCwd(req.body.cwd);
          if (!v.ok) {
            res.status(400).json({ error: `Invalid cwd: ${v.reason}` });
            return;
          }
        }
```

In `server/index.ts`, build the validator from `env.allowedRoots` and pass it:

```ts
import { createCwdValidator } from './security/path-allow';
// ...
const validateCwd = createCwdValidator({ allowedRoots: env.allowedRoots });
const goalsRouter = createGoalsRouter(goalService, spawnTerminalSession, interGoalMessageService, { validateCwd });
```

Run: `npm test -- tests/server/routes/goals-cwd.test.ts` → **GREEN**.

> **Existing-test note:** `tests/server/routes/goals.test.ts` constructs the router with no `security` arg, so `validateCwd` is undefined and cwd is not enforced there — those tests stay green. Production wiring (index.ts) always supplies the validator.

### Step 5.4 — Verify & commit

```
npm test -- tests/server/security/path-allow.test.ts tests/server/routes/goals-cwd.test.ts
npm run typecheck
git add server/security/path-allow.ts server/routes/goals.ts server/index.ts tests/server/security/path-allow.test.ts tests/server/routes/goals-cwd.test.ts
git commit
```

```
feat(security): cwd containment against CLAUDE_DECK_ALLOWED_ROOTS

Goal cwd must be absolute, exist (realpath), and resolve within an allowed
root. Resolver is factory-isolated so Phase 5A ProjectService can supersede it.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## Task 6 — Path containment for `GET /api/skill-content`

**Goal:** Replace the substring `'..'` check with `path.resolve` + prefix-within-known-skill-roots. The skill roots are the project `.claude/{skills,agents,hooks,commands}`, user `~/.claude/{...}`, and any configured custom skill directories.

**Files:**
- Modify: `server/routes/system.ts` (`GET /skill-content` + factory gains skill roots)
- Modify: `server/index.ts` (pass the configured skill directories / roots when building the system router)
- Test: `tests/server/routes/skill-content.test.ts` (new)

### Step 6.1 — Write the test (RED)

Create `tests/server/routes/skill-content.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createSystemRouter } from '../../../server/routes/system';

let server: http.Server | null = null;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
const goodFile = path.join(root, 'my-skill.md');
fs.writeFileSync(goodFile, '# hi');
const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
const secret = path.join(outsideDir, 'secret.md');
fs.writeFileSync(secret, 'TOP SECRET');

function start(): Promise<number> {
  // System router takes an extra skillRoots arg (added below).
  const router = createSystemRouter(undefined, { skillRoots: [root] });
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const srv = http.createServer(app);
  return new Promise((resolve) =>
    srv.listen(0, '127.0.0.1', () => {
      server = srv;
      const a = srv.address();
      resolve(typeof a === 'object' && a ? a.port : 0);
    }),
  );
}
afterEach(() => { if (server) { server.close(); server = null; } });

describe('GET /api/skill-content path containment', () => {
  it('reads an .md file inside an allowed skill root', async () => {
    const port = await start();
    const res = await fetch(`http://127.0.0.1:${port}/api/skill-content?path=${encodeURIComponent(goodFile)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string };
    expect(body.content).toBe('# hi');
  });

  it('403s a real .md file OUTSIDE every skill root (no .. needed)', async () => {
    const port = await start();
    const res = await fetch(`http://127.0.0.1:${port}/api/skill-content?path=${encodeURIComponent(secret)}`);
    expect(res.status).toBe(403);
  });

  it('rejects a non-.md file', async () => {
    const port = await start();
    const res = await fetch(`http://127.0.0.1:${port}/api/skill-content?path=${encodeURIComponent(path.join(root, 'x.txt'))}`);
    expect(res.status).toBe(400);
  });

  it('403s a traversal path that escapes the root', async () => {
    const port = await start();
    const evil = path.join(root, '..', path.basename(outsideDir), 'secret.md');
    const res = await fetch(`http://127.0.0.1:${port}/api/skill-content?path=${encodeURIComponent(evil)}`);
    expect(res.status).toBe(403);
  });
});
```

Run: **FAIL** (router doesn't take skill roots; current handler reads any `.md`).

### Step 6.2 — Implement (GREEN)

Modify `server/routes/system.ts`. Change the factory signature to accept skill roots and use `createCwdValidator`-style containment for the path. Reuse the `isWithin` logic by importing from the security module (export a small helper) or inline it.

First, export a path-containment helper from `server/security/path-allow.ts` (add to that file):

```ts
/**
 * Resolves `candidate` and returns true if it sits within any of `roots`.
 * Roots and candidate are resolved (symlinks where they exist) before compare.
 */
export function pathWithinRoots(candidate: string, roots: string[]): boolean {
  let resolvedCandidate: string;
  try {
    resolvedCandidate = fs.realpathSync(candidate);
  } catch {
    resolvedCandidate = path.resolve(candidate);
  }
  const resolvedRoots = roots.map((r) => {
    try { return fs.realpathSync(path.resolve(r)); } catch { return path.resolve(r); }
  });
  return resolvedRoots.some((root) => isWithin(root, resolvedCandidate));
}
```

> `isWithin` is currently module-private in `path-allow.ts`; `pathWithinRoots` lives in the same file so it can use it directly. Export only `pathWithinRoots`.

Now in `server/routes/system.ts`:

```ts
import { pathWithinRoots } from '../security/path-allow';

export interface SystemRouterConfig {
  /** Directories under which skill/agent .md files may be read. */
  skillRoots?: string[];
}

export function createSystemRouter(
  skillDirService?: SkillDirectoryService,
  config?: SystemRouterConfig,
): Router {
  const router = Router();
  const skillRoots = config?.skillRoots ?? defaultSkillRoots();
  // ...
```

Add a `defaultSkillRoots()` helper near the top of the factory (mirrors `skill-scanner.ts` locations):

```ts
function defaultSkillRoots(): string[] {
  const roots: string[] = [];
  for (const surface of ['skills', 'agents', 'hooks', 'commands']) {
    roots.push(path.join(process.cwd(), '.claude', surface));
    roots.push(path.join(os.homedir(), '.claude', surface));
  }
  return roots;
}
```

Replace the body of `GET /skill-content` (lines ~64-95) with:

```ts
router.get('/skill-content', (req, res) => {
  const filePath = req.query['path'];
  if (typeof filePath !== 'string' || filePath.length === 0) {
    res.status(400).json({ error: 'path query parameter is required' });
    return;
  }
  if (!filePath.endsWith('.md')) {
    res.status(400).json({ error: 'Only .md files can be read' });
    return;
  }
  // Containment: the resolved path must live within a known skill root.
  if (!pathWithinRoots(filePath, skillRoots)) {
    logger.warn({ filePath }, 'skill-content rejected: outside skill roots');
    res.status(403).json({ error: 'Path is outside the allowed skill directories' });
    return;
  }
  try {
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    res.json({ content, path: filePath });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, 'Failed to read skill content');
    res.status(500).json({ error: message });
  }
});
```

> Keep the existing `default export` at the bottom (`export default createSystemRouter();`) — it now uses `defaultSkillRoots()` via the `config` default, preserving backward compatibility for any importer of the default router.

In `server/index.ts`, supply the configured skill roots. The custom skill directories live in `skillDirectoryService.list()`; combine them with the defaults:

```ts
const customSkillDirs = skillDirectoryService.list().map((d) => d.path);
const systemRouterWithSkills = createSystemRouter(skillDirectoryService, {
  skillRoots: [
    ...customSkillDirs,
    ...['skills', 'agents', 'hooks', 'commands'].flatMap((s) => [
      join(process.cwd(), '.claude', s),
      join(homedir(), '.claude', s),
    ]),
  ],
});
```

(`join` and `homedir` are already imported in index.ts at lines 34-35.)

Run: `npm test -- tests/server/routes/skill-content.test.ts` → **GREEN**.

### Step 6.3 — Verify & commit

```
npm test -- tests/server/routes/skill-content.test.ts tests/server/routes/system.test.ts
npm run typecheck
git add server/routes/system.ts server/security/path-allow.ts server/index.ts tests/server/routes/skill-content.test.ts
git commit
```

```
feat(security): skill-content path containment (resolve + within skill roots)

GET /api/skill-content now resolves the path and asserts it lives within a
known skill root, replacing the substring '..' check (arbitrary .md read fix).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## Task 7 — Constrain the goal `model` arg (validate against Phase 0A `resolveModel`)

**Goal:** Validate `goal.model` against the Phase 0A model registry (`resolveModel(raw) !== null`) before it can reach `pty.spawn`'s `--model` argv. Reject unknown models at goal-create time so attacker-controlled model strings never become CLI arguments.

**Files:**
- Create: `server/security/model-allow.ts` (validator that wraps `resolveModel`)
- Modify: `server/routes/goals.ts` (validate `model` in both create handlers via the existing `security` param)
- Modify: `server/index.ts` (build and pass the model validator)
- Test: `tests/server/security/model-allow.test.ts` (new), `tests/server/routes/goals-model.test.ts` (new)

> **Locked contract:** `src/shared/agents/model-registry.ts` exports `resolveModel(raw: string | null): ModelEntry | null`. Built by the Phase 0A plan.

### Step 7.1 — Write the validator test (RED)

Create `tests/server/security/model-allow.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createModelValidator } from '../../../server/security/model-allow';

describe('model validator', () => {
  const validate = createModelValidator();

  it('accepts undefined model (uses CLI default)', () => {
    expect(validate(undefined).ok).toBe(true);
  });

  it("accepts 'default' (sentinel — not passed to --model)", () => {
    expect(validate('default').ok).toBe(true);
  });

  it('accepts a known registry model', () => {
    // resolveModel must recognize a current Claude model id.
    expect(validate('claude-opus-4-8').ok).toBe(true);
  });

  it('rejects an unknown / attacker-controlled model string', () => {
    const r = validate('--dangerously-skip; rm -rf /');
    expect(r.ok).toBe(false);
  });

  it('rejects a model that does not resolve in the registry', () => {
    expect(validate('totally-made-up-model').ok).toBe(false);
  });
});
```

Run: **FAIL** (module missing). If `model-registry.ts` does not yet exist, see fallback note below.

### Step 7.2 — Implement (GREEN)

Create `server/security/model-allow.ts`:

```ts
import { resolveModel } from '../../src/shared/agents/model-registry';

export type ModelValidation = { ok: true } | { ok: false; reason: string };

/**
 * Builds a model validator. A goal's model is allowed when:
 * - it is undefined (CLI uses its own default), or
 * - it is the 'default' sentinel (PtyManager skips --model for this), or
 * - resolveModel(model) returns a known ModelEntry.
 *
 * Anything else is rejected so unvalidated strings never reach `--model` argv.
 */
export function createModelValidator() {
  return function validate(model: string | undefined): ModelValidation {
    if (model === undefined || model === 'default') return { ok: true };
    if (resolveModel(model) !== null) return { ok: true };
    return { ok: false, reason: `unknown model '${model}'` };
  };
}

export type ModelValidator = ReturnType<typeof createModelValidator>;
```

> **Missing-contract fallback (only if Phase 0A has NOT landed):** if `src/shared/agents/model-registry.ts` does not exist when 0B executes, do NOT block — instead create a temporary `KNOWN_MODELS` set in `model-allow.ts` (`['claude-opus-4-8','claude-opus-4-1','claude-sonnet-4-5','claude-haiku-4-5','claude-fable-5']` plus a `[1m]`-suffix tolerance) and validate against it, with a `// TODO(phase-0a): replace with resolveModel` marker. Swap to `resolveModel` the moment 0A merges. The route wiring and tests are unchanged.

### Step 7.3 — Wire into the goals router (RED → GREEN)

The `security` param already exists (Task 5). Add the `validateModel` guard right after the `validateCwd` guard in **both** create handlers:

```ts
      if (security?.validateModel) {
        const m = security.validateModel(req.body.model);
        if (!m.ok) {
          res.status(400).json({ error: `Invalid model: ${m.reason}` });
          return;
        }
      }
```

In `server/index.ts`:

```ts
import { createModelValidator } from './security/model-allow';
// ...
const validateModel = createModelValidator();
const goalsRouter = createGoalsRouter(goalService, spawnTerminalSession, interGoalMessageService, {
  validateCwd,
  validateModel,
});
```

Create `tests/server/routes/goals-model.test.ts` (same harness as `goals-cwd.test.ts`, passing `{ validateCwd, validateModel }`; use a real allowed cwd so cwd passes and model is the only failing axis):

```ts
import { describe, it, expect } from 'vitest';
import http from 'node:http';
import express from 'express';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';
import { createGoalService } from '../../../server/services/goal-service';
import { createGoalsRouter } from '../../../server/routes/goals';
import { createCwdValidator } from '../../../server/security/path-allow';
import { createModelValidator } from '../../../server/security/model-allow';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-root-'));
const cwd = fs.mkdtempSync(path.join(root, 'g-'));

function app(): Promise<number> {
  const db = new Database(':memory:');
  runMigrations(db);
  const router = createGoalsRouter(createGoalService(db), undefined, undefined, {
    validateCwd: createCwdValidator({ allowedRoots: [root] }),
    validateModel: createModelValidator(),
  });
  const a = express();
  a.use(express.json());
  a.use('/api', router);
  const srv = http.createServer(a);
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => {
    const ad = srv.address();
    resolve(typeof ad === 'object' && ad ? ad.port : 0);
  }));
}

describe('POST /goals model containment', () => {
  it('400s an unknown model', async () => {
    const port = await app();
    const res = await fetch(`http://127.0.0.1:${port}/api/goals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'm1', cwd, model: 'evil; rm -rf /' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/model/i);
  });

  it('201s a known model', async () => {
    const port = await app();
    const res = await fetch(`http://127.0.0.1:${port}/api/goals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'm2', cwd, model: 'claude-opus-4-8' }),
    });
    expect(res.status).toBe(201);
  });
});
```

Run: `npm test -- tests/server/security/model-allow.test.ts tests/server/routes/goals-model.test.ts` → **GREEN**.

### Step 7.4 — Verify & commit

```
npm test -- tests/server/security/model-allow.test.ts tests/server/routes/goals-model.test.ts
npm run typecheck
git add server/security/model-allow.ts server/routes/goals.ts server/index.ts tests/server/security/model-allow.test.ts tests/server/routes/goals-model.test.ts
git commit
```

```
feat(security): validate goal model against Phase 0A resolveModel before --model argv

Unknown / attacker-controlled model strings are rejected at goal-create time so
they never reach pty.spawn's --model argument.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## Task 8 — Full-suite green + docs/env example + roadmap checkbox

**Goal:** Confirm the whole suite is green against the Phase 0 baseline, document the new env vars, and tick the roadmap.

**Files:**
- Modify: `.env.example` if present, else create it; document `CLAUDE_DECK_BIND`, `CLAUDE_DECK_TOKEN`, `CLAUDE_DECK_ALLOWED_ROOTS`.
- Modify: `docs/superpowers/plans/2026-06-09-master-roadmap.md` — check the "Phase 0B plan" box in §4 and note completion.

### Step 8.1 — Document env vars

Create/append `.env.example` (root):

```
# Bind host. Default 127.0.0.1 (loopback only). Set to 0.0.0.0 to expose on LAN.
# Exposing beyond loopback REQUIRES CLAUDE_DECK_TOKEN (the server refuses to start otherwise).
CLAUDE_DECK_BIND=127.0.0.1

# Shared bearer token gating /api and the WS upgrade.
# Leave unset for frictionless loopback-only dev. REQUIRED when CLAUDE_DECK_BIND is non-loopback.
# CLAUDE_DECK_TOKEN=change-me-to-a-long-random-secret

# Semicolon- or comma-separated absolute roots a goal cwd must live within.
# Defaults to the directory the server runs in (the owner's repo).
# Phase 5A's Project Registry will supersede this.
# CLAUDE_DECK_ALLOWED_ROOTS=C:\github\claude-deck;C:\github\other-repo
```

### Step 8.2 — Full suite + typecheck

```
npm test
npm run typecheck
```

Expected: **0 new failures** vs the Phase 0 green baseline. The auth/WS/cwd/model/skill-content suites pass; pre-existing tests that build apps/routers without the `auth`/`security` args stay green because every new gate is a no-op when its config is absent.

### Step 8.3 — Roadmap checkbox + commit

In `docs/superpowers/plans/2026-06-09-master-roadmap.md` §4, tick:

```
- [x] Phase 0B plan — localhost bind + shared-secret auth + cwd/path containment (small) — IMPLEMENTED 2026-06-09
```

Commit:

```
git add .env.example docs/superpowers/plans/2026-06-09-master-roadmap.md
git commit
```

```
docs(security): document Phase 0B env vars; tick roadmap

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## Self-Review (by plan author)

**Coverage of the brief (all 5 scope items + the gate rule):**
1. **Bind 127.0.0.1 by default; LAN via `CLAUDE_DECK_BIND`** → Task 0 (parse) + Task 1 (`server.listen(port, host)`). ✔
2. **Shared-secret auth on `/api` + WS upgrade, with the fail-closed rule, plus client passthrough** → Task 0 (fail-closed in `loadEnv`), Task 2 (`/api` middleware), Task 3 (`verifyClient` + Origin), Task 4 (hook client, MCP client, PtyManager MCP env). The loopback+no-token=allow / non-loopback+no-token=refuse-to-start rule is enforced in `loadEnv` (start-time) and the middleware/`verifyClient` (request-time). ✔
3. **cwd containment via `CLAUDE_DECK_ALLOWED_ROOTS`, Phase 5A handoff** → Task 5; resolver is factory-isolated (`createCwdValidator`) so `ProjectService.isPathAllowed()` swaps the source without touching call sites; handoff noted in code + plan. ✔
4. **skill-content path containment via resolve + prefix-within-roots** → Task 6 (`pathWithinRoots`), replacing the substring `'..'` test; 403 on real out-of-root `.md`. ✔
5. **Model arg constrained via Phase 0A `resolveModel`** → Task 7, validated at goal-create before `--model` argv, with an explicit missing-contract fallback if 0A hasn't merged. ✔

**Zero-friction preserved:** Every gate is a no-op when its config is absent — `token === null` ⇒ middleware and `verifyClient` pass; `allowedOrigins === []` ⇒ any origin; routers built without `security`/`auth`/`skillRoots` args behave as before. So existing tests (`app.test.ts`, `ws.test.ts`, `routes/system.test.ts`, `routes/goals.test.ts`) stay green and local dev needs no token. The gate only bites on a non-loopback bind (fail-closed start) or when a token is explicitly set.

**TDD discipline:** Every task is RED→GREEN with a named failing test first, exact file paths, real code (no placeholders), and one commit per task ending with the `Co-Authored-By` trailer. Tests live under `tests/server/**` (node env per `vite.config.ts`).

**Known limitations / called out inline:**
- WS Origin allow-list is the static loopback set; a LAN bind needs its `http://<lan-ip>:5173` origin added (one-liner, noted in Task 3 design note). Token is the primary LAN gate; Origin is CSRF defense-in-depth.
- `/api/health` is intentionally token-exempt for container liveness; documented in Task 2.
- The MCP client's base-URL wiring (`CLAUDE_DECK_URL`) is unchanged; only the token (the security-relevant bit) is added (Task 4 note).
- `model-allow` depends on Phase 0A; the fallback `KNOWN_MODELS` set keeps 0B unblocked if 0A is late.

**Migrations:** none — all new configuration is environment-driven; no DB schema change.
