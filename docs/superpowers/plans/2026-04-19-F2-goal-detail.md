# F2 — Goal Detail Page + Plan Pane

**Burst:** Frontend | **Depends on:** F0 merged | **Branch:** `feat/F2-goal-detail`

## Goal
The `/goals/:id` split view: conversation on left (messages + input bar), plan pane on right (live-updating from TodoWrite). Goal header with status, model picker, interrupt, trace download.

## Spec references
- §10.1 routes, §10.4 carry-over components, §13.1 functional AC, §13.3 performance
- §14.3 F2

## Scope
- Replace stub: `src/pages/GoalDetailPage.tsx`
- Create: `src/components/goal/GoalHeader.tsx`
- Create: `src/components/goal/GoalSplitView.tsx`
- Create: `src/components/goal/GoalConversation.tsx`
- Create: `src/components/goal/GoalPlanPane.tsx`
- Create: `src/components/goal/PlanRenderer.tsx`
- Carry-over from claude-monitor (copy + adapt imports): `MessageStream.tsx`, `MessageBubble.tsx`, `InputBar.tsx`, `SubagentList.tsx`
- Create: `tests/client/goal-detail.test.tsx`

## Contracts consumed
- `src/shared/types.ts`: `Goal`, `Message`, `PlanJson`, `PlanTodo`
- `src/stores/useGoalsStore`, `useMessagesStore`, `usePlanStore`
- Backend endpoints: GET `/api/goals/:id`, POST `/api/goals/:id/messages`, POST `/api/goals/:id/interrupt`, PATCH `/api/goals/:id`

## Recommended task order
1. Copy `MessageStream.tsx`, `MessageBubble.tsx`, `InputBar.tsx`, `SubagentList.tsx` from `C:/Users/Koena/claude-monitor/src/components/` → `D:/github/claude-deck/src/components/`. Update imports to use `@/` and `@shared/` aliases. Remove any SDK-specific props.
2. TDD `PlanRenderer`: given a PlanJson, render a checklist. Todos with status=completed are visually checked. status=in_progress has a spinner. Click a todo → future enhancement stub (non-interactive for v1).
3. TDD `GoalPlanPane`: consumes `usePlanStore.byGoalId[goalId]`, renders PlanRenderer + SubagentList. Collapsible (cookie-persisted).
4. TDD `GoalHeader`: shows editable title (inline edit), status badge, cwd, model picker (dropdown: default/opus/sonnet/haiku), interrupt button (disabled if no active session), download-trace button (a link to `/api/goals/:id/trace`).
5. TDD `GoalConversation`: fetches messages via GET /api/goals/:id on mount (populates store), renders `MessageStream` (virtualized via react-window from carry-over), renders `InputBar`. Input submit → POST /api/goals/:id/messages.
6. TDD `GoalSplitView`: resizable 60/40 split (use CSS grid with draggable divider, or default to fixed 60/40 for v1; resizing is stretch).
7. TDD `GoalDetailPage`: ties it all together; reads goalId from route params, loads goal via GET, renders header + split view.

## Live updates
- `message:added` WS event (dispatched by F0's ws-manager) adds to messagesStore → MessageStream re-renders via useMessagesStore subscription
- `goal:plan-updated` WS event → usePlanStore update → GoalPlanPane re-renders
- `goal:updated` → useGoalsStore update → GoalHeader re-renders

## Acceptance criteria (spec §13.1 + §14.3 F2)
- [ ] Message bubble renders < 100ms after WS `message:added`
- [ ] Plan pane renders < 100ms after WS `goal:plan-updated`
- [ ] Interrupt button POST /api/goals/:id/interrupt; on success, goal status → waiting
- [ ] Title edit PATCH /api/goals/:id; optimistic update
- [ ] Input bar disabled when goal.status is complete or archived
- [ ] Trace download: clicking button opens `/api/goals/:id/trace` in new tab (browser handles tar download)
- [ ] Long conversations (500+ messages) scroll without frame drops (react-window virtualization)

## QA Checklist
- [ ] **QA-1:** Mount GoalDetailPage with a goal ID that has 10 messages → all render; input bar focused; send a message → POST fires, message appears optimistically
- [ ] **QA-2:** WS `message:added` for this goal → new bubble appears within 100ms
- [ ] **QA-3:** WS `goal:plan-updated` with 5 todos → plan pane shows 5 todos with correct status icons
- [ ] **QA-4:** Interrupt button on an active goal → POST fires, button disables; on next WS `goal:status=waiting`, button reflects
- [ ] **QA-5:** Model picker change → PATCH `/api/goals/:id` with `model` field
- [ ] **QA-6:** Plan pane collapse toggle persists across page reloads (localStorage)
- [ ] **QA-7:** Virtualized message list scrolls 1000 messages at ≥ 30fps
- [ ] **QA-8:** No `any` types

## Quality bar
- No `any`, carry-over components preserve their original test coverage when copied, responsive layout works at 1024px viewport
