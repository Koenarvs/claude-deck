---
name: goodmorning
description: Daily planning — calendar, Jira sprint, email, Teams, and last session handoff review
---

# Good Morning — Daily Planning Skill

Generates a daily work plan by combining calendar, email, Teams, Jira sprint state, last session handoff, and user clarification.

## Usage

When user runs `/goodmorning`, follow the workflow below.

## Prerequisites

Requires the Playwright MCP server configured with a browser profile that has M365 auth cookies:

```json
{
  "playwright": {
    "command": "npx",
    "args": [
      "@playwright/mcp@latest",
      "--user-data-dir",
      "C:\\Users\\jerry.spangler\\.playwright-profiles\\m365"
    ]
  }
}
```

If Playwright navigation to Outlook returns a login page instead of the inbox/calendar, the auth cookies have expired. Ask the user to sign in manually in the Playwright browser window, then retry.

## Workflow

### Phase 1: Gather Context (automated, no questions)

Collect all context silently. Use parallel tool calls where possible.

**IMPORTANT**: Steps 1a, 1b, and 1c use Playwright and MUST run sequentially (single browser). Steps 1d–1h can run in parallel with each other, and can start while the Playwright sequence is still in progress.

**1a. Read Calendar (Playwright)**

Navigate to Outlook calendar day view:

```
mcp__playwright__browser_navigate: https://outlook.office365.com/calendar/view/day
```

Wait for the page to load, then read the accessibility snapshot:

```
mcp__playwright__browser_snapshot
```

Parse meeting data from the snapshot. Meetings appear as `button` elements with structured text:

```
"[Title], [Start Time] to [End Time], [Day], [Date], [Location/Teams], By [Organizer], [Status], [Recurrence]"
```

Extract and note:
- Meetings: time, duration, title, organizer
- Teams meetings (have "Microsoft Teams Meeting" and "Join Teams meeting" button)
- Tentative vs accepted status
- Recurring vs one-off
- Available work blocks (gaps between meetings)
- Total available work hours (subtract meetings from work day)

If the snapshot shows only a login page, stop and tell the user their M365 session expired — they need to sign in manually in the Playwright browser.

**1b. Read Inbox (Playwright)**

Navigate to Outlook inbox:

```
mcp__playwright__browser_navigate: https://outlook.office365.com/mail/
```

Read the accessibility snapshot. Email items appear as `option` elements with structured text containing sender, subject, timestamp, and preview.

Extract from the Focused inbox:
- Top ~10 emails: sender, subject, received time, preview snippet
- Unread count (from tab label)
- Meeting invites requiring RSVP
- Anything from team members or stakeholders that could affect priorities

Also note the Other inbox unread count (visible in the "Click to switch to Other" button text).

**1c. Check Teams (Playwright)**

Navigate to Teams:

```
mcp__playwright__browser_navigate: https://teams.microsoft.com
```

Wait 5 seconds for Teams to load (it's slow):

```
mcp__playwright__browser_wait_for: 5 seconds
```

Read the accessibility snapshot. Note:
- Unread chat count (from "Chat" button badge)
- Activity count (from "Activity" button badge)
- Which chat is currently open and recent messages
- Any @mentions visible

Do NOT attempt to read every chat — just note the unread count and any visible messages. The user will check Teams themselves if needed.

**1d. Query Jira Sprint Board**

Query the current active sprint for Jerry's tickets only (assigned directly or via subtask):

```
mcp__plugin_atlassian_atlassian__searchJiraIssuesUsingJql:
  jql: "project = DW AND sprint in openSprints() AND (assignee = '6311147956010c40d446d505' OR assignee = currentUser() OR issue in subtaskIssuesOf('assignee = \"6311147956010c40d446d505\"')) ORDER BY priority DESC, status ASC"
```

If the subtask query fails, fall back to:

```
  jql: "project = DW AND sprint in openSprints() AND assignee = '6311147956010c40d446d505' ORDER BY priority DESC, status ASC"
```

For each ticket, note:
- Key, summary, status, story points
- Blocker links (blocked by / blocks)
- Parent ticket (if subtask)

Group tickets by status: To Do, In Progress, In Review, Done.

**1e. Read Last Recap**

Find and read the most recent `Recap_*.md` file in:

```
C:\CTDW Repository\Wellsky\Daily\
```

Sort by filename date descending (files use `Recap_M-DD-YY.md` or `Recap_M-D-YY.md` format). Extract:
- Priority queue for next session
- Outstanding/not done items
- Blocked items and why
- Key decisions that carry forward

**1f. Read Potential Work Tracker**

```
Read: C:\CTDW Repository\Wellsky\Potential Work Tracker.md
```

Check for items in the "Ready to Create" section that should become Jira tickets today.

**1g. Check Git State**

Check each submodule for unpushed or uncommitted work:

```bash
# From monorepo root
git submodule foreach 'echo "=== $name ===" && git status --short && git log --oneline @{upstream}..HEAD 2>/dev/null || echo "no upstream"'
```

Flag:
- Uncommitted changes (risk of lost work)
- Unpushed branches (work not visible to team)
- Branches from handoff that were noted as "NOT pushed"

**1h. Load Sprint Plans**

Check for an active sprint folder and load story-level plans:

```
Glob: C:\CTDW Repository\Wellsky\Sprints\Sprint *\sprint-plan.md
```

If found, read the most recent sprint plan. Then load all story plans:

```
Glob: C:\CTDW Repository\Wellsky\Sprints\Sprint *\DW-*\plan.md
```

For each story plan:
- Identify steps marked as complete vs remaining
- Identify steps owned by "Claude" or "Claude (agent)" that are ready to dispatch
- Cross-reference step dependencies — which steps are unblocked now?
- Note any steps blocked on human action or external decisions

This feeds directly into Phase 3's subagent task identification and the auto-dispatch rule in the monorepo CLAUDE.md.

### Phase 2: Clarify (using AskUserQuestion)

Present a brief summary of what was gathered, then ask targeted questions using the `AskUserQuestion` tool. Only ask what cannot be inferred — do NOT use a generic checklist.

**Use AskUserQuestion for ALL clarification.** This gives the user a structured UI with selectable options instead of free-text typing. Batch up to 4 related questions per AskUserQuestion call. Each question MUST have 2–4 predefined options (the tool adds "Other" automatically for free-text input).

**Cross-reference to generate questions:**

Before asking anything, silently build questions from these categories. Not all categories will produce questions — skip any that don't apply today.

1. **Overnight changes** (always first):
   - Present a brief text summary of notable emails and Teams activity from Phase 1b/1c.
   - Then ask via AskUserQuestion:

   ```
   AskUserQuestion:
     question: "Anything else come in overnight that shifts priorities?"
     header: "Priority"
     options:
       - label: "No changes"
         description: "Proceed with current sprint priorities"
       - label: "Yes, minor"
         description: "Something came in but doesn't change the plan much"
       - label: "Yes, major"
         description: "New priority that should jump the queue"
     multiSelect: false
   ```

2. **Team availability vs. blockers**: Cross-reference Jira ticket assignees against calendar PTO indicators and handoff blocked items. For each team member who appears to be out, ask about affected tickets:

   ```
   AskUserQuestion:
     question: "[Name] appears to be on PTO. DW-XXXXX depends on them — status?"
     header: "Blocker"
     options:
       - label: "Still blocked"
         description: "Can't proceed without them"
       - label: "Can work around"
         description: "I can make progress independently"
       - label: "Already resolved"
         description: "This was handled before today"
     multiSelect: false
   ```

3. **Blocker updates**: For items marked blocked in the handoff that weren't already addressed:

   ```
   AskUserQuestion:
     question: "Has anything changed on [blocked item] since last session?"
     header: "Blocker"
     options:
       - label: "Still blocked"
         description: "No change"
       - label: "Unblocked"
         description: "Can proceed now"
       - label: "Partially unblocked"
         description: "Some progress but not fully clear"
     multiSelect: false
   ```

4. **Unclear meetings**: For meetings that could generate new work or affect priorities (skip obvious ones like standup):

   ```
   AskUserQuestion:
     question: "[Meeting name] at [time] — could this generate new work?"
     header: "Meetings"
     options:
       - label: "No impact"
         description: "Status update / listen-only"
       - label: "Possible new work"
         description: "Could generate follow-up tasks"
       - label: "Will change priorities"
         description: "Expect significant new direction"
     multiSelect: false
   ```

5. **Potential work items**: If "Ready to Create" items exist:

   ```
   AskUserQuestion:
     question: "Ready to Create items exist in the work tracker. Create Jira tickets today?"
     header: "Backlog"
     options:
       - label: "Yes, create today"
         description: "Turn these into Jira tickets now"
       - label: "Defer"
         description: "Not this sprint"
       - label: "Let me pick"
         description: "I'll tell you which ones"
     multiSelect: false
   ```

**Batching rules:**

- Combine up to 4 questions into a single AskUserQuestion call when they are independent (e.g., overnight changes + 2 blocker questions + 1 meeting question).
- If there are more than 4 questions, use multiple AskUserQuestion calls sequentially.
- After all questions are answered, say: "Building the plan now." Then proceed to Phase 3.

**Adaptive behavior:**

- If an earlier answer resolves a later question (e.g., user selected "Other" and typed something that covers a blocker), skip the redundant question.
- If an answer reveals a NEW concern (e.g., user selected "Yes, major" for overnight changes and typed details), factor that into Phase 3 priorities directly — don't ask a follow-up question about it.

### Phase 3: Build Plan (output + saved)

After clarification, produce the daily plan.

**Subagent work identification:**

Before finalizing the plan, review three sources for work that can be delegated to subagents:

1. **Sprint story plans** (from Phase 1f) — Steps marked as "Claude" or "Claude (agent)" that are unblocked
2. **Priority queue tickets** — Ad-hoc work not covered by a plan
3. **Parked/blocked items** — Research tasks that could unblock them

Per the auto-dispatch rule in CLAUDE.md: when a story has a plan with steps marked as "Claude" or "Claude (agent)", **dispatch those steps as background agents immediately without asking permission**. Only present human-required steps to the user for their attention.

Look for:

| Work Type | Example | Subagent Approach |
|:----------|:--------|:------------------|
| Research | "Investigate options for X" | `Agent` with explore subagent to research codebase, docs, or patterns |
| Code analysis | "Find all references to field X" | `Agent` to grep/glob across repos and summarize findings |
| Impact assessment | "What breaks if we change table Y?" | `Agent` to trace dependencies across Dataform → Looker |
| Draft implementation | "Add new dimension to view" | `Agent` to draft LookML or SQLX changes for review |
| Jira research | "Check clone chain for deploy ticket" | `Agent` with Atlassian MCP to trace ticket relationships |
| Documentation | "Document the pattern we used for X" | `Agent` to draft vault or docs content |
| Test planning | "What should we test for this change?" | `Agent` to analyze change scope and draft test plan |

**Key principle:** Subagent work should be **non-blocking** — things that can run in parallel while the user focuses on interactive/creative work. Never delegate work that requires user decisions mid-stream.

For each identified subagent task, note:
- Which ticket it supports
- What specifically the subagent should do
- What output to expect (file, summary, draft code)
- Whether it should run immediately or wait for a dependency

**Plan structure:**

```markdown
---
date: YYYY-MM-DD
sprint: [number]
available_hours: [calculated from calendar]
---

# Daily Plan — M/DD/YYYY

## Available Time
- Work day: [start] - [end]
- Meetings: [count] ([total hours])
- Available for dev work: ~[X]h

## Inbox & Comms
- Unread emails: [count focused] / [count other]
- Notable: [any emails that affect priorities — meeting invites, stakeholder requests, etc.]
- Teams: [unread count] unread chats, [activity count] activities

## Priority Queue

1. **[ticket]** — [summary] ([estimated effort])
   - What: [specific tasks]
   - Why first: [reasoning]

2. **[ticket]** — [summary] ([estimated effort])
   - What: [specific tasks]

3. ...

## Subagent Tasks

Work that can be dispatched to subagents while you focus on priority items.

### Ready to Dispatch (no dependencies)
- [ ] **[ticket]**: [task description] → Expected output: [what the subagent produces]
- [ ] **[ticket]**: [task description] → Expected output: [file/summary/draft]

### Dispatch After [dependency]
- [ ] **[ticket]**: [task description] (after [what must happen first])

## Parked (Blocked)
- **[ticket]** — [reason] (blocked on [who/what])

## Potential Work Items
- [items from tracker, if any]

## Carry Forward from Last Session
- [any unfinished items not in today's priority queue]
```

**Save the plan:**

```
Write: C:\CTDW Repository\Wellsky\Daily\Plan_<date>.md
```

Use `M-D-YY` format (e.g., `5-7-26` for May 7, 2026) — no leading zeros.

**Also output the plan in conversation** so the user can discuss and adjust before starting work.

### Phase 4: Adjust and Dispatch (if needed)

If the user wants to reorder priorities, add/remove items, or adjust estimates:
- Update the plan in conversation
- Overwrite the saved plan file with the adjusted version
- Confirm the final plan

After the plan is confirmed, ask:

> "Want me to dispatch any of the subagent tasks now?"

If yes, launch the "Ready to Dispatch" tasks using the Agent tool. Each subagent should:
- Have a clear, scoped prompt describing exactly what to produce
- Save output to `docs/thoughts/` or present in conversation (depending on output type)
- Not require user interaction mid-run

The user can then work on priority item 1 while subagents run in parallel.

## Team Reference

Use the team table in the monorepo CLAUDE.md for:
- Mapping Jira assignees to names
- Identifying team members in calendar PTO blocks
- Account IDs for any Jira queries

## File Locations

| File | Path |
|:-----|:-----|
| Daily plan | `C:\CTDW Repository\Wellsky\Daily\Plan_<date>.md` |
| Last recap | `C:\CTDW Repository\Wellsky\Daily\Recap_<date>.md` (most recent by date) |
| Potential Work | `C:\CTDW Repository\Wellsky\Potential Work Tracker.md` |
| Sprint plan | `C:\CTDW Repository\Wellsky\Sprints\Sprint {N}\sprint-plan.md` |
| Story plans | `C:\CTDW Repository\Wellsky\Sprints\Sprint {N}\DW-XXXXX\plan.md` |
| Calendar fallback | `C:\CTDW Repository\Wellsky\Daily\Calendar_<date>.png` (only if Playwright unavailable) |

## M365 URLs

| Service | URL |
|:--------|:----|
| Outlook Calendar | `https://outlook.office365.com/calendar/view/day` |
| Outlook Inbox | `https://outlook.office365.com/mail/` |
| Teams | `https://teams.microsoft.com` |

## Recurring Meetings Reference

Known recurring meetings and their significance:

| Meeting | Schedule | Purpose | Work Impact |
|:--------|:---------|:--------|:------------|
| Team Rangers Daily Scrum | Daily | Standup | Low — status update only |
| Data Integration / DW Daily | M, T, Th, F | Catch-all: scrum ceremonies, KT, code review | Variable — keeps calendar clear for ad-hoc needs |
| Review the V2 Looker Dashboards for CM | As scheduled | UAT review with Lynch Bennett | High — generates UAT feedback (DW-31194/31195) |

Update this table as new recurring meetings are identified.

### Meeting Work Rules

- **Focus-required meetings** (hosting, actively participating): Count as unavailable time. Examples: standup, 1:1s, code review, UAT review.
- **Listen-only meetings** (attend but not hosting/participating): Work continues during these. Do NOT subtract from available hours. User works through these on a separate monitor.

## Edge Cases

- **Playwright auth expired**: If Outlook shows a login page instead of inbox/calendar, tell the user their M365 session expired. They need to sign in manually in the Playwright browser window (it will pop up), then say "done" so you can retry.
- **Teams slow to load**: Teams can take 5-10 seconds. If the snapshot shows only a progressbar, wait and retry once. If still empty, skip Teams and note it in the plan.
- **Calendar screenshot fallback**: If Playwright is unavailable (MCP not configured), fall back to reading a calendar screenshot from `C:\CTDW Repository\Wellsky\Daily\Calendar_<date>.png`. Try date formats: `M-D-YY`, `M-DD-YY`, `MM-DD-YY`. If no screenshot exists either, ask the user to either fix Playwright or drop a screenshot.
- **No handoff file**: This is the first session. Skip handoff context, note it in the plan.
- **No active sprint**: Query recent tickets without sprint filter, warn user.
- **Multiple calendars needed**: If user mentions needing a team calendar view, navigate to the work week view in Playwright to see overlapping schedules.
