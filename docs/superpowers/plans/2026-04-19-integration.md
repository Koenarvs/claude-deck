# Integration — Phase 3 Runbook

**Depends on:** All Phase 2 bursts (B1-B6, F1-F6, S1-S4) report done on their feature branches
**Branch:** `main` (integration happens directly)
**Estimated duration:** 2-3 hours

## Goal
Merge all 16 burst branches into `main`, resolve any contract drift, run the full test suite, execute Playwright E2E tests, and hand off a working claude-deck v1 to smoke testing.

## Prerequisites
- [ ] F0 is on `main` and tagged `F0-complete`
- [ ] All 16 burst branches have passed their QA Checklists
- [ ] Each burst branch has a clean `npm run typecheck && npm test`
- [ ] Spec §16 open questions have been resolved (CLI smoke test done before Phase 2 started)

## Merge order

Merge burst-by-burst, not agent-by-agent. Group merges reduce conflict surface.

### Group 1: Backend services (merge in this order, resolve conflicts per-merge)
1. `feat/B4-sessions-service` — provides sessionService, messageService used by others
2. `feat/B3-goals-service` — provides goalService used by B2's hook ingest plan-update flow
3. `feat/B5-trace-writer` — provides traceService used by B1
4. `feat/B1-session-runner` — depends on B4, B5
5. `feat/B2-hook-ingest` — depends on B3 (goal-service.setPlan), B4 (session-service.create)
6. `feat/B6-scheduler` — depends on B3

**After each merge:**
- [ ] `npm run typecheck` clean
- [ ] `npm test` green
- [ ] `git commit` if conflict resolution required

### Group 2: Frontend pages

Order doesn't matter strictly — frontends consume the now-stable backend API.

7. `feat/F1-kanban`
8. `feat/F2-goal-detail`
9. `feat/F3-dashboard`
10. `feat/F4-sessions-ui`
11. `feat/F5-feed-analytics`
12. `feat/F6-scheduled-settings`

**After each merge:**
- [ ] `npm run build` succeeds (client side)
- [ ] `npm test` green

### Group 3: Support

13. `feat/S1-mcp` — standalone; merge doesn't touch server/
14. `feat/S2-hook-installer` — adds `scripts/` and `server/routes/system.ts`
15. `feat/S3-deploy-pwa` — adds Dockerfile + PWA assets
16. `feat/S4-global-ux` — modifies `src/components/AppShell.tsx` which F1-F6 may have also touched; resolve conflicts by merging imports into shell

## Conflict resolution strategy

Conflicts are predictable at known seams:

| Seam | Expected conflict | Resolution |
|---|---|---|
| `src/shared/types.ts` | Multiple bursts added related types | Accept all; if duplicates, keep the earlier-defined version, delete the later |
| `src/shared/schemas.ts` | Same | Same |
| `src/components/AppShell.tsx` | F1-F6 and S4 all modified | Merge imports + children into shell; S4's global overlays go at the end |
| `server/routes/` index | Each service added a route registration | Accept all route mounts |
| `server/index.ts` | Scheduler boot (B6), traceService shutdown (B5), process registry shutdown (B1) | Accept all shutdown handlers, order matters: runners → scheduler → traces → db → http |
| `package.json` deps | Multiple bursts added deps | `npm install` after taking union |

If a conflict is non-trivial (logic disagreement, not mechanical): stop, read both versions, prefer the one that better matches the spec, add a comment explaining the choice.

## Test gauntlet (after all 16 merges)

- [ ] `npm run typecheck` — 0 errors in both tsconfigs
- [ ] `npm test` — every unit/integration test from every burst passes
- [ ] `npm run build` — client + server build succeed
- [ ] `npm run format:check` — no formatting drift

## E2E tests (Playwright)

Create `tests/e2e/*.spec.ts` — new tests written during integration covering spec §13.1 acceptance criteria:

### e2e-1: Goal creation and first turn
- [ ] Start server
- [ ] Browser opens http://localhost:5173
- [ ] Click "+ New Goal" on Kanban page
- [ ] Fill title, cwd (use a test fixture dir), initial prompt, permission_mode=autonomous
- [ ] Submit → goal card appears in "planning" column, transitions to "active" within 2s
- [ ] Goal detail shows assistant reply streaming within 10s
- [ ] Final goal status is "waiting"

### e2e-2: Approval flow
- [ ] Create goal with permission_mode=supervised
- [ ] Send prompt: "run `echo hello` in the terminal"
- [ ] Assistant attempts Bash tool → PreToolUse hook fires → approval card appears in global queue within 500ms
- [ ] Click Allow → tool executes → result appears in conversation
- [ ] Approval card disappears

### e2e-3: External session observation
- [ ] In a separate process: run `claude --print "say hi"` in a test directory
- [ ] Feed page shows new events for that session within 1s
- [ ] Sessions page lists the session with origin=external

### e2e-4: Trace download
- [ ] Complete a goal
- [ ] Goal detail → click "Download trace"
- [ ] Browser receives tar file
- [ ] Extracting tar yields stream.jsonl, hooks.jsonl, stderr.log, meta.json per session

### e2e-5: Scheduler fires
- [ ] Create scheduled task with cron `* * * * *` (every minute)
- [ ] Wait ~70s
- [ ] Assert a new goal was created automatically

### e2e-6: MCP driven goal
- [ ] Start MCP server (separate process)
- [ ] MCP inspector or test harness calls `create_goal`
- [ ] Goal appears in UI within 1s
- [ ] WS `goal:created` event observed

### e2e-7: Docker smoke
- [ ] `docker compose up --build`
- [ ] `curl http://localhost:4100/api/health` returns ok
- [ ] Open http://localhost:4100/ in browser → SPA loads

## Manual smoke checklist (after E2E green)

Perform by hand; confirm before declaring v1 complete:

- [ ] Create 3 goals in different cwds; each spawns a subprocess, each streams correctly
- [ ] Drag a goal between Kanban columns → PATCH fires, card persists after refresh
- [ ] Plan pane updates live as assistant writes TodoWrite calls
- [ ] Interrupt a running goal → subprocess dies, goal → waiting
- [ ] Close browser mid-session; reopen → messages + plan still populated from DB
- [ ] Restart server mid-session (Ctrl-C, `npm start`) → goal status reflects waiting (no stale active)
- [ ] Install hooks via Settings UI; run `claude` in terminal → Feed shows events
- [ ] Uninstall hooks → terminal `claude` no longer reports to Feed
- [ ] Switch home route from /board to /dashboard; reload → lands on dashboard
- [ ] PWA install: Chrome → Install app → standalone window opens with icon
- [ ] Download a goal trace → tar extracts; stream.jsonl is valid JSONL per line

## Bug triage during integration

Expect 5-15 bugs at integration. Categorize:

| Severity | Action |
|---|---|
| Blocker (prevents core flow, e.g., subprocess doesn't spawn) | Fix in place; do not proceed until green |
| Major (a feature is broken but not core, e.g., analytics shows wrong numbers) | File as `v1.1` issue OR fix if quick; document decision |
| Minor (UI polish, edge case) | File; don't fix in integration |

## Hand-off

When integration green + manual smoke clean:

- [ ] Tag release: `git tag -a v1.0.0 -m "claude-deck v1 initial release"`
- [ ] Update `README.md` with install instructions (reference `docs/superpowers/plans/2026-04-19-README.md` for the implementation history)
- [ ] Create `docs/v1.1-backlog.md` listing:
  - In-UI trace viewer
  - Trace diff / replay
  - LAN/phone access (Tailscale)
  - Tauri wrapper
  - Any deferred bugs from integration
  - Open spec §16 questions not yet resolved
- [ ] Signal orchestrator: **"claude-deck v1 ready for smoke testing on work PC."**

## Rollback plan

If integration cannot be completed within a reasonable time budget (e.g., >6 hours of integration debugging):

- [ ] Identify which Group's merges introduced the worst drift (likely Group 1 if foundation contracts shifted, Group 3 if shell modifications conflicted)
- [ ] Revert all merges after F0
- [ ] Accept scope slip: pick the subset of bursts that merged cleanly, defer the rest to v1.1
- [ ] Minimum viable v1: F0 + B1 + B2 + B3 + F1 + F2 + S4 (wrapper + goals + Kanban + goal detail + approval queue) is the core
