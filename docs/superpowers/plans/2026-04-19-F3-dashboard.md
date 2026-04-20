# F3 — Dashboard Page

**Burst:** Frontend | **Depends on:** F0 merged | **Branch:** `feat/F3-dashboard`

## Goal
Alternative home at `/dashboard`: stat cards, active-goals strip, recent activity feed preview. Opt-in via config setting `homeRoute: '/dashboard'`.

## Spec references
- §10.1 routes, §10 frontend structure, §14.3 F3

## Scope
- Replace stub: `src/pages/DashboardPage.tsx`
- Create: `src/components/dashboard/StatCards.tsx` — 4 tiles (active goals, approvals pending, tokens today, sessions today)
- Create: `src/components/dashboard/ActiveGoalsStrip.tsx` — horizontal scroll of active goal cards
- Create: `src/components/dashboard/RecentActivityFeed.tsx` — last 20 hook events (reuse feed event row component from F5 if merged first; otherwise stub a minimal row)
- Create: `src/components/dashboard/QuickActions.tsx` — buttons: New Goal, Install Hooks link, Open Board
- Create: `tests/client/dashboard.test.tsx`

## Contracts consumed
- `src/stores/useGoalsStore`, `useApprovalsStore`, `useFeedStore`, `useSessionsStore`
- Backend endpoints (for initial load): GET `/api/goals?status=active`, GET `/api/approvals?status=pending`, GET `/api/sessions?active=true`
- Analytics endpoint (used by stat cards): GET `/api/analytics/tokens?from=<today_start>&to=<now>&groupBy=day` — returns today's total tokens

## Recommended task order
1. TDD `StatCards`: props `{ activeGoals, pendingApprovals, tokensToday, sessionsToday }`; renders 4 tiles with icons + delta indicators (vs yesterday, optional for v1).
2. TDD `ActiveGoalsStrip`: subscribes to `goalsByStatus('active')`; renders horizontal-scroll list; each card shows title, last activity, model.
3. TDD `RecentActivityFeed`: subscribes to `useFeedStore.events.slice(0,20)`; renders compact rows (timestamp, session short-id, event type, tool name).
4. TDD `QuickActions`: renders 3 buttons; New Goal opens modal (reuse F1's `NewGoalModal` if merged first; otherwise navigate to `/board`).
5. `DashboardPage`: fetches initial data in parallel, renders the 4 components in a grid.

## Acceptance criteria (spec §14.3 F3)
- [ ] Stat cards update live as WS events arrive (new goal created → active goals +1)
- [ ] Active goals strip shows current active goals; clicking one navigates to `/goals/:id`
- [ ] Recent activity feed shows latest 20 hook events; new events prepend live
- [ ] All four cards load within 1s on initial render

## QA Checklist
- [ ] **QA-1:** Initial load fetches 4 endpoints in parallel; all complete within 1s on empty DB
- [ ] **QA-2:** WS `goal:created` → active count increments without refetch
- [ ] **QA-3:** WS `approval:pending` → pending count increments; `approval:resolved` decrements
- [ ] **QA-4:** Recent activity shows 20 most recent events; 21st-latest is hidden
- [ ] **QA-5:** Click "New Goal" → modal opens OR routes to /board
- [ ] **QA-6:** No `any` types

## Quality bar
- No `any`, Lucide icons, accessible grid layout
