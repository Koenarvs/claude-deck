---
name: pickup
description: Quick session start — reload context from latest handoff, sprint plans, and git state
type: workflow
tags: [session, handoff, planning]
---

# Pickup

Fast context reload for mid-day session starts. Skips the full `/goodmorning` ceremony (no calendar, no Jira sprint query). Reads the latest handoff, checks git state, loads the active sprint plan, and proposes what to work on next.

Use this when resuming after a break, context clear, or session restart — not at the start of the day (use `/goodmorning` for that).

## Steps

### Phase 1: Load Context (automated, parallel)

Run all of these in parallel:

**1a. Find and read the most recent handoff**

```
Glob: C:\CTDW Repository\Wellsky\Handoffs\*.md
```

Sort by filename date descending. Read the most recent file fully. Extract:
- Priority queue
- Outstanding/not done items
- Blocked items
- Git state (branches, uncommitted work)
- Key decisions

**1b. Check git state across submodules**

```bash
git submodule foreach 'echo "=== $name ===" && git branch --show-current && git status --short && git log --oneline @{upstream}..HEAD 2>/dev/null || echo "no upstream"'
```

Compare against the handoff's git state. Flag:
- Branch changes since handoff
- New uncommitted work
- Unpushed commits

**1c. Load sprint plan (if exists)**

Check for an active sprint folder:

```
Glob: C:\CTDW Repository\Wellsky\Sprints\Sprint *\sprint-plan.md
```

If found, read the most recent sprint plan. Cross-reference story plans:

```
Glob: C:\CTDW Repository\Wellsky\Sprints\Sprint *\DW-*\plan.md
```

Note which stories have plans and which plan steps are marked complete.

**1d. Check today's daily plan (if exists)**

```
Read: C:\CTDW Repository\Wellsky\Daily\Plan_M-DD-YY.md
```

If a `/goodmorning` plan exists for today, use it as the primary priority source. If not, fall back to the handoff's priority queue.

### Phase 2: Present Context (concise)

Present a brief status summary — not a wall of text. The goal is to orient in 30 seconds.

```
Picking up from {handoff date/type}:

**Git**: {branch} on {submodule} — {clean/N uncommitted/N unpushed}
**Last worked on**: {ticket} — {what was done}
**Priority queue**:
1. {ticket} — {next step}
2. {ticket} — {next step}
3. {ticket} — {next step}

**Blocked**: {ticket} — {reason} (if any)

Ready to start on #{1}, or different priority?
```

### Phase 3: Go

After the user confirms direction:
- If the target story has a plan in `Wellsky/Sprints/`, read it and identify the next actionable step
- If the step is Claude-executable, start working
- If the step requires agent dispatch, propose launching agents
- If the step is human-required, present what's needed

No additional questions unless something from the handoff is ambiguous or contradicted by current git state.

## Edge Cases

- **No handoff exists**: This is a cold start. Suggest running `/goodmorning` instead.
- **Handoff is stale (> 3 days old)**: Warn the user — context may be outdated. Suggest `/goodmorning` for a full refresh.
- **Git state diverged from handoff**: Someone else may have pushed changes. Flag the differences and ask if they affect priorities.
- **Multiple handoffs on the same day**: Use the most recent one (sort by filename timestamp or midday-N number).

## File Locations

| File | Path |
|:-----|:-----|
| Handoffs | `C:\CTDW Repository\Wellsky\Handoffs\` |
| Sprint plans | `C:\CTDW Repository\Wellsky\Sprints\Sprint {N}\` |
| Story plans | `C:\CTDW Repository\Wellsky\Sprints\Sprint {N}\DW-XXXXX\plan.md` |
| Daily plan | `C:\CTDW Repository\Wellsky\Daily\Plan_M-DD-YY.md` |
