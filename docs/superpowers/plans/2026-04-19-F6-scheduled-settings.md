# F6 — Scheduled + Settings + Carry-over Wiring

**Burst:** Frontend | **Depends on:** F0 merged | **Branch:** `feat/F6-scheduled-settings`

## Goal
`/scheduled`: CRUD UI for cron-driven tasks. `/settings`: extended from claude-monitor with hook installer section, data dir, home route toggle. Wire claude-monitor carry-over pages (`/skills`, `/claude-md`).

## Spec references
- §10 frontend, §14.3 F6

## Scope
- Replace stubs: `src/pages/ScheduledPage.tsx`, `src/pages/SettingsPage.tsx`, `src/pages/SkillsPage.tsx`, `src/pages/ClaudeMdPage.tsx`
- Create: `src/components/scheduled/ScheduledTasksList.tsx`
- Create: `src/components/scheduled/ScheduledTaskEditor.tsx` — modal with form + cron picker
- Create: `src/components/scheduled/CronPicker.tsx` — simple text input with validation preview (shows next 5 fire times via `cron-parser` library)
- Create: `src/components/settings/HookInstallerSection.tsx`
- Create: `src/components/settings/DataDirSection.tsx`
- Create: `src/components/settings/HomeRouteToggle.tsx`
- Carry-over from claude-monitor (copy + adapt): `SettingsPanel.tsx`, `SkillsBrowser.tsx`, `ExtensionsPanel.tsx`, `ClaudeMdPanel.tsx`, `FolderBrowser.tsx`, `SpawnDialog.tsx`
- Create: `tests/client/scheduled.test.tsx`

## Library additions
- `cron-parser` for cron expression validation and next-fire preview

## Contracts consumed
- `src/shared/types.ts`: `ScheduledTask`, `CreateScheduledTaskInput`, `AppConfig`
- Backend: `/api/scheduled-tasks/*`, `/api/config`, `/api/system/install-hooks`, `/api/system/uninstall-hooks`, `/api/directories`, `/api/skills`, `/api/extensions`

## Recommended task order — Scheduled
1. TDD `CronPicker`: input field, parses via `cron-parser`, shows next 5 fire timestamps. Invalid expr shows red border + error.
2. TDD `ScheduledTaskEditor`: form with name, cron, title, cwd (FolderBrowser), model, initial prompt, tags, enabled toggle. Submit → POST or PATCH.
3. TDD `ScheduledTasksList`: table of tasks with columns name, cron, next_run_at, last_run_at, enabled toggle, edit/delete/run-now actions.
4. TDD `ScheduledPage`: loads tasks, renders list, hosts the editor modal.

## Recommended task order — Settings
5. Copy `SettingsPanel.tsx` from claude-monitor. Adapt imports to new paths. Remove SDK-specific settings.
6. TDD `HookInstallerSection`: reads `/api/extensions` to check if hooks are installed; shows "Install Global Hooks" or "Uninstall" button; confirmation modal before mutating `~/.claude/settings.json`.
7. TDD `DataDirSection`: displays current dataDir (read-only), shows disk usage of traces dir, "Open data folder" button (Electron-style would be nice; for web use a label only).
8. TDD `HomeRouteToggle`: radio: `/board` (Kanban-first, default) / `/dashboard` (Dashboard-first). PATCH /api/config on change.
9. TDD `SettingsPage`: renders the carry-over SettingsPanel + new sections.

## Recommended task order — Skills / ClaudeMd carry-over
10. Copy `SkillsBrowser.tsx`, `ExtensionsPanel.tsx`, `ClaudeMdPanel.tsx` from claude-monitor. Adapt imports.
11. TDD `SkillsPage`: loads `/api/skills` + `/api/extensions`, renders SkillsBrowser + ExtensionsPanel in tabs.
12. TDD `ClaudeMdPage`: loads active goal's cwd CLAUDE.md (or prompt user to select a directory), renders ClaudeMdPanel.

## Acceptance criteria (spec §14.3 F6)
- [ ] Cron picker validates "invalid" inputs with red border
- [ ] Cron picker shows next 5 fire times for "*/5 * * * *"
- [ ] Install-hooks button triggers POST `/api/system/install-hooks`; success toast; status indicator updates
- [ ] Home route toggle persists via PATCH /api/config; reload page → new home route takes effect
- [ ] Carry-over components render without errors
- [ ] Skills page lists installed skills; extensions panel lists MCP servers and hooks

## QA Checklist
- [ ] **QA-1:** Invalid cron "foo bar" → red border, error message, submit blocked
- [ ] **QA-2:** Cron "*/5 * * * *" → next 5 times shown, each 5 min apart
- [ ] **QA-3:** Create scheduled task → POST fires; list updates; run-now button creates a goal immediately
- [ ] **QA-4:** Toggle enabled on a task → PATCH; next_run_at recalculated server-side
- [ ] **QA-5:** Install hooks → modal confirms → POST → success toast; status shows "installed"
- [ ] **QA-6:** Home route toggle changes default; navigation to `/` redirects appropriately after reload
- [ ] **QA-7:** Skills page loads skills list
- [ ] **QA-8:** No `any` types; no SDK-specific code in carry-over components

## Quality bar
- No `any`, carry-over components tested same as originals or better, cron validation uses cron-parser (no custom regex)
