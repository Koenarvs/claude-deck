# F5 — Feed + Analytics Pages

**Burst:** Frontend | **Depends on:** F0 merged | **Branch:** `feat/F5-feed-analytics`

## Goal
`/feed`: virtualized event log of all hook events with filters. `/analytics`: token usage, tool frequency, activity heatmap, cost summary.

## Spec references
- §10.1 routes, §13.3 perf, §14.3 F5

## Scope
- Replace stubs: `src/pages/FeedPage.tsx`, `src/pages/AnalyticsPage.tsx`
- Create: `src/components/feed/FeedFilters.tsx`
- Create: `src/components/feed/FeedList.tsx` — virtualized with react-window
- Create: `src/components/feed/FeedRow.tsx` — shared with F3 RecentActivityFeed
- Create: `src/components/analytics/TokenUsageChart.tsx` — recharts line chart
- Create: `src/components/analytics/ToolFrequencyChart.tsx` — recharts bar chart
- Create: `src/components/analytics/ActivityHeatmap.tsx` — grid heatmap (custom CSS; recharts doesn't have calendar-heatmap)
- Create: `src/components/analytics/CostSummary.tsx` — daily/per-model cards
- Create: `tests/client/feed.test.tsx`, `tests/client/analytics.test.tsx`

## Contracts consumed
- `src/shared/types.ts`: `HookEvent`, `HookEventType`
- `src/stores/useFeedStore`
- Backend: GET `/api/analytics/tokens`, `/api/analytics/tools`, `/api/analytics/heatmap`, `/api/analytics/cost`

## Recommended task order — Feed
1. TDD `FeedRow`: props `{ event }`; compact row: ts (short time), event_type (chip), tool_name, session short-id.
2. TDD `FeedList`: uses react-window `FixedSizeList`; renders 10k rows without frame drops.
3. TDD `FeedFilters`: multi-select for event_type, search-by-tool_name, session filter.
4. TDD `FeedPage`: initial load fetches last 500 events OR subscribes to store; filters applied client-side; new WS events prepend live.

## Recommended task order — Analytics
5. TDD `TokenUsageChart`: recharts LineChart with time on x-axis, tokens on y-axis, one line per model.
6. TDD `ToolFrequencyChart`: recharts BarChart, top 20 tools by count in selected date range.
7. TDD `ActivityHeatmap`: grid of days (e.g., 12 cols × 7 rows for 12 weeks); color intensity = event count. No external lib needed.
8. TDD `CostSummary`: 3 cards — today, this week, this month — with sparkline.
9. TDD `AnalyticsPage`: date range picker at top (default 30d); fetches all 4 endpoints in parallel; renders charts in a grid.

## Acceptance criteria (spec §13.3 + §14.3 F5)
- [ ] Feed renders 10,000 events at ≥ 30fps scroll (FPS measured via DevTools performance recording)
- [ ] WS `hook:event` event prepends to feed without refresh
- [ ] Analytics page 30-day data loads in < 1s on a populated DB
- [ ] Date range change refetches and re-renders all charts
- [ ] Heatmap handles 365 days without layout break

## QA Checklist
- [ ] **QA-1:** Seed 10,000 hook events; feed scrolls smoothly (subjective + FPS log)
- [ ] **QA-2:** Filter event_type=PreToolUse; only those rows visible
- [ ] **QA-3:** Live: push 50 WS `hook:event`s in 1s; feed prepends all; oldest ones drop off at 500-cap
- [ ] **QA-4:** Analytics loads all 4 endpoints concurrently within 1s on 30-day data
- [ ] **QA-5:** Token chart shows separate lines per model
- [ ] **QA-6:** Tool frequency shows top 20 by count; bar labels readable
- [ ] **QA-7:** Heatmap tile hover shows count tooltip
- [ ] **QA-8:** No `any` types

## Quality bar
- No `any`, recharts used consistently, heatmap accessible (aria-label per cell with "N events on <date>")
