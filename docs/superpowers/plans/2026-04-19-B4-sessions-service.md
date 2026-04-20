# B4 — Sessions + Messages Service

**Burst:** Backend | **Depends on:** F0 merged | **Branch:** `feat/B4-sessions-service`

## Goal
Implement sessions CRUD, message persistence, and external-session discovery from hook events.

## Spec references
- §3.2 sessions, §3.3 messages
- §5 sessions endpoints
- §6 `session:observed`, `session:ended`, `message:added` WS events
- §14.2 B4

## Scope
- Create: `server/routes/sessions.ts` — `/api/sessions/*`
- Create: `server/services/session-service.ts`
- Create: `server/services/message-service.ts`
- Create: `tests/server/services/session-service.test.ts`
- Create: `tests/server/services/message-service.test.ts`
- Create: `tests/server/routes/sessions.test.ts`

## Contracts consumed
- `src/shared/types.ts`: `Session`, `Message`, `SessionOrigin`, `MessageRole`
- `src/shared/schemas.ts`: `SessionSchema`, `MessageSchema`
- `server/ws.ts`: `broadcast`

## Contracts produced (consumed by B1, B2, B3, B5)
- `sessionService`:
  - `create(sessionData: Partial<Session> & {id, origin, started_at}): Session` — upsert; broadcasts `session:observed`
  - `get(id): Session | null`
  - `list(filters: {origin?, active?, limit?, offset?}): Session[]`
  - `end(id, { total_cost_usd?, total_tokens_in?, total_tokens_out? }): void` — sets ended_at; broadcasts `session:ended`
  - `updateTraceDir(id, path): void`
  - `incrementCounters(id, { stream?, hook?, stderr_bytes? }): void`
  - `linkGoal(id, goal_id): void`
- `messageService`:
  - `add(message: Message): void` — inserts; broadcasts `message:added`
  - `listBySession(sessionId, opts?): Message[]`
  - `truncateForDb(content: string): string` — enforces 4000-char cap

## Recommended task order
1. TDD `message-service.ts`: add/list/truncate; verify broadcast fires with goal_id derived from session.goal_id.
2. TDD `session-service.ts`: create + upsert idempotency (SessionStart hook re-fires don't duplicate); list filtering; `end` updates ended_at; `incrementCounters` uses atomic SQL `UPDATE ... SET x = x + ?`.
3. TDD `routes/sessions.ts`: GET list with query params, GET detail, GET messages.
4. External session discovery integration test: simulate a `session-start` hook event → verify `sessionService.create` called with origin=external, goal_id=null.

## Edge cases
- Session creation race: two rapid hook POSTs for same session_id should result in ONE sessions row. Use `INSERT OR IGNORE` or `INSERT ... ON CONFLICT DO NOTHING`.
- Message content cap: 4000 chars for `content`, 4000 for `tool_result`. If longer, truncate + append `… [truncated; see trace]`.

## Acceptance criteria (spec §13 + §14.2 B4)
- [ ] Hook `session-start` creates a row with origin=external, goal_id=NULL
- [ ] GET `/api/sessions?origin=external` returns only external sessions
- [ ] Adopt-session endpoint (B3) updates `sessions.goal_id`; future messages from that session show in the goal's detail
- [ ] `messageService.add` broadcasts `message:added` with the correct `goal_id` (derived from session lookup)
- [ ] Content > 4000 chars is truncated in DB but NOT in the trace file (trace-writer owned by B5)
- [ ] `session-end` (Stop hook) updates ended_at; `session:ended` broadcast

## QA Checklist
- [ ] **QA-1:** Session row created exactly once for two rapid session-start hooks with same ID
- [ ] **QA-2:** GET `/api/sessions/:id` returns session with full counts after incrementCounters called N times
- [ ] **QA-3:** Message with 10,000-char tool_result truncates to 4000 in DB; broadcast contains truncated version; trace file (verified by B5 later) contains full 10,000
- [ ] **QA-4:** `linkGoal` updates sessions.goal_id; subsequent `message:added` events for that session include the goal_id
- [ ] **QA-5:** List with limit/offset paginates correctly
- [ ] **QA-6:** No `any` types

## Quality bar
- No `any`, JSDoc, zod on routes, atomic SQL for counter updates
