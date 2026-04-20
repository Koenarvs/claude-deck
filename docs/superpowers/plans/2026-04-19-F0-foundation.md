# F0 — Foundation Implementation Plan

> **For agentic workers:** Use `superpowers:test-driven-development` within each task. Write the failing test first, verify it fails, implement the minimal code to pass, verify green, commit. Checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay down the project scaffold, shared type contracts, database schema, and server/client skeletons that every Phase 2 burst agent depends on.

**Architecture:** Single npm package at the repo root. Express server + Vite-served React client. `src/shared/*` contains all cross-cutting types and validators. SQLite via `better-sqlite3`. WebSocket via `ws`.

**Tech Stack:** Node ≥22, TypeScript (strict), Express 5, better-sqlite3, ws, zod, pino, React 19, Vite 6, Tailwind CSS v4, React Router v7, Zustand, vitest.

**Spec reference:** `docs/superpowers/specs/2026-04-19-claude-deck-v1-design.md`
- §2 architecture, §3 data model, §5 HTTP, §6 WS, §10 frontend, §14.1 F0 scope.

**Gate:** Merge to `main` before dispatching any Phase 2 burst agent.

---

## How to read this plan

Each task lists **files**, **intent**, and **checkpoints**. The spec contains the authoritative type definitions, schemas, and SQL — **do not duplicate them here**; reference them and implement from spec. Write tests first. Commit per task.

---

## Task 1: Scaffold package.json and repo config

**Files:**
- Create: `package.json` (deps listed below)
- Create: `.gitignore`, `.env.example`, `.nvmrc` (`22`), `.prettierrc.json`
- Create: `README.md` (short — points to spec)

**Dependencies to include in `package.json`:**

Runtime: `better-sqlite3@^12`, `cors@^2.8.5`, `express@^5`, `pino@^10`, `react@^19`, `react-dom@^19`, `react-router@^7`, `react-window@^2`, `recharts@^2`, `lucide-react@^0.474`, `node-cron@^4`, `uuid@^11`, `ws@^8`, `zod@^3.23`, `zustand@^5`.

Dev: `@tailwindcss/vite@^4`, `@testing-library/jest-dom@^6`, `@testing-library/react@^16`, `@testing-library/user-event@^14`, `@types/*` for all runtime deps that need them, `@vitejs/plugin-react@^4`, `concurrently@^9`, `jsdom@^27`, `pino-pretty@^13`, `prettier@^3`, `tailwindcss@^4`, `tsx@^4`, `typescript@^5.5`, `vite@^6`, `vitest@^3`.

**Scripts:**
- `dev` — concurrently runs `dev:server` (`tsx watch server/index.ts`) and `dev:client` (`vite`)
- `build` — `vite build && tsc -p tsconfig.server.json`
- `start` — `node dist/server/index.js`
- `typecheck` — runs both tsconfigs with `--noEmit`
- `test` / `test:watch` — vitest
- `format` / `format:check` — prettier

**Checkpoints:**
- [ ] `npm install` succeeds
- [ ] Commit: `feat(F0): project scaffold and dependency set`

---

## Task 2: TypeScript configs

**Files:**
- Create: `tsconfig.json` — client + shared. Strict, `noImplicitAny`, `exactOptionalPropertyTypes`, `noUnusedLocals/Parameters`, path aliases `@/*` → `src/*`, `@shared/*` → `src/shared/*`, JSX react-jsx, types include vite/client, vitest/globals, @testing-library/jest-dom. Exclude `server/`.
- Create: `tsconfig.server.json` — extends strictness. `outDir: dist/server`, `rootDir: .`, types: `node`. Include `server/`, `src/shared/`, `tests/server/`. Exclude `src/pages`, `src/components`, `src/stores`, `src/lib`.

**Checkpoints:**
- [ ] `npm run typecheck` (with no source yet) reports no config errors; "no inputs found" is acceptable.
- [ ] Commit: `feat(F0): TypeScript configs (strict, no any)`

---

## Task 3: Vite + Tailwind v4 + index.html

**Files:**
- Create: `vite.config.ts` — React plugin, Tailwind v4 plugin (`@tailwindcss/vite`), path aliases matching tsconfig, dev server on 5173, proxy `/api` → `http://localhost:4100`, proxy `/ws` → `ws://localhost:4100` with `ws: true`. Build output `dist/client`.
- Create: `index.html` — minimal React mount point. Include `<link rel="manifest" href="/manifest.webmanifest">` and `<meta name="theme-color">` (PWA scaffolding; manifest file added by burst S3).
- Create: `src/main.css` — `@import 'tailwindcss';` + `@theme { … }` block defining the dark-mode palette tokens from spec §10 (deck-bg, deck-surface, deck-border, deck-text, deck-muted, deck-accent, deck-accent-hover, deck-success, deck-warning, deck-danger).

**Checkpoints:**
- [ ] Commit: `feat(F0): Vite config, index.html, Tailwind v4 tokens`

---

## Task 4: Shared domain types

**Files:**
- Create: `src/shared/types.ts` — all types from spec §3 (Goal, Session, Message, HookEvent, Approval, ScheduledTask, PlanJson, PlanTodo, AppConfig), input shapes (CreateGoalInput, UpdateGoalInput, GoalDetail, CreateScheduledTaskInput, UpdateScheduledTaskInput), and `StreamJsonEvent` + `AssistantContentBlock` discriminated unions from spec §7.3 (include `thinking` block variant).
- Create: `tests/shared/types.test.ts` — compile-time assertions using `expectTypeOf`. Verify GoalStatus union, Goal shape, StreamJsonEvent narrows on `type`, AssistantContentBlock includes `thinking` variant.

**Checkpoints:**
- [ ] Test suite passes
- [ ] `npm run typecheck` clean
- [ ] Commit: `feat(F0): shared domain types`

---

## Task 5: Shared zod schemas

**Files:**
- Create: `src/shared/schemas.ts` — zod schemas mirroring every type from Task 4. Use `z.discriminatedUnion` for `StreamJsonEvent`, `AssistantContentBlock`, `ServerEvent`, `ClientMessage`. Re-export all input-shape schemas.
- Create: `tests/shared/schemas.test.ts` — round-trip tests: valid fixture parses; invalid status rejected; required fields enforced; discriminated union narrows by `type` discriminator.

**Test first, then schema.** Write 5+ failing tests (accept valid, reject invalid type, reject missing required, narrow by discriminator, roundtrip through a Message fixture). Run. Implement until green.

**Checkpoints:**
- [ ] All schema tests pass
- [ ] Commit: `feat(F0): shared zod schemas mirroring domain types`

---

## Task 6: Shared WebSocket event contracts

**Files:**
- Create: `src/shared/events.ts` — `ServerEventSchema` (discriminated union of all events from spec §6.1) and `ClientMessageSchema` (from §6.2). Re-export inferred types `ServerEvent`, `ClientMessage`.
- Create: `tests/shared/events.test.ts` — tests that goal:created with a valid Goal parses; unknown type rejected; subscribe accepts both array and `"all"` literal.

**Checkpoints:**
- [ ] Tests pass
- [ ] Commit: `feat(F0): shared WebSocket event contract`

---

## Task 7: SQLite migration SQL

**File:**
- Create: `server/db/migrations/001_init.sql` — exact DDL from spec §3 for all 6 tables (goals, sessions, messages, hook_events, approvals, scheduled_tasks) plus `schema_migrations` metadata table. Use CHECK constraints on enum-like columns (status, origin, role, permission_mode, approvals.status, enabled). Create indexes from spec §3 (status+kanban_order, goal_id+started_at, origin+started_at, session_id+created_at, event_type+created_at, status+requested_at). Enable WAL mode and foreign keys at top of file. Insert migration version 1 at bottom with `INSERT OR IGNORE`.

**Checkpoints:**
- [ ] File present
- [ ] Commit: `feat(F0): initial SQLite schema`

---

## Task 8: DB connection + migration runner

**Files:**
- Create: `server/db/connection.ts` — `getDb(dataDir: string): Database.Database` lazy singleton. Creates `dataDir` if missing (recursive). Opens `claude-deck.db` inside it. Sets `foreign_keys = ON` and `journal_mode = WAL`. `closeDb()` helper.
- Create: `server/db/migrate.ts` — `runMigrations(db)` reads every `.sql` file in `server/db/migrations/` in lexical order and executes each file contents against the database using `better-sqlite3`'s multi-statement execution API (see library docs for the correct method on Database — it is a single method call per file). Idempotent — the schema_migrations table + CREATE TABLE IF NOT EXISTS pattern prevents re-apply errors.
- Create: `tests/server/db/migrate.test.ts` — uses `new Database(':memory:')`. Tests: tables created (query `sqlite_master`), idempotent (run twice, version still 1), CHECK constraint rejects invalid status.

**Write tests first.** 3 failing tests, run to confirm failure, then implement `migrate.ts`.

**Checkpoints:**
- [ ] 3 tests pass
- [ ] Commit: `feat(F0): DB connection and migration runner`

---

## Task 9: Server logger, env loader, zod middleware

**Files:**
- Create: `server/logger.ts` — pino instance. Pretty-print via `pino-pretty` when `NODE_ENV !== 'production'`. Level from `LOG_LEVEL` env.
- Create: `server/env.ts` — `loadEnv(): ServerEnv` reads `PORT` (validate 1-65535, default 4100), `DATA_DIR` (default `./data`, resolved absolute), `LOG_LEVEL`.
- Create: `server/middleware/validate.ts` — `validateBody(schema)` and `validateQuery(schema)` Express middlewares. On parse failure, respond 400 with `{ error, issues }`. On success, replace req.body / req.query with parsed data and call next.
- Create: `tests/server/middleware/validate.test.ts` — uses vitest `vi.fn()` for `next` and a mock res. Verify next called on valid; 400 returned on invalid.

**Checkpoints:**
- [ ] Middleware tests pass
- [ ] Commit: `feat(F0): server logger, env loader, zod middleware`

---

## Task 10: WebSocket hub

**Files:**
- Create: `server/ws.ts` — `setupWss(httpServer)` attaches a WebSocketServer at path `/ws`. Maintains a `Map<WebSocket, ClientState>` where ClientState tracks `subscribed: Set<string> | 'all'`. Handles `subscribe`, `unsubscribe`, `ping` inbound messages (validated via `ClientMessageSchema`). Exports `broadcast(event: ServerEvent)` that sends to all clients whose subscription matches. Subscription match: events with a goal_id only go to subscribers of that goal; non-goal events go to everyone.
- Create: `tests/server/ws.test.ts` — spins up a real HTTP server on an ephemeral port, connects a ws client, verifies ping roundtrip and that broadcast delivers to a subscribed client.

**Checkpoints:**
- [ ] Tests pass (2+)
- [ ] Commit: `feat(F0): WebSocket hub with subscribe/broadcast`

---

## Task 11: Express app factory + health route

**Files:**
- Create: `server/routes/health.ts` — `GET /health` returns `{ ok: true, uptime: process.uptime() }`.
- Create: `server/app.ts` — `createApp(): Express` applies CORS (localhost origins only), JSON body parser (limit 10mb), mounts `/api` routes, 404 handler, error handler that logs via pino and returns 500.
- Create: `tests/server/app.test.ts` — `GET /api/health` returns 200 + ok:true; unknown route returns 404.

**Checkpoints:**
- [ ] Tests pass
- [ ] Commit: `feat(F0): Express app factory with health route`

---

## Task 12: Server entry point

**Files:**
- Create: `server/index.ts` — loads env, opens DB, runs migrations, creates app, creates http.Server, attaches WebSocketServer, listens on env.port. Handles SIGINT/SIGTERM by closing http server, closing DB, and process-exit with 5s force-kill fallback (unref the timer).

**Checkpoints:**
- [ ] `npm run dev:server` starts without error
- [ ] `curl http://localhost:4100/api/health` returns `{"ok":true,...}`
- [ ] Ctrl-C cleanly shuts down
- [ ] Commit: `feat(F0): server entry point with graceful shutdown`

---

## Task 13: Frontend root + routing

**Files:**
- Create: `src/main.tsx` — React root, StrictMode, `RouterProvider` with `createBrowserRouter`, imports `main.css`.
- Create: `src/routes.tsx` — route table with `/` → Navigate to `/board`, and one entry per route from spec §10.1 (board, dashboard, goals/:id, sessions, sessions/:id, feed, analytics, scheduled, skills, claude-md, settings). Each path renders a page component imported from `src/pages/`.
- Create: `src/App.tsx` — root layout; calls `useWsManager()` hook, renders `<AppShell>` with `<Outlet />`.

**Checkpoints:**
- [ ] Commit: `feat(F0): React root and route table`

---

## Task 14: App shell + sidebar

**Files:**
- Create: `src/components/Sidebar.tsx` — fixed-width left nav with NavLink items using lucide-react icons (Kanban, LayoutDashboard, List, Activity, BarChart3, Clock, Sparkles, FileText, Settings). Active route gets accent background.
- Create: `src/components/AppShell.tsx` — flex layout: Sidebar on left, scrollable main area renders children.

**Checkpoints:**
- [ ] Commit: `feat(F0): app shell and sidebar navigation`

---

## Task 15: Page stubs

**Files:** 11 placeholder page components under `src/pages/` (one per route — KanbanPage, DashboardPage, GoalDetailPage, SessionsListPage, SessionDetailPage, FeedPage, AnalyticsPage, ScheduledPage, SkillsPage, ClaudeMdPage, SettingsPage).

Each stub: exports a named function that renders an h1 with the page name and a placeholder paragraph stating which burst owns it (e.g., "Implementation in burst F1"). Burst agents replace these stubs with real implementations.

**Checkpoints:**
- [ ] All 11 pages render
- [ ] Commit: `feat(F0): page stubs for all routes`

---

## Task 16: Zustand store scaffolds

**Files** (one per store, all under `src/stores/`):
- `useGoalsStore.ts` — state `{ goals: Goal[] }`, actions `setGoals`, `upsertGoal`, `removeGoal`, selector `goalsByStatus(status)` returning goals sorted by `kanban_order`.
- `useSessionsStore.ts` — `{ sessions: Session[] }`, `setSessions`, `upsertSession`.
- `useMessagesStore.ts` — `{ byGoalId: Record<string, Message[]>, bySessionId: Record<string, Message[]> }`, `addMessage(goalId, sessionId, message)`, `setMessagesForSession`.
- `usePlanStore.ts` — `{ byGoalId: Record<string, PlanJson> }`, `setPlan`.
- `useApprovalsStore.ts` — `{ pending: Approval[], resolved: Approval[] }`, `addPending`, `markResolved(id, decision)` (moves pending → resolved, caps resolved at 100).
- `useFeedStore.ts` — `{ events: HookEvent[] }`, `addEvent` (prepends, caps at 500), `setEvents`.
- `useConfigStore.ts` — `{ config: AppConfig | null }`, `setConfig`.
- `useConnectionStore.ts` — `{ status: 'connecting' | 'open' | 'closed' | 'error' }`, `setStatus`.

All stores use Zustand's `create<State>()`. Export a hook per store.

**Checkpoints:**
- [ ] Commit: `feat(F0): Zustand store scaffolds for all domains`

---

## Task 17: WebSocket manager hook

**File:**
- Create: `src/lib/ws-manager.ts` — module-level singleton `ws: WebSocket | null`. `connect()` opens `ws://${location.host}/ws` (or wss for https). On open: sets connection status to 'open', subscribes to 'all'. On message: JSON.parse, validate with `ServerEventSchema`, dispatch to the correct store based on `event.type`. On close: exponential backoff reconnect starting at 1s, cap 30s. `useWsManager()` React hook triggers connect on first mount; does NOT close on unmount (singleton lives for the session).

**Dispatch map** (event.type → store action):
- `goal:created | goal:updated` → `useGoalsStore.upsertGoal`
- `goal:status` → merge status + current_session_id into the existing goal via upsertGoal
- `goal:plan-updated` → `usePlanStore.setPlan`
- `message:added` → `useMessagesStore.addMessage`
- `approval:pending` → `useApprovalsStore.addPending`
- `approval:resolved` → `useApprovalsStore.markResolved`
- `session:observed` → `useSessionsStore.upsertSession`
- `hook:event` → `useFeedStore.addEvent`
- `session:ended | subprocess:error | ping` → no-op for now (F2/F3/S4 consume)

**Checkpoints:**
- [ ] Commit: `feat(F0): WebSocket manager singleton with reconnect`

---

## Task 18: Full-stack smoke test

**No new files.** Verification only.

- [ ] `npm run typecheck` → 0 errors
- [ ] `npm test` → all F0 tests green (shared types, schemas, events, db migrate, middleware, ws, app)
- [ ] `npm run build` → `dist/client/` and `dist/server/` produced
- [ ] `npm run dev` → concurrently starts client (5173) and server (4100)
- [ ] Browser `http://localhost:5173`:
  - Sidebar renders with all nav items
  - `/` redirects to `/board`
  - Every route renders its page stub
  - DevTools Network: WS upgrade to `/ws` succeeds
  - DevTools Console: no React errors, no zod validation errors
- [ ] Ctrl-C shuts both servers cleanly

Tag the last commit:

```bash
git tag -a F0-complete -m "F0 foundation complete; Phase 2 bursts may begin"
```

---

## F0 Completion Criteria

All boxes above checked, plus:

- [ ] All burst-agent plans reference `src/shared/types.ts`, `src/shared/schemas.ts`, `src/shared/events.ts`, `server/db/migrations/001_init.sql` — these are now stable.
- [ ] No `any` types anywhere in code (lint-grep the codebase before tagging complete).
- [ ] Every new public server function has a JSDoc line.

After merge to `main`, signal orchestrator: **"F0 merged; Phase 2 bursts may begin."**
