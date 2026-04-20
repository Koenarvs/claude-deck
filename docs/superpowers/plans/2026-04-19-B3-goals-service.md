# B3 — Goals Service

**Burst:** Backend | **Depends on:** F0 merged | **Branch:** `feat/B3-goals-service`

## Goal
Implement goals CRUD, state machine transitions, kanban ordering, tag filtering, and the plan_json write API.

## Spec references
- §3.1 goals table
- §5 HTTP goals endpoints
- §6 goal-related WS events
- §14.2 B3

## Scope (files owned)
- Create: `server/routes/goals.ts` — REST endpoints for `/api/goals/*`
- Create: `server/services/goal-service.ts` — data access + business logic
- Create: `server/state-machine/goal-status.ts` — allowed transitions helper
- Create: `tests/server/services/goal-service.test.ts`
- Create: `tests/server/routes/goals.test.ts`

## Contracts consumed
- `src/shared/types.ts`: `Goal`, `GoalStatus`, `CreateGoalInput`, `UpdateGoalInput`, `GoalDetail`, `PlanJson`
- `src/shared/schemas.ts`: `CreateGoalInputSchema`, `UpdateGoalInputSchema`, `GoalSchema`
- `server/ws.ts`: `broadcast`
- `server/db/connection.ts`: `getDb`
- `server/middleware/validate.ts`: `validateBody`, `validateQuery`

## Contracts produced
- `goalService` with:
  - `create(input: CreateGoalInput): Promise<Goal>` — inserts row, broadcasts `goal:created`
  - `get(id): Goal | null`
  - `getDetail(id): GoalDetail | null` — goal + messages + plan (may require joining with B4's messages)
  - `list(filters): Goal[]`
  - `update(id, patch: UpdateGoalInput): Goal`
  - `archive(id): void` — sets status=archived
  - `setCurrentSession(id, sessionId | null): void`
  - `setPlan(id, plan: PlanJson): void` — called by B2 on TodoWrite; broadcasts `goal:plan-updated`
  - `interrupt(id): void` — calls `processRegistry.get(id)?.interrupt()` (from B1)
  - `sendMessage(id, prompt, modelOverride?): { session_id }` — spawns new SessionRunner OR calls sendFollowup on existing (orchestrates B1)
  - `adoptSession(goalId, sessionId): Goal` — links an external session to a goal

## Recommended task order
1. TDD `state-machine/goal-status.ts`: `canTransition(from, to): boolean`. Allowed: planning→active, active→waiting, waiting→active, any→complete, any→archived (except from archived). Block illegal transitions.
2. TDD `goal-service.ts` in-memory (use `:memory:` DB in tests): create/get/list/update/archive + state transitions.
3. TDD plan_json handling: `setPlan` updates plan_json column, broadcasts `goal:plan-updated`.
4. TDD kanban_order: `update` with new kanban_order just sets the value; no renumbering needed (float insertion).
5. TDD `adoptSession`: sessions row's `goal_id` updated.
6. Integrate with B1: `sendMessage` uses `processRegistry` (import from server/process-registry.ts) and SessionRunner.
7. Build `routes/goals.ts` — wire each endpoint to a service method; zod-validate inputs.

## State machine diagram
```
planning ──[sendMessage]──▶ active
   └──────[archive]────────▶ archived
active   ──[wait/done]────▶ waiting|complete
waiting  ──[sendMessage]──▶ active
complete ──[reopen]──────▶ active
any (except archived) ───▶ archived
```

## Acceptance criteria (spec §13 + §14.2 B3)
- [ ] `POST /api/goals` creates a goal, returns it, broadcasts `goal:created`, and (if `initialPrompt` provided) spawns a SessionRunner
- [ ] `GET /api/goals` returns all goals; filters by `status` and `tag` work
- [ ] `PATCH /api/goals/:id` with invalid state transition returns 400
- [ ] `PATCH /api/goals/:id` with kanban_order=2.5 inserts between existing 2 and 3 without renumbering
- [ ] `DELETE /api/goals/:id` soft-deletes (status=archived)
- [ ] `setPlan` broadcasts `goal:plan-updated` with the plan
- [ ] `interrupt` kills the registered runner; goal status → `waiting`
- [ ] `sendMessage` on a goal without an active runner spawns a new one; on a goal with an active runner pipes the prompt to it

## QA Checklist
- [ ] **QA-1:** Create goal with initial prompt → goal row exists, session row exists (origin=dashboard), `goal:created` broadcast, SessionRunner registered
- [ ] **QA-2:** Invalid status transition (e.g., archived → active) returns 400
- [ ] **QA-3:** Kanban drag: PATCH with kanban_order 2.5 places goal between others; list returns them in correct order
- [ ] **QA-4:** setPlan updates DB; WS event emitted contains full plan_json
- [ ] **QA-5:** Interrupt kills subprocess (registry check); goal status=waiting
- [ ] **QA-6:** Adopt external session: sessions.goal_id now points to goal; future messages from that session counted under the goal
- [ ] **QA-7:** All endpoint inputs zod-validated; invalid bodies return 400
- [ ] **QA-8:** No `any` types

## Quality bar
- No `any`, JSDoc on service methods, zod on all routes, 100% of endpoints have integration tests
