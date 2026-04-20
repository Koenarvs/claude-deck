# S2 — Hook Installer Scripts

**Burst:** Support | **Depends on:** F0 merged | **Branch:** `feat/S2-hook-installer`

## Goal
Two CLI scripts: `install-hooks.ts` merges claude-deck hooks into `~/.claude/settings.json`; `uninstall-hooks.ts` restores the backup. Also exposes these as server-side endpoints `/api/system/install-hooks` and `/uninstall-hooks` for the UI Settings page.

## Spec references
- §8.1 what gets installed
- §14.4 S2

## Scope
- Create: `scripts/install-hooks.ts` — callable from CLI
- Create: `scripts/uninstall-hooks.ts` — callable from CLI
- Create: `server/services/hook-installer-service.ts` — shared logic used by both CLI and HTTP endpoint
- Create: `server/routes/system.ts` — POST endpoints
- Create: `tests/scripts/install-hooks.test.ts`
- Create: `tests/server/services/hook-installer-service.test.ts`

## Contracts consumed
- `hooks/client.js` path (owned by B2) — exact path where the hook script lives after install

## Contracts produced
- `hookInstallerService`:
  - `install(): Promise<{ installed: boolean; backupPath: string | null }>`
  - `uninstall(): Promise<{ uninstalled: boolean }>`
  - `status(): Promise<{ installed: boolean; installedAt: number | null }>`

## Behavior
### Install
1. Resolve `~/.claude/settings.json` (create if missing).
2. Backup to `~/.claude/settings.claude-deck-backup-<timestamp>.json`.
3. Load existing JSON (or `{}` if missing).
4. Merge the hook definitions from spec §8.1 into the `hooks` object, preserving any pre-existing hook commands under the same event types (append our command as another hook in the same list).
5. Mark installed: record a `.claude-deck-install-marker` file with install timestamp OR include a `_meta.claudeDeckInstalledAt` key in the settings.
6. Write back atomically (temp file + rename).

### Uninstall
1. Find `.claude-deck-install-marker` (or the _meta key).
2. Read the backup file.
3. Validate backup is valid JSON.
4. Write backup back to `~/.claude/settings.json`.
5. Remove marker.

### Idempotency
- Running install twice: first install creates marker + backup; second install is a no-op (or updates timestamp).
- Running uninstall after uninstall: no-op with informative log.

### Windows path handling
Per spec §16.1: hook command strings in settings.json use forward slashes. Hook client path resolved as:
- Preferred: `<repo>/hooks/client.js` if installing from a dev checkout
- Fallback: `~/.claude-deck/hooks/client.js` for paths with spaces

The command string in settings.json: `"node \"<absolute path to hooks/client.js>\" <event-name>"`

## Recommended task order
1. TDD `hook-installer-service.ts` against a temp dir (use `tmp` or mkdir in test dir): install creates backup + merges; uninstall restores.
2. TDD edge cases: settings.json with pre-existing hooks merges correctly (our hooks appended to existing arrays, not replacing); malformed settings.json errors cleanly.
3. TDD `routes/system.ts`: POST endpoints call the service, return status.
4. Wire CLI scripts: thin wrappers around the service, print status to stdout.
5. Test Windows paths: install on a path with spaces — use the fallback `~/.claude-deck/hooks/` strategy.

## Acceptance criteria (spec §14.4 S2)
- [ ] Install creates a timestamped backup file
- [ ] Install merges into existing settings without destroying other hooks
- [ ] Uninstall restores the original settings byte-for-byte from the backup
- [ ] Idempotent: running install twice doesn't duplicate hooks
- [ ] Windows paths with spaces handled via fallback install location
- [ ] HTTP endpoints return `{ installed: true }` / `{ uninstalled: true }`

## QA Checklist
- [ ] **QA-1:** Fresh user (no ~/.claude/settings.json) → install creates settings.json with just our hooks
- [ ] **QA-2:** User with existing hooks → install preserves existing hooks and appends ours
- [ ] **QA-3:** Install twice → second is no-op; hooks not duplicated
- [ ] **QA-4:** Uninstall after install → settings.json equals pre-install backup byte-for-byte
- [ ] **QA-5:** Uninstall without prior install → logs "not installed" and exits 0
- [ ] **QA-6:** Install from path with spaces → uses fallback location
- [ ] **QA-7:** POST `/api/system/install-hooks` returns 200 with `{installed: true}` after success
- [ ] **QA-8:** No `any` types

## Quality bar
- No `any`, atomic file writes (temp + rename), JSON schema-validate settings.json before write to catch corruption
