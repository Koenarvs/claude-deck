# DW-31893: Session Observer Dashboard — Fix Plan

**Date**: 2026-04-21
**Status**: In Dev
**Issues identified**: 5

---

## Issue 1: Stale Active Sessions

**Problem**: Sessions that never received a Stop hook event show as perpetually "Active." The screenshots show 5 sessions from Apr 20 still marked active after 25+ hours. This happens when the CLI exits without firing the stop hook (killed, crashed, window closed, or hooks weren't installed at the time).

**Root Cause**: `sessions.ended_at` is only set when a Stop hook event is received. No fallback mechanism exists.

**Fix — Two parts**:

### 1a. Auto-detect orphaned sessions on server startup

On server startup, query for sessions where:
- `ended_at IS NULL`
- `started_at < (now - threshold)` (e.g., 4 hours)
- No hook events received in the last hour

Auto-close these with `ended_at = last_hook_event_time` or `ended_at = now` if no events exist.

**File**: `server/index.ts` (add after `runMigrations()`)

```typescript
// After DB init, clean up orphaned sessions
const staleThresholdMs = 4 * 60 * 60 * 1000; // 4 hours
const cutoff = Date.now() - staleThresholdMs;
const stale = db.prepare(`
  UPDATE sessions 
  SET ended_at = COALESCE(
    (SELECT MAX(created_at) FROM hook_events WHERE session_id = sessions.id),
    ?
  )
  WHERE ended_at IS NULL AND started_at < ?
`).run(Date.now(), cutoff);
logger.info({ closedCount: stale.changes }, 'Closed orphaned sessions on startup');
```

### 1b. "Mark Ended" button on session detail

Add a UI action for manually closing stale sessions. Useful when auto-detect threshold is too generous.

**Files**:
- `server/routes/sessions.ts` — Add `POST /api/sessions/:id/end`
- `server/services/session-service.ts` — Add `endSession(id)` method
- `src/components/sessions/SessionDetailHeader.tsx` — Add "Mark Ended" button (only shown when `ended_at` is null)

**Estimate**: 1-2 hours

---

## Issue 2: Merge Feed Tab into Sessions

**Problem**: The Feed tab is a raw firehose of hook events across all sessions. This data is redundant — it's better consumed per-session (Sessions detail), aggregated (Analytics), or filtered to actionable items (Approvals). Two tabs showing the same data from different angles forces context-switching.

**Fix**: Merge live operational data into the Sessions tab. Remove the standalone Feed tab.

### 2a. Sessions list — add live status columns

Add to the Sessions table:
- **Last Event** column — time since last hook event (e.g., "3s ago", "idle")
- **Current Tool** column — tool name from most recent PreToolUse without a matching PostToolUse (i.e., currently executing)
- **Event Count** badge — total hook events for the session (already tracked as `hook_event_count`)

**Files**:
- `src/components/sessions/SessionsTable.tsx` — Add columns
- `server/routes/sessions.ts` — Extend `GET /api/sessions` response to include `last_event_at` and `current_tool`
- `server/services/session-service.ts` — Add query for current tool state

### 2b. Session detail — inline event feed

Add a "Events" tab or collapsible section to the session detail page showing that session's hook events chronologically. This replaces the Feed page for per-session debugging.

**Files**:
- `src/pages/SessionDetailPage.tsx` — Add events section
- `server/routes/sessions.ts` — Add `GET /api/sessions/:id/events` (paginated)

### 2c. Remove Feed tab

- Remove `src/pages/FeedPage.tsx`
- Remove `src/components/feed/FeedList.tsx` and `FeedRow.tsx`
- Remove Feed route from `src/routes.tsx`
- Remove Feed entry from `src/components/Sidebar.tsx`
- Remove `useFeedStore.ts` (feed events now fetched per-session)
- Update WebSocket event dispatch — `hook:event` still broadcasts but no global feed store

### 2d. Dashboard "Recent Activity" widget

Keep the Recent Activity widget on the Dashboard page — it still has value as a quick glance. But source it from the same per-session event data, not a separate store.

**Estimate**: 3-4 hours

---

## Issue 3: Sessions Default to Active Only

**Problem**: The Sessions tab defaults to showing all sessions (ended included). The first thing a user does is check "Active only" to see what's currently running. Ended sessions are history — not the default view.

**Fix**: Change the default filter state.

**File**: `src/components/sessions/SessionFilters.tsx`

Change the initial state of the "Active only" checkbox from `false` to `true`.

If the filter state is managed in the URL query params or a Zustand store, update the default there.

**Estimate**: 15 minutes

---

## Issue 4: Hook Auto-Injection on Server Startup

**Problem**: Hooks installed via the Settings UI get wiped when Claude Code rewrites `~/.claude/settings.json` (plugin changes, permission updates, model changes). The current status check only looks for a marker file, not actual hook presence. Users have to manually reinstall frequently.

**Root Cause**: Two systems (Claude Code and Claude Deck) compete for write access to `~/.claude/settings.json`. Claude Code drops the `hooks` key when it rewrites.

**Fix — Three parts**:

### 4a. Verify actual hook presence (not just marker)

Replace the marker-based `status()` method with an actual file check.

**File**: `server/services/hook-installer-service.ts`

```typescript
async status(): Promise<InstallStatus> {
  const settingsPath = resolveSettingsPath(this.homeDir);
  try {
    const settings = readSettings(settingsPath);
    const hooks = settings.hooks as HooksObject | undefined;
    if (!hooks) return { installed: false, installedAt: null };
    
    // Check if ALL required event types have our hook
    const allPresent = HOOK_EVENT_TYPES.every(eventType => {
      const matchers = hooks[eventType] ?? [];
      return matchers.some(m => m.hooks.some(h => isClaudeDeckHook(h.command)));
    });
    
    if (!allPresent) return { installed: false, installedAt: null };
    
    // Read marker for installedAt timestamp (optional)
    const markerPath = resolveMarkerPath(this.homeDir);
    if (fs.existsSync(markerPath)) {
      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8')) as InstallMarker;
      return { installed: true, installedAt: marker.installedAt };
    }
    return { installed: true, installedAt: null };
  } catch {
    return { installed: false, installedAt: null };
  }
}
```

### 4b. Auto-inject on server startup

On server startup, check if hooks are present. If not, inject them automatically. No user action required.

**File**: `server/index.ts` (add after DB init)

```typescript
// Auto-ensure hooks are installed
const hookStatus = await hookInstallerService.status();
if (!hookStatus.installed) {
  logger.info('Hooks not found in settings.json — auto-installing');
  await hookInstallerService.install();
} else {
  logger.info('Hooks verified in settings.json');
}
```

### 4c. Change install() to merge-not-overwrite

The current `install()` already merges — but it skips entirely if the marker exists (line 265-268). Remove the marker-based early return so it always verifies and re-injects if needed.

```typescript
async install(): Promise<InstallResult> {
  const settingsPath = resolveSettingsPath(this.homeDir);
  const hookClientPath = resolveHookClientPath(this.repoRoot, this.homeDir);
  
  // Always read current settings and ensure hooks are present
  let settings: SettingsJson;
  try {
    settings = readSettings(settingsPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read settings.json: ${msg}`);
  }
  
  const existingHooks: HooksObject = (settings.hooks as HooksObject) ?? {};
  const mergedHooks = this.mergeHooks(existingHooks, hookClientPath);
  
  // Check if anything actually changed
  const changed = JSON.stringify(existingHooks) !== JSON.stringify(mergedHooks);
  if (!changed) {
    return { installed: true, backupPath: null };
  }
  
  // Backup + write only if hooks changed
  let backupPath: string | null = null;
  if (fs.existsSync(settingsPath)) {
    const timestamp = Date.now();
    backupPath = path.join(
      resolveClaudeDir(this.homeDir),
      `settings.claude-deck-backup-${timestamp}.json`,
    );
    fs.copyFileSync(settingsPath, backupPath);
  }
  
  settings.hooks = mergedHooks;
  writeSettingsAtomic(settingsPath, settings);
  
  // Update marker
  const markerPath = resolveMarkerPath(this.homeDir);
  const marker: InstallMarker = {
    installedAt: Date.now(),
    backupPath: backupPath ?? '',
    hookClientPath,
  };
  fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2) + '\n', 'utf-8');
  
  return { installed: true, backupPath };
}
```

### 4d. Update Settings UI

Change the Settings page from a manual "Install/Uninstall" action to a status display:
- Green indicator: "Hooks active — verified in settings.json"
- Yellow indicator: "Hooks missing — re-injecting..." (auto-heals)
- "Uninstall" button still available for users who want to opt out

**Estimate**: 2-3 hours

---

## Issue 5: Settings UI Shows "Not Installed" Despite Working Hooks

**Problem**: Related to Issue 4. The Settings page shows "Not installed" because the marker file is missing, even if hooks were manually configured. Once Issue 4 is fixed (verify actual presence), this resolves automatically.

**Fix**: Covered by Issue 4a (status checks actual file, not marker).

---

## Implementation Order

```
Issue 3 (15 min)  →  Sessions default to Active
Issue 1a (30 min) →  Auto-close orphans on startup  
Issue 4 (2-3h)    →  Hook auto-injection + status verification
Issue 2 (3-4h)    →  Merge Feed into Sessions
Issue 1b (1h)     →  Manual "Mark Ended" button
```

**Total estimate**: 7-9 hours

**Rationale**: 
- Issue 3 is a one-line change, do first
- Issue 1a unblocks clean session list immediately
- Issue 4 fixes the most frustrating UX problem (hooks disappearing)
- Issue 2 is the largest refactor but not blocking
- Issue 1b is a nice-to-have after auto-close exists

---

## Acceptance Criteria

- [ ] Sessions tab defaults to "Active only" checked
- [ ] Server startup auto-closes sessions older than 4 hours with no recent events
- [ ] Server startup auto-verifies and re-injects hooks if missing from settings.json
- [ ] Settings page shows actual hook status (green/yellow), not marker-based
- [ ] No standalone Feed tab — event data is per-session in Sessions detail
- [ ] Sessions table shows Last Event and Current Tool columns
- [ ] "Mark Ended" button on active session detail view
- [ ] All existing tests still pass
- [ ] New tests for orphan cleanup and hook verification logic
