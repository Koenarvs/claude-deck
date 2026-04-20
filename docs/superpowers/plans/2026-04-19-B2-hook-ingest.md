# B2 — Hook Ingest + Approval Coordinator

**Burst:** Backend | **Depends on:** F0 merged | **Branch:** `feat/B2-hook-ingest`

## Goal
Implement the HTTP hook endpoints that receive events from any running `claude` CLI, coordinate blocking approvals on `PreToolUse`, and produce the `hooks/client.js` script that installed hooks execute.

## Spec references
- §5 HTTP hook endpoints
- §5.1 hook request/response contract
- §8 hook layer (what's installed, script behavior, approval coordinator)
- §14.2 B2 scope line

## Scope (files owned)
- Create: `server/routes/hooks.ts` — all `/api/hook/*` endpoints
- Create: `server/approval-coordinator.ts` — the in-memory promise registry from spec §8.3
- Create: `server/hook-ingest.ts` — service that persists hook events and extracts plan updates from `TodoWrite`
- Create: `hooks/client.js` — the Node script invoked by CLI hooks (plain JS, no TS, zero npm deps, uses stdlib only)
- Create: `tests/server/routes/hooks.test.ts` — integration tests
- Create: `tests/server/approval-coordinator.test.ts` — unit tests

## Contracts consumed (from F0)
- `src/shared/types.ts`: `HookEvent`, `Approval`, `PlanJson`, `HookEventType`
- `server/ws.ts`: `broadcast`
- `server/db/connection.ts`: `getDb`

## Contracts produced (consumed by B3, B4, B5, S4)
- `approvalCoordinator` singleton with:
  - `request(approval): Promise<{ decision, reason? }>` — called by hook ingest on `PreToolUse`
  - `resolve(approvalId, decision, reason)` — called by UI via `/api/approvals/:id/decide`
- `hookIngest.onPreToolUse(payload) → Promise<Decision>`
- `hookIngest.onPostToolUse(payload) → void` (extracts TodoWrite → updates plan)
- `hookIngest.onSessionStart(payload)` — creates a `sessions` row if not exists
- `hookIngest.onUserPromptSubmit(payload)` — logs
- `hookIngest.onStop(payload)` — marks session ended

## Recommended task order
1. TDD `approval-coordinator.ts`: in-memory `Map<id, Deferred>`. `request()` inserts row, broadcasts, returns promise that resolves via `resolve(id, decision)` or auto-denies on timeout. Test autonomous bypass, timeout, duplicate resolution.
2. TDD `hook-ingest.ts` service: each `on*` method inserts a `hook_events` row and fires the appropriate follow-up (plan update, session upsert, broadcast). `onPreToolUse` calls `approvalCoordinator.request` and returns its decision.
3. TDD `routes/hooks.ts`: each endpoint validates body with zod, calls the ingest service, returns the decision (for pre-tool-use) or 200 (others). Endpoints fail open on server errors inside the handler (return 200 with `{ decision: "allow" }` for pre-tool-use) — but this is a server-side concern; the CLIENT script also fails open on network errors.
4. Write `hooks/client.js` per spec §8.2 pseudocode. Plain JS, no deps. Use `http` stdlib. stdin payload → POST to server → on pre-tool-use read decision, on deny exit 2 with stderr, on allow exit 0, on error exit 0 (fail open).
5. Make script executable (add test that it's a valid JS file that can be executed with `node hooks/client.js pre-tool-use` and produce correct exit codes).

## Approval flow (detailed)
From spec §8.3:
- `request(approval)` inserts `approvals` row with status=pending, broadcasts `approval:pending`, creates Deferred<Decision>, sets timeout (configurable via `AppConfig.approvalTimeoutMinutes`, default 30m), returns promise.
- On autonomous goal: immediately resolve with allow, skip broadcast wait. (Goal's permission_mode is read via goalService — dependency on B3; for B2 stub with a local `getGoalPermissionMode` that reads directly from DB until B3 exists.)
- `resolve(id, decision, reason)` cancels timeout, updates row status, broadcasts `approval:resolved`, resolves deferred.
- Timeout: updates row to status=timeout, broadcasts resolved, resolves with deny/"timeout".

## Plan extraction from TodoWrite
In `onPostToolUse`, if `tool_name === 'TodoWrite'`:
- Parse `tool_input.todos` (shape: `Array<{id, content, status}>`)
- Build `PlanJson { todos, updated_at: Date.now() }`
- If a goal is linked to this session (via `sessions.goal_id`), update the goal's `plan_json` column AND broadcast `goal:plan-updated` with the plan.

## Hook script (hooks/client.js) requirements
- No npm deps (stdlib only)
- Read stdin fully, parse as JSON
- Determine endpoint from `process.argv[2]` (e.g., `pre-tool-use` → `/api/hook/pre-tool-use`)
- POST to `http://127.0.0.1:4100/api/hook/<endpoint>` with a 30m timeout for pre-tool-use, 15s for others
- On non-pre-tool-use: exit 0 immediately after POST
- On pre-tool-use: read response JSON, if `decision === "deny"` print reason to stderr and exit 2, else exit 0
- On any error (unreachable, timeout, malformed response): stderr a warning, exit 0 (fail open)

## Acceptance criteria (spec §13 + §14.2 B2)
- [ ] `POST /api/hook/pre-tool-use` blocks until `approvalCoordinator.resolve` is called; decision JSON returned
- [ ] Autonomous-mode goal causes immediate auto-allow without UI broadcast wait
- [ ] Timeout (shortened to 100ms for tests) causes auto-deny and row status=timeout
- [ ] Server down: hook script exits 0, prints warning to stderr (integration-test by pointing script at a dead port)
- [ ] `onPostToolUse` with a `TodoWrite` tool call updates the linked goal's plan_json and broadcasts `goal:plan-updated`
- [ ] All hook endpoints persist to `hook_events` table
- [ ] `onSessionStart` creates a `sessions` row with origin=`external` if no dashboard runner claimed it

## QA Checklist
- [ ] **QA-1:** Pre-tool-use with supervised goal blocks; UI resolve returns within 100ms of decision; row status=approved
- [ ] **QA-2:** Pre-tool-use with autonomous goal returns allow within 50ms without broadcast
- [ ] **QA-3:** Pre-tool-use timeout (test-configured 100ms) auto-denies; row status=timeout
- [ ] **QA-4:** `hooks/client.js` with target port unreachable prints to stderr and exits 0 within 1s
- [ ] **QA-5:** `hooks/client.js` receives deny response and exits 2 with reason in stderr
- [ ] **QA-6:** `onPostToolUse` with a TodoWrite call updates goal.plan_json (verify via DB query) and triggers broadcast
- [ ] **QA-7:** 100 concurrent pre-tool-use calls resolve correctly without race conditions (stress test)
- [ ] **QA-8:** No `any` types in B2 files

## Quality bar
- No `any`, JSDoc on public, zod on boundaries, tests for each flow
- `hooks/client.js` passes `node --check` (syntax valid) and manual exec test
