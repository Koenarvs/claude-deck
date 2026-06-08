# Markdown View + Edit — Design

**Date:** 2026-06-08
**Status:** Approved (core). **Blocked** on the "Persistent Settings" goal — see §8 Dependencies.
**Author:** brainstorming session with Jerry.

---

## 1. Problem

Markdown files render inconsistently across Claude Deck: some screens show raw
text, others render formatted markdown, and none let the user switch between the
two or edit the file. We want every place that displays a markdown file to:

1. offer a **md/txt toggle** — switch between pretty (rendered) and raw (source), and
2. offer an **edit** affordance that writes changes back to disk.

## 2. Current state (display sites)

| Site | File / line | Renders today | Toggle | Edit |
|---|---|---|---|---|
| CLAUDE.md page | `src/pages/ClaudeMdPage.tsx:154` | Raw `<pre>` only | No | No |
| Skill viewer modal | `src/pages/SkillsPage.tsx:618` | Pretty (ReactMarkdown + prose) | No | No |
| Goal documents pane | `src/components/goal/GoalPlanPane.tsx:354` | Pretty (ReactMarkdown + prose) | No | No |

The ~12-line Tailwind `prose` className block is copy-pasted verbatim in
SkillsPage and GoalPlanPane. Read APIs already exist
(`GET /api/skill-content`, `GET /api/goals/:id/document`, CLAUDE.md via
`GET /api/directories?claudemd=true`). There is **no general file-write
endpoint** — only narrow skill-file writes via `server/services/skill-file-service.ts`
(diff-apply + version snapshot + revert).

## 3. Decisions (locked)

- **Default view:** pretty (`md`). Raw is one toggle click away.
- **Scope:** all three current sites. Component built reuse-ready for the
  orchestrator goal's `<dataDir>/orchestrator/memory.md` (no UI built for it now).
- **Edit UX:** distinct edit mode. The md/txt toggle controls *reading only*; a
  separate **Edit** button opens a textarea with **Save** / **Cancel**. Viewing
  raw never risks accidental edits. (Rejected alternative: making the raw view
  itself the editor — see §10.)
- **Toggle persistence:** none for now — pretty on every open. (Persisting the
  last-used view is a possible follow-up under the Persistent Settings goal.)

## 4. Related in-flight workstreams (reviewed)

- **Agent-adapter foundation** (`2026-06-06-agent-adapter-foundation-design.md`):
  model→provider resolution; edits `NewGoalModal`, `GoalHeader`,
  `ScheduledTaskEditor`, `KanbanCard`. **No markdown/display overlap.** Safe.
- **Orchestrator** (`2026-06-08-orchestrator-design.md`): introduces
  `<dataDir>/orchestrator/memory.md`, explicitly *"a plain, human-readable file
  the owner can open at any time… human-readable/editable by design."* This is a
  **future fourth consumer** of the component designed here. We design for its
  reuse but do not build that UI in this work.

## 5. Architecture

One shared presentational component replaces all three ad-hoc renderers. The
duplicated `prose` block becomes a shared constant. The component is backend-
agnostic: it receives an injected `onSave` handler, so each call site supplies
the correct write path.

```
src/components/shared/
  MarkdownView.tsx      // md/txt read toggle + Edit→textarea→Save/Cancel; owns view/edit state
  markdownProse.ts      // exported PROSE_CLASSES constant (de-dupes SkillsPage + GoalPlanPane)
```

Two save backends, chosen per call site:

- **Skill / agent files** → reuse the version-snapshot infra. Add
  `saveSkillContent(skillPath, skillName, newContent, changeReason, expectedHash?)`
  to `skill-file-service`, which snapshots the current content as a new
  `skill_versions` row (exactly like `applySuggestion` does) then writes the full
  new content. Editing a skill from the UI therefore preserves the existing
  version-history / revert feature. Exposed via a new skill route.
- **CLAUDE.md + goal docs** → a new guarded generic write endpoint (§7).

## 6. Component contract

```ts
interface MarkdownViewProps {
  content: string;
  fileName?: string;                          // shown in the header
  defaultView?: 'md' | 'txt';                 // defaults to 'md'
  baseModifiedMs?: number;                     // mtime at load, for conflict detection
  onSave?: (next: string) => Promise<void>;   // omit ⇒ read-only (no Edit button)
}
```

State:

- `view: 'md' | 'txt'` — which read rendering is shown.
- `editing: boolean` — whether the textarea is active.

Behavior:

- **Reading:** header shows `[md] [txt]` segmented toggle + an **Edit** button
  (only if `onSave` is provided). `md` → ReactMarkdown with `PROSE_CLASSES`;
  `txt` → raw source in a read-only `<pre>`/monospace block.
- **Editing:** header swaps to **Cancel** / **Save**. Body becomes a monospace
  textarea seeded with the raw source. Save calls `onSave(next)`; on success,
  exits edit mode and the parent refetches canonical content. On failure
  (including 409 conflict) the buffer is preserved and an inline error shows.
- **Cancel** with unsaved changes prompts for confirmation before discarding.
- No `onSave` ⇒ pure viewer (toggle only, no Edit button) — this is the
  reuse-ready read-only mode.

## 7. Write backend + path guard

> **Note:** the editable-roots source for the generic endpoint is **deferred to
> the Persistent Settings goal** (see §8). The endpoint contract and guards below
> are stable; only the *source of the allowlist roots* is pending.

`PUT /api/file` — body `{ path, content, baseModifiedMs }`, zod-validated.

Guards (all server-side):

- **Allowlist by root** — `realpathSync` the target; accept only if it resolves
  under an allowed root. Allowed roots come from the Persistent Settings
  "Document roots" list (§8) once that exists. Anything else → `403`.
- **No traversal / symlink escape** — reject if the realpath leaves its root.
- **Edit-only** — file must already exist and be a regular file. No create,
  delete, or rename.
- **Type / size caps** — text only, reject binary, cap at ~1 MB.
- **Optimistic concurrency** — client sends the `mtimeMs` it loaded; if disk
  mtime differs → **409 Conflict**, UI prompts to reload. Matters because agents
  actively write goal docs and `memory.md`.
- Audit log line per write.

Single-user posture: each user runs their own isolated instance, so the guards
above exist as **correctness/safety guards** (prevent a textarea typo or `..`
from writing outside the configured roots), not as a multi-user security wall.

Skill saves bypass this endpoint and go through
`skill-file-service.saveSkillContent` (snapshot + write), reusing the existing
stale-hash check.

## 8. Dependencies — Persistent Settings goal (blocking)

This work **depends on a separate "Persistent Settings" goal** that Jerry is
scoping. Today settings do **not** persist: `GET /api/config` returns hardcoded
defaults (`server/routes/system.ts:131`), `PUT /api/config` logs and discards
(`:145`), and `useConfigStore` is in-memory. The only persisted "setting" is
skill directories (SQLite `skill_directories`).

The Persistent Settings goal is expected to provide:

1. **Config persistence** — a durable store (SQLite table or JSON under
   `dataDir`) with `PUT /api/config` actually saving.
2. **A managed "Document roots" list** in Settings that does double duty:
   - seeds markdown / CLAUDE.md scanning (so the CLAUDE.md page stops requiring
     a directory to be re-typed each session), and
   - **is** the write allowlist for the generic editing endpoint (§7) —
     preserving the invariant "you can edit exactly what the app is configured
     to read."

**To append once that goal is scoped:** reconcile §7's allowlist source with the
Persistent Settings data model, and refactor `ClaudeMdPage` to read roots from
the persisted list instead of the ad-hoc directory input. This spec's §5/§6
(component + skill-save path) are **not** blocked and could land first if
desired, but per Jerry's direction the whole feature waits on Persistent
Settings.

## 9. Testing (TDD)

- **MarkdownView** unit: defaults to pretty; toggle md↔txt; Edit enters textarea;
  Save calls handler then exits edit mode; Save failure keeps the buffer + shows
  error; Cancel-with-changes confirms; read-only (no Edit button) when `onSave`
  is omitted.
- **`PUT /api/file`**: rejects traversal, rejects outside-root, rejects
  non-existent, rejects oversized/binary; accepts valid; `409` on mtime mismatch.
- **`skill-file-service.saveSkillContent`**: writes the new content + creates a
  `skill_versions` row; stale-hash → error.
- Keep the existing SkillsPage test green.

## 10. Out of scope (YAGNI)

- Creating / deleting / renaming files.
- WYSIWYG editor.
- Persisting the md/txt toggle across sessions (possible follow-up under
  Persistent Settings).
- Building the orchestrator `memory.md` UI (component is merely reuse-ready).
- Live / collaborative editing.

## 11. Considered alternatives (rejected)

- **Raw view *is* the editor** (no separate edit mode): fewer states, but viewing
  raw means sitting in an editable field (accidental edits) and Save lives in a
  surprising place. Rejected in favor of a distinct edit mode.
- **A parallel write-only path allowlist in Settings, separate from read roots:**
  creates a second source of truth that drifts from what the app can read and
  could authorize writing to a root the app can't display. Rejected in favor of a
  single "Document roots" list that drives both read scanning and the write
  allowlist (§8).
- **Browser-flippable "enable editing" master toggle as a security control:**
  weak in a single-user, single-instance app and pointless without config
  persistence. Dropped; path guards (§7) cover the real (correctness) risk.
