# Settings Persistence — Wire the Existing ConfigService

**Date:** 2026-06-08
**Status:** Approved design — pending implementation plan
**Branch context:** `feat/multi-agent-foundation`

## Problem

The Settings tab does not persist. Every setting except Global Hooks resets on
reload because the backend never saves anything:

- `GET /api/config` (`server/routes/system.ts:131`) returns a hardcoded blob.
- `PUT /api/config` (`server/routes/system.ts:144`) echoes the request body back
  with `updated: true` and logs it — it does not write to any store. A code
  comment calls persistence "a v1.1 feature."

Secondary issues:

- The Settings page has no scroll container, so content can overflow the
  viewport with no scrollbar (every other page wraps content in
  `flex-1 overflow-y-auto`).
- The GET stub returns `traceRetentionDays`, but the real schema and frontend
  use `tracePruneDays`. The two never matched.

## Key finding — most of the foundation already exists

A sibling branch, **`feat/multi-agent-impl`** (checked out in the
`multi-agent-impl` worktree), has already built the persistence layer — just not
wired it to the API:

- **`server/db/migrations/015_app_config.sql`** — single-row `app_config` table
  (`id=1` CHECK, `config_json` TEXT, `updated_at` INTEGER).
- **`server/services/config-service.ts`** — `createConfigService(db)` returning
  `getPersisted()` / `updatePersisted(partial)`. Zod-validated against
  `PersistedConfigSchema`, with corrupt-row fallback to defaults and a
  `normalizeProviders()` invariant that always includes `'claude'`.
- **`tests/server/services/config-service.test.ts`** — covers the service.
- **`PersistedConfigSchema`** in `src/shared/schemas.ts` — fields: `homeRoute`,
  `tracePruneDays`, `defaultModel`, `defaultPermissionMode`, `enabledProviders`.

This work is **not yet on `feat/multi-agent-foundation`**. The orchestrator, by
contrast, keeps its settings in a **separate** `orchestrator_state` table — so
the established convention in this codebase is *per-subsystem single-row
JSON-blob tables*, not one shared key-value registry.

### Consequences for this design

1. **Do not build a new table, service, or setting registry.** Adopt
   `app_config` + `ConfigService` as canonical. The earlier key-value /
   registry idea is dropped — it would be a third pattern nobody else uses.
2. **The multi-LLM seam already exists** as `enabledProviders: string[]` inside
   `PersistedConfigSchema`. No API keys (the app uses monthly account access),
   so nothing secret is stored and there is no encryption requirement.
3. **`homeRoute` stays server-side** in `app_config` (decision: keep single
   source of truth; no localStorage split).
4. **The field-name mismatch fixes itself** once GET returns
   `getPersisted()`, whose shape is `tracePruneDays`.

## Scope

**In scope** — wiring and UI only:
- Instantiate `ConfigService` on the server and inject it into the system
  router.
- Replace the no-op `GET`/`PUT /api/config` handlers with real
  `getPersisted()` / `updatePersisted()` calls, including validation and error
  handling.
- Add the vertical scrollbar to the Settings page.
- Confirm the frontend reads/writes the `PersistedConfig` shape end to end.

**Prerequisite (coordination, not code):** the `app_config` migration,
`config-service.ts`, its test, and `PersistedConfigSchema` must be present on
the working branch. They arrive by merging/rebasing `feat/multi-agent-impl`
(or whichever branch lands it first) before — or together with — this wiring.
This spec assumes those artifacts are present and does not re-create them.

**Out of scope:**
- New settings storage mechanisms (table, service, registry) — already exist.
- Provider/model lists for multi-LLM — `enabledProviders` is the seam; the list
  is owned by the multi-LLM agent.
- Orchestrator settings — live in `orchestrator_state`, a separate subsystem.
- Theme / markdown-editor preferences.
- Any secret/credential storage.

## Design

### Server wiring

`ConfigService` is a `createConfigService(db)` factory. The system router is
created by `createSystemRouter(skillDirService?)` and already injects services as
constructor params (the `skillDirService` precedent) while reading the database
from `req.app.locals.db`.

- **Instantiate** the config service where the DB and other services are wired
  (the same place `createSystemRouter` is called), and **inject** it — extend
  `createSystemRouter` to accept a `configService` param, mirroring
  `skillDirService`.
- **`GET /api/config`** → `res.json(configService.getPersisted())`. This returns
  the persisted config merged over defaults. It intentionally does **not**
  include runtime fields (`dataDir`, `hooksInstalled`) — those are served by
  their own endpoints today and the GET stub never returned them either, so the
  contract is unchanged.
- **`PUT /api/config`** → `res.json(configService.updatePersisted(req.body))`
  inside a `try/catch`. `updatePersisted` validates via `PersistedConfigSchema`
  and throws (Zod) on invalid input.

### Validation & error handling

- Invalid `PUT` body → catch the Zod error and return `400` with a message
  identifying the problem (e.g. out-of-range `tracePruneDays`, bad
  `defaultPermissionMode` enum). Nothing is written.
- Corrupt/invalid stored row → already handled by `getPersisted()` (logs a
  warning, returns defaults, never throws).
- `'claude'` is always force-enabled in `enabledProviders` via the service's
  `normalizeProviders()` — preserved automatically.

### Frontend

- `SettingsPage` continues to call `GET`/`PUT /api/config`; no shape change is
  needed because it already uses `tracePruneDays`. Verify each control round-
  trips against the persisted value (model, permission mode, trace prune days,
  home route).
- `useConfigStore` remains an in-memory cache; it is now backed by real
  persistence on the server, so values survive reload.
- Pass through `enabledProviders` untouched (the multi-LLM agent owns its UI).
- **Scrollbar:** wrap the `SettingsPage` content in
  `flex-1 overflow-y-auto px-6 py-4`, matching `AnalyticsPage` / `SkillsPage`.

## Testing (TDD)

The service itself is already covered by `config-service.test.ts`. New tests
target the wiring and UI:

1. **`GET /api/config` on an empty table** returns the documented defaults
   (`homeRoute: '/board'`, `tracePruneDays: 90`, `defaultModel: 'default'`,
   `defaultPermissionMode: 'supervised'`, `enabledProviders: ['claude']`).
2. **`PUT` then `GET` round-trip** returns the updated values — proving the
   route actually persists (the regression the feature exists to fix).
3. **Invalid `PUT`** (e.g. `tracePruneDays: 0` or `400`, bad permission-mode
   enum) returns `400` and writes nothing.
4. **`enabledProviders` invariant:** a `PUT` omitting or clearing providers
   still returns a config containing `'claude'`.
5. **Field-name guard:** a `PUT` carrying `tracePruneDays` is read back
   identically (guards against the `traceRetentionDays` mismatch returning).

## Affected files

- `server/routes/system.ts` — replace `GET`/`PUT /api/config` handlers; add
  `configService` param to `createSystemRouter`.
- `server/index.ts` (or wherever `createSystemRouter` is called) — instantiate
  and inject `ConfigService`.
- `src/pages/SettingsPage.tsx` — add the scroll wrapper; verify round-trips.
- Route/integration tests for `/api/config`.
- **Already exist (prerequisite, not modified here):**
  `server/db/migrations/015_app_config.sql`,
  `server/services/config-service.ts`,
  `tests/server/services/config-service.test.ts`,
  `PersistedConfigSchema` in `src/shared/schemas.ts`.

## Open coordination item (non-blocking)

Sequencing with `feat/multi-agent-impl`: the wiring depends on that branch's
`app_config`/`ConfigService` artifacts being on the working branch first. This
is a human merge/rebase decision outside this implementation.
