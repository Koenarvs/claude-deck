---
name: goodnight
description: Session close-out — capture state, log time, update Jira
---

# Good Night — Session Close-Out Skill

Captures session state, optionally logs time and updates Jira. Handles both end-of-shift and mid-day context clears.

## Usage

When user runs `/goodnight`, follow the workflow below.

## Output Files

| Mode | Output | Location | Filename |
|:-----|:-------|:---------|:---------|
| **End of shift** | Recap | `Wellsky/Daily/` | `Recap_M-DD-YY.md` |
| **Mid-day** | Handoff | `Wellsky/Handoffs/` | `YYYY-MM-DD_midday-N.md` |

- **Recap** (end of shift): Concise daily summary — time logged, accomplishments, what's left, tomorrow's priorities. Lives alongside the morning plan.
- **Handoff** (mid-day): Detailed context transfer for the next session — git state, outstanding work, decisions. Used by `/goodmorning` to resume.

## Workflow

### Step 0: Determine Mode

```
AskUserQuestion:
  question: "End of shift or mid-day handoff?"
  header: "Mode"
  options:
    - label: "End of shift"
      description: "Full close-out: recap, time logging, Jira updates, memory"
    - label: "Mid-day handoff"
      description: "Lightweight: handoff doc only, skip time/Jira/memory"
  multiSelect: false
```

### Phase 1: Gather Context (automated, silent)

Collect all context silently. Use parallel tool calls where possible.

**1a. Read Today's Plan**

```
Read: C:\CTDW Repository\Wellsky\Daily\Plan_M-DD-YY.md
```

If no plan exists (skill wasn't used this morning or /goodmorning wasn't run), note it and proceed without plan-vs-actual comparison.

**1b. Git Activity This Session**

Scan all submodules for today's work:

```bash
# Commits made today across submodules
git submodule foreach 'echo "=== $name ===" && git log --oneline --since="midnight" && echo "--- unpushed ---" && git log --oneline @{upstream}..HEAD 2>/dev/null && echo "--- uncommitted ---" && git status --short'
```

Capture:
- Commits made today (grouped by submodule and ticket)
- Unpushed branches (flag these prominently — risk of lost work)
- Uncommitted changes — **list every modified/untracked file with its path** (flag these even more prominently)

Also check Claude-Deck (`C:\Claude-Deck`) separately — it's not a submodule:

```bash
echo "=== Claude-Deck ===" && git -C /c/Claude-Deck log --oneline --since="midnight" 2>/dev/null && echo "--- unpushed ---" && git -C /c/Claude-Deck log --oneline @{upstream}..HEAD 2>/dev/null && echo "--- uncommitted ---" && git -C /c/Claude-Deck status --short 2>/dev/null
```

**Work completion classification** — for each ticket worked on today, categorize as:
- **Human-Verified**: Human reviewed the output, tested it, confirmed it works
- **Agent Output — Needs Validation**: Agent was dispatched and produced output (commits, files, research docs), but human has NOT reviewed or tested it yet
- **In Progress**: Work started but not finished

This classification drives which section of the output document each ticket lands in. Agent-dispatched work that has not been human-validated MUST go in "Agent Output — Needs Validation", never in "Accomplishments" or "What Was Done".

**1c. Jira Sprint State**

```
mcp__plugin_atlassian_atlassian__searchJiraIssuesUsingJql:
  jql: "project = DW AND sprint in openSprints() ORDER BY priority DESC, status ASC"
```

Note current statuses to compare against morning plan.

**1d. Check for Existing Mid-Day Handoffs**

If mode is mid-day, check how many mid-day handoffs exist for today:

```
Glob: C:\CTDW Repository\Wellsky\Handoffs\*midday*.md
```

Filter to today's date to determine the next sequence number.

### Phase 2: Clarify (using AskUserQuestion)

**Use AskUserQuestion for ALL clarification.** Batch up to 4 related questions per call. Each question MUST have 2–4 predefined options (the tool adds "Other" automatically for free-text input).

Before asking anything, silently build questions from the categories below. Not all will apply every session — skip any that don't.

**Both modes — first batch (up to 4 questions):**

1. **Deviation check** (only if a plan exists AND there's a significant deviation — worked on something not in the plan, skipped a planned item): Skip entirely if activity roughly matches the plan.

   ```
   AskUserQuestion:
     question: "Plan had [X] as priority 1, but most time went to [Y]. What drove the change?"
     header: "Deviation"
     options:
       - label: "Planned pivot"
         description: "Intentional reprioritization during the day"
       - label: "Unplanned blocker"
         description: "Got stuck on something and shifted focus"
       - label: "External request"
         description: "Someone asked me to work on something else"
     multiSelect: false
   ```

2. **Non-commit work**:

   ```
   AskUserQuestion:
     question: "Anything this session not captured in commits? (meetings, research, Slack, debugging)"
     header: "Non-code"
     options:
       - label: "Nothing extra"
         description: "Commits capture everything"
       - label: "Meetings only"
         description: "Just the scheduled meetings, no other non-code work"
       - label: "Yes, other work"
         description: "I'll describe what else I worked on"
     multiSelect: false
   ```

3. **New blockers**:

   ```
   AskUserQuestion:
     question: "Anything blocked now that wasn't blocked at session start?"
     header: "Blockers"
     options:
       - label: "No new blockers"
         description: "Same as this morning"
       - label: "Yes, new blocker"
         description: "Something got stuck during the session"
     multiSelect: false
   ```

4. **Potential work tracker**:

   ```
   AskUserQuestion:
     question: "Any new items for the Potential Work Tracker?"
     header: "Backlog"
     options:
       - label: "Nothing new"
         description: "No new work items identified"
       - label: "Yes, new items"
         description: "I'll describe what came up"
     multiSelect: false
   ```

5. **Uncommitted changes** (only if uncommitted/untracked files were found in Phase 1b): Present the full file list, then ask:

   ```
   AskUserQuestion:
     question: "Uncommitted changes found — [N] files in [repo]. [list files]. Commit now?"
     header: "Uncommitted"
     options:
       - label: "Commit now"
         description: "Stage and commit these changes with a message"
       - label: "Leave uncommitted"
         description: "I'll handle this manually later"
       - label: "Some of them"
         description: "I'll tell you which files to commit"
     multiSelect: false
   ```

   If "Commit now": ask for a commit message (or suggest one based on context), stage the files, and commit. If "Some of them": ask which files, then commit only those. If multiple repos have uncommitted work, ask per-repo.

   Repeat for unpushed branches:

   ```
   AskUserQuestion:
     question: "Unpushed branch [branch] in [repo] — [N] commits ahead. Push now?"
     header: "Unpushed"
     options:
       - label: "Push now"
         description: "Push to remote"
       - label: "Leave unpushed"
         description: "I'll push manually later"
     multiSelect: false
   ```

**End of shift only — second batch (after first batch answers):**

6. **Time logging**: Present inferred time breakdown as text summary, then confirm:

   ```
   AskUserQuestion:
     question: "Time breakdown looks right? [show summary in question text]"
     header: "Time"
     options:
       - label: "Looks good"
         description: "Log these times to Jira"
       - label: "Needs adjustment"
         description: "I'll tell you what to change"
     multiSelect: false
   ```

7. **Jira status**: Present tickets worked on with current status and suggested transitions:

   ```
   AskUserQuestion:
     question: "Jira status updates — confirm suggested transitions?"
     header: "Jira"
     options:
       - label: "All correct"
         description: "Apply all suggested transitions"
       - label: "Some changes"
         description: "I'll tell you which ones to adjust"
       - label: "Skip transitions"
         description: "Don't change any ticket statuses today"
     multiSelect: false
   ```

**Batching rules:**

- Batch questions 1–4 into one AskUserQuestion call (they're independent).
- Question 5 (uncommitted changes) runs after the first batch — only if uncommitted files were found.
- For end of shift, batch questions 6–7 into a second call after presenting the time/Jira summary text.
- If an earlier answer resolves a later question (e.g., user described non-commit work that also covers blockers), skip the redundant question.

After all questions are answered, say: "That's everything I needed." Then proceed to the next phase.

### Phase 3: Time Logging (end of shift only)

**CRITICAL CONSTRAINT: Total logged time MUST NOT exceed actual hours worked.**

Calculate the time budget:
1. Determine session start time (from first git commit, or ask if unclear)
2. Determine session end time (now)
3. Subtract meetings (from today's plan or calendar image)
4. Subtract lunch/breaks (ask if not clear — do NOT assume)
5. Result = maximum billable dev hours

**Inference approach:**
- Use git commit timestamps to estimate time per ticket
- Use conversation context to fill gaps (research, meetings, debugging)
- Round to nearest 15 minutes
- Present breakdown as a text summary, then use the AskUserQuestion from Phase 2 question 5 to confirm. Include the full breakdown in the question text so the user can see it in the UI.

**After confirmation, post worklogs to Jira:**

```
mcp__plugin_atlassian_atlassian__addWorklogToJiraIssue:
  issueIdOrKey: "DW-XXXXX"
  timeSpent: "Xh Ym"
  comment: "Brief description of work done"
```

Post one worklog per ticket. Include a brief comment summarizing what was done on that ticket.

### Phase 4: Jira Status Updates (end of shift only)

For each ticket the user confirmed should transition:

```
mcp__plugin_atlassian_atlassian__getTransitionsForJiraIssue:
  issueIdOrKey: "DW-XXXXX"
```

Then:

```
mcp__plugin_atlassian_atlassian__transitionJiraIssue:
  issueIdOrKey: "DW-XXXXX"
  transitionId: "<appropriate transition>"
```

### Phase 5: Generate Output Document

#### End of Shift — Recap

Save to: `C:\CTDW Repository\Wellsky\Daily\Recap_M-DD-YY.md`

```markdown
---
date: YYYY-MM-DD
sprint: NNN
total_hours: Xh XXm
---

# Daily Recap — M/DD/YYYY

## Time Logged

| Story | Time | Description |
|-------|------|-------------|
| DW-XXXXX | Xh XXm | Brief description |
| **Total** | **Xh XXm** | |

## Accomplishments (Human-Verified)

### [Ticket] — [Summary] (Xh XXm)

- [Bullet points of what was done]
- [Key outcomes, files changed, deployments]

## Agent Output — Needs Validation

_Work dispatched to agents this session. Output exists but has NOT been reviewed or tested by a human._

- **[Ticket]**: [what the agent produced] — Output at: [file/branch/commit]

## Not Done Today

- [Ticket]: [Why deferred]

## Blocked

- **[ticket]** — [what's blocked and on whom]
```

#### Mid-Day — Handoff

Save to: `C:\CTDW Repository\Wellsky\Handoffs\YYYY-MM-DD_midday-N.md`

```markdown
---
tags: [handoff, sprint-NNN, <relevant-tags>]
date: YYYY-MM-DD
sprint: NNN
mode: midday-N
---

# Sprint NNN Mid-Day N Handoff — YYYY-MM-DD

## Session Summary

[1-2 sentence summary of what this session accomplished]

## Git State

### [Submodule name]

**Branch**: `branch-name` ([N] commits, [pushed/NOT pushed])

Commits this session:
1. `sha` — message
2. ...

**Uncommitted changes**: [list or "none"]

## What Was Done (Human-Verified)

### [Ticket] — [Summary]

- [Bullet points of what was done]
- [Specific files/dashboards/views changed]

## Agent Output — Needs Validation

_Work dispatched to agents this session. Output exists but has NOT been reviewed or tested by a human._

- **[Ticket]**: [what the agent produced] — Output at: [file/branch/commit]

## Outstanding / Not Done

### [Ticket] — [What Remains]
- [Specific remaining tasks]

## Blocked Items

- **[ticket]** — [what's blocked and on whom]

## Key Decisions Made This Session

- [Decision and rationale, if any were made]
```

### Phase 6: Confirm and Save

1. Show the document in conversation
2. Confirm via AskUserQuestion:

   ```
   AskUserQuestion:
     question: "Anything to adjust before I save?"
     header: "Save"
     options:
       - label: "Save as-is"
         description: "Looks good, save it"
       - label: "Needs edits"
         description: "I'll tell you what to change"
     multiSelect: false
   ```

3. If "Needs edits", apply changes and re-confirm. If "Save as-is", save to the appropriate location.

### Phase 7: Memory Updates (end of shift only)

Update these files if anything changed during the session:

1. **MEMORY.md** — Update sprint status table with current ticket states
2. **Potential Work Tracker** — Add any new items identified in Phase 2
3. **Vault topic files** — Update if new patterns, decisions, or playbooks emerged

Do NOT update memory for mid-day handoffs — save that for end of shift.

## Edge Cases

- **No plan file exists**: Skip plan-vs-actual comparison. Note in handoff that no morning plan was created.
- **No commits today**: Session may have been meetings/research only. Ask what was done and log time accordingly.
- **Multiple mid-day clears**: Each gets its own numbered handoff. The next session's `/goodmorning` reads the most recent one.
- **End of shift after mid-day clear**: The end-of-shift handoff covers the FULL day, not just since the last mid-day clear. Reference earlier mid-day handoffs for completeness. Time logging covers the full day (subtract any time already logged in earlier mid-day handoffs if they logged time — but mid-day handoffs should NOT log time, so this shouldn't happen).
- **User says "end of shift" but it's 2 PM**: Don't question it. They might be leaving early, switching projects, etc. Run the full close-out.
- **Uncommitted or unpushed work**: Flag prominently in the handoff AND warn the user before closing out. Offer to push unpushed branches. Do NOT offer to commit uncommitted work without understanding what it is.

## File Locations

| File | Path |
|:-----|:-----|
| Today's plan | `C:\CTDW Repository\Wellsky\Daily\Plan_M-DD-YY.md` |
| Handoffs | `C:\CTDW Repository\Wellsky\Handoffs\` |
| Potential Work | `C:\CTDW Repository\Wellsky\Potential Work Tracker.md` |
| Memory | `C:\Users\jerry.spangler\.claude\projects\C--CTDW-Repository-cpt-dwdi\memory\MEMORY.md` |
