# B6 — Scheduler

**Burst:** Backend | **Depends on:** F0 merged | **Branch:** `feat/B6-scheduler`

## Goal
Cron-driven task creation. When a scheduled task's cron fires, instantiate a new goal from the task's template and kick off its session. Provides CRUD + run-now endpoints.

## Spec references
- §3.6 scheduled_tasks
- §5 scheduler endpoints
- §14.2 B6

## Scope
- Create: `server/scheduler.ts` — node-cron registry with start/stop per task
- Create: `server/routes/scheduled.ts` — `/api/scheduled-tasks/*`
- Create: `server/services/scheduled-task-service.ts` — CRUD
- Create: `tests/server/scheduler.test.ts`
- Create: `tests/server/routes/scheduled.test.ts`
- Modify: `server/index.ts` — initialize scheduler on boot; shut down on SIGTERM

## Contracts consumed
- `src/shared/types.ts`: `ScheduledTask`, `ScheduledTaskTemplate`, `CreateScheduledTaskInput`, `UpdateScheduledTaskInput`
- `src/shared/schemas.ts`: corresponding schemas
- `server/services/goal-service.ts` (B3): `create(input)` — the scheduler invokes this to spawn a goal from the template

## Contracts produced
- `scheduledTaskService`:
  - CRUD: `create`, `get`, `list`, `update`, `delete`
  - `runNow(id): Promise<{ goal_id }>`
- `scheduler`:
  - `start()` — loads all enabled tasks from DB and registers cron jobs
  - `stop()` — unregisters all jobs
  - `refresh(id)` — re-registers a single task (used on update/delete)

## Recommended task order
1. TDD `scheduled-task-service.ts`: create/get/list/update/delete; validate cron_expr with `node-cron`'s validator.
2. TDD `scheduler.ts`: register a task with cron `* * * * * *` (every second) → wait 2s → verify goal-service.create called twice. Disable → no more calls.
3. TDD refresh on update: change cron → old schedule stops, new starts.
4. TDD `runNow`: immediately calls goal-service.create, updates last_run_at.
5. Wire routes; zod-validate inputs.

## Cron validation
- Use node-cron's built-in validator (`cron.validate(expr)`)
- On invalid cron expr → 400 from routes
- Support standard 5-field cron syntax

## Goal template instantiation
When cron fires:
1. Read the scheduled_task row
2. Call `goalService.create({ ...goal_template, title: template.title + ' (' + timestamp + ')' })` — to avoid duplicate-title confusion
3. Update `last_run_at` and `next_run_at` on the scheduled_task row

## Acceptance criteria (spec §13 + §14.2 B6)
- [ ] Cron `* * * * *` (every minute) fires within 60s of scheduling, creates a goal
- [ ] `runNow` immediately creates a goal
- [ ] Disabled tasks do not fire
- [ ] Update cron_expr → old schedule stops, new takes effect
- [ ] Delete task → cron unregistered; no more fires
- [ ] Invalid cron_expr → 400 on create/update

## QA Checklist
- [ ] **QA-1:** Create task with 1-minute cron, wait 70s, check goal was created (may use fake timers OR a test running in real time)
- [ ] **QA-2:** Invalid cron "not a cron" returns 400
- [ ] **QA-3:** runNow creates goal; last_run_at is within 1s of now
- [ ] **QA-4:** Disable → task stops; re-enable → task resumes on next cron tick
- [ ] **QA-5:** Update cron_expr mid-run: scheduler.refresh called; old job removed, new registered
- [ ] **QA-6:** Server shutdown stops all crons cleanly
- [ ] **QA-7:** No `any` types

## Quality bar
- No `any`, JSDoc, cron validator on all inputs, shutdown handler wired in server/index.ts
