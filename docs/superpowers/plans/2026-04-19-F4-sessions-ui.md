# F4 — Sessions List + Session Detail

**Burst:** Frontend | **Depends on:** F0 merged | **Branch:** `feat/F4-sessions-ui`

## Goal
`/sessions`: sortable/filterable table of all sessions (dashboard + external). `/sessions/:id`: read-only detail view with message history and trace download.

## Spec references
- §10.1 routes, §14.3 F4

## Scope
- Replace stubs: `src/pages/SessionsListPage.tsx`, `src/pages/SessionDetailPage.tsx`
- Create: `src/components/sessions/SessionsTable.tsx` — sortable table with filter chips
- Create: `src/components/sessions/SessionFilters.tsx` — origin, active, date range filters
- Create: `src/components/sessions/SessionDetailHeader.tsx`
- Create: `src/components/sessions/TraceDownloadPanel.tsx` — buttons for stream/hooks/bundle downloads
- Reuse: `MessageStream.tsx` from F2 carry-over (for session detail read-only view)
- Create: `tests/client/sessions.test.tsx`

## Contracts consumed
- `src/shared/types.ts`: `Session`, `Message`, `SessionOrigin`
- `src/stores/useSessionsStore`, `useMessagesStore`
- Backend: GET `/api/sessions`, GET `/api/sessions/:id`, GET `/api/sessions/:id/messages`, GET `/api/sessions/:id/trace/*`

## Recommended task order
1. TDD `SessionsTable`: props `{ sessions, sortBy, filters }`; renders columns: origin (badge), session_id (truncated), cwd (truncated with tooltip), model, started_at, duration, tokens (in/out), cost. Sortable by started_at, duration, cost. Row click → `/sessions/:id`.
2. TDD `SessionFilters`: dropdown/chip for origin (all/dashboard/external), checkbox for active only, date range (today/7d/30d/all).
3. TDD `SessionsListPage`: fetches sessions on mount (GET /api/sessions with filter query params), renders filters + table. Pagination (limit=50 default, offset for scroll-bottom load-more).
4. TDD `SessionDetailHeader`: shows origin badge, session_id, goal link (if goal_id not null — use react-router `<Link>` to /goals/:goal_id), cwd, model, duration, cost, token counts.
5. TDD `TraceDownloadPanel`: three buttons linking to the three download endpoints. Show counts (stream_event_count, hook_event_count) from session record.
6. TDD `SessionDetailPage`: reads id from route, fetches session + messages, renders header + read-only MessageStream + TraceDownloadPanel.

## Acceptance criteria (spec §14.3 F4)
- [ ] Table with 500 rows sorts/filters client-side without server round-trip
- [ ] Click row → navigates to /sessions/:id
- [ ] Session detail shows messages; MessageStream in read-only mode (no input bar)
- [ ] Trace download buttons work — clicking streams file or opens tar bundle
- [ ] Session detail with goal_id set shows goal link that navigates to /goals/:id

## QA Checklist
- [ ] **QA-1:** Populate table with 500 sessions; sort by cost descending; table updates within 50ms
- [ ] **QA-2:** Filter origin=external; only external rows visible
- [ ] **QA-3:** Session detail for an external session shows no goal link but does show "Adopt into goal" button (links to a modal or redirect to /board with adopt intent — stretch; for v1 a button that opens a dropdown of goals and POST /api/goals/:goalId/adopt-session is acceptable)
- [ ] **QA-4:** Trace stream download: button opens a new tab to `/api/sessions/:id/trace/stream`; browser downloads the JSONL
- [ ] **QA-5:** Bundle download: tar.gz file produced; extractable
- [ ] **QA-6:** No `any` types

## Quality bar
- No `any`, Lucide icons, table accessibility (role="grid", keyboard nav)
