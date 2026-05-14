---
name: sprint-close
description: Sprint close-out — transition tickets, roll incomplete work, generate summary
type: workflow
tags: [sprint, planning, jira]
---

# Sprint Close — Sprint Close-Out Skill

Automates end-of-sprint close-out: reviews sprint state, transitions completed tickets, rolls incomplete work to the next sprint, and generates a sprint summary.

## Usage

When user runs `/sprint-close`, follow the workflow below.

## Config Preamble

**Before doing anything else**, run the config check described in `.claude/skills/resources/config-preamble.md`. If no config exists, run first-use setup. All paths and Jira values below use config references — resolve them from `~/.claude/skills-config.yaml`.

## Prerequisites

- Atlassian MCP plugin available
- User's Jira account ID is known (from config `jira.account_id`)

## Workflow

### Phase 0: Config Check

Run the standard config preamble. If no config exists, run first-use setup before proceeding.

### Phase 1: Gather Sprint State (automated, no questions)

Collect all context silently. Use parallel tool calls where possible.

**1a. Identify Current Sprint**

Query the active sprint to get its name, number, and date range:

```
mcp__plugin_atlassian_atlassian__searchJiraIssuesUsingJql:
  jql: "project = {jira.project_key} AND sprint in openSprints() AND assignee = '{jira.account_id}' ORDER BY status ASC, priority DESC"
  fields: ["summary", "status", "issuetype", "parent", "{jira.custom_fields.story_points}", "{jira.custom_fields.sprint}", "assignee", "subtasks"]
```

Extract from the results:
- Sprint name and number (from `{jira.custom_fields.sprint}`)
- Sprint start/end dates
- All tickets in the sprint

**1b. Classify Tickets**

Group all tickets by status into four buckets:

| Bucket | Statuses |
|:-------|:---------|
| Done | Done, Closed, Resolved |
| In Progress | In Progress, In Review, In Development |
| To Do | Open, To Do, Backlog |
| Blocked | Any ticket with a "Blocked" flag or blocker link |

For each ticket, capture:
- Key, summary, status, issue type
- Story points (`{jira.custom_fields.story_points}`)
- Assignee
- Subtask count and how many are Done vs open
- Parent (if subtask)

**1c. Calculate Sprint Metrics**

- Total stories planned (count)
- Total points planned (sum of `{jira.custom_fields.story_points}`)
- Stories completed (Done bucket count)
- Points completed (Done bucket points sum)
- Stories incomplete (all other buckets count)
- Points remaining (all other buckets points sum)
- Completion rate: points completed / points planned (as percentage)

**1d. Read Sprint Plan**

Check for an existing sprint plan:

```
Read: {vault_path}/{directories.sprints}/Sprint {N}/{filenames.sprint_plan}
```

If it exists, cross-reference planned stories against actual results. Note any stories that were added mid-sprint (in Jira but not in the plan) or removed (in plan but not in Jira).

**1e. Check Git State**

Check for unpushed branches related to open stories:

```bash
# From monorepo root
git submodule foreach 'echo "=== $name ===" && git branch --list "dw-*" | while read b; do echo "$b: $(git log --oneline $b --not --remotes -1 2>/dev/null || echo "up to date")"; done'
```

Flag any branches with unpushed commits for stories that are about to be closed or rolled.

### Phase 2: Review and Decide (sequential Q&A)

Present the sprint summary, then ask questions **one at a time**.

**Question 1: Sprint Overview Confirmation**

```
Sprint {N} Summary:

| Status | Stories | Points |
|--------|---------|--------|
| Done | {X} | {Y} |
| In Progress | {A} | {B} |
| To Do | {C} | {D} |
| Blocked | {E} | {F} |
| **Total** | **{G}** | **{H}** |

Completion: {Y}/{H} points ({pct}%)

{if mid-sprint additions or removals detected}
Note: {count} stories were added/removed mid-sprint compared to the sprint plan.
{/if}

{if unpushed branches detected}
Warning: Unpushed branches found for: {ticket list}
{/if}

Ready to proceed with close-out?

1) Yes, let's close it out
2) Wait, I need to update some tickets first
3) Let's discuss
```

If option 2: Pause and let the user make their updates. When they say they're ready, re-query Jira and refresh the sprint state before continuing.

**Question 2: Incomplete Story Decisions (one per story)**

For each story in the In Progress, To Do, or Blocked buckets, ask:

```
{ticket_key} — {summary} ({status}, {points} pts)
{if has subtasks}Subtasks: {done_count}/{total_count} done{/if}

What should we do with this story?

1) Roll to next sprint (keep current status)
2) Close it (work is done, just needs transition)
3) Split it (create new story for remaining work, close this one)
4) Remove from sprint (descope, stays in backlog)
5) Let's discuss
```

If option 3 (Split): Ask a follow-up question:

```
What's the remaining scope for the new story? I'll create a new story linked to {ticket_key}.

1) Use the same summary with "- Remaining" appended
2) Enter a custom summary and description
3) Let's discuss
```

Store each decision for Phase 3 execution.

**Question 3: Status/Points Corrections**

```
Any stories that need their status or points updated before closing?

1) No, everything looks correct
2) Yes, let me specify changes
3) Let's discuss
```

If option 2: Ask for each correction one at a time:

```
Which ticket needs updating? Enter the ticket key (e.g., DW-XXXXX), or "done" when finished.
```

For each ticket:

```
What needs to change on {ticket_key}?

1) Update story points (enter new value)
2) Update status
3) Both
4) Let's discuss
```

Apply corrections via `editJiraIssue` before proceeding.

### Phase 3: Execute Close-Out (automated with confirmation)

Based on Phase 2 decisions, build the execution plan and present it for confirmation before executing anything.

**3a. Present Execution Plan**

```
Here's what I'm about to do:

**Close ({X} stories):**
{for each story to close}
- {ticket_key}: {summary} ({points} pts) — transition {transition_id}
  {if has open subtasks}Also close {count} subtasks{/if}
{/for}

**Roll to next sprint ({Y} stories):**
{for each story to roll}
- {ticket_key}: {summary} ({points} pts) — move to Sprint {N+1}
{/for}

{if any splits}
**Split ({Z} stories):**
{for each story to split}
- {ticket_key}: Close original, create "{new_summary}" ({points} pts) in Sprint {N+1}
{/for}
{/if}

{if any removals}
**Remove from sprint ({W} stories):**
{for each story to remove}
- {ticket_key}: {summary} — clear sprint assignment
{/for}
{/if}

Proceed?

1) Yes, execute all
2) Wait, let me change something
3) Let's discuss
```

If option 2: Loop back to the relevant Phase 2 question.

**3b. Close Completed Stories**

For each story marked for closing:

1. **Close subtasks first** (if any open subtasks exist):

   ```
   mcp__plugin_atlassian_atlassian__transitionJiraIssue:
     issueIdOrKey: "{subtask_key}"
     transitionId: "41"
   ```

2. **Close the parent story**:

   Stories use transition `441` with resolution:

   ```
   mcp__plugin_atlassian_atlassian__transitionJiraIssue:
     issueIdOrKey: "{story_key}"
     transitionId: "441"
     fields: {"resolution": {"name": "Done"}}
   ```

   If the issue type is NOT a Story (e.g., Bug, Task), try transition `441` first. If it fails, fall back to transition `41`.

3. **Report progress** as each ticket is closed:

   ```
   Closed {ticket_key} ({summary}) -- {N} of {total}
   ```

**3c. Roll Incomplete Stories**

For each story marked for rolling:

1. **Find or identify the next sprint** (Sprint {N+1}):

   Query Jira for the next sprint. Use the sprint name pattern from config with `{N+1}`:

   ```
   mcp__plugin_atlassian_atlassian__searchJiraIssuesUsingJql:
     jql: "project = {jira.project_key} AND sprint = '{next_sprint_name}'"
   ```

   If the next sprint doesn't exist yet, warn the user:

   ```
   Sprint {N+1} doesn't exist yet in Jira. I can still roll these stories, but you may need to create the sprint first.

   1) I'll create the sprint in Jira now, then continue
   2) Skip rolling for now — I'll handle it manually
   3) Let's discuss
   ```

2. **Move the story** by updating the sprint field:

   ```
   mcp__plugin_atlassian_atlassian__editJiraIssue:
     issueIdOrKey: "{story_key}"
     fields: {"{jira.custom_fields.sprint}": {next_sprint_id}}
   ```

**3d. Split Stories**

For each story marked for splitting:

1. **Create the new story** in the next sprint:

   ```
   mcp__plugin_atlassian_atlassian__createJiraIssue:
     projectKey: "{jira.project_key}"
     issueTypeName: "Story"
     summary: "{new_summary}"
     description: "Continuation of {original_key}.\n\n{description if provided}"
     assignee_account_id: "{jira.account_id}"
   ```

2. **Link the new story to the original**:

   ```
   mcp__plugin_atlassian_atlassian__createIssueLink:
     type: "Relates"
     inwardIssue: "{new_key}"
     outwardIssue: "{original_key}"
   ```

3. **Set story points on the new story** (ask the user):

   ```
   How many points for the new story {new_key} ({new_summary})?

   1) Same as original ({original_points} pts)
   2) Enter a different value
   3) Let's discuss
   ```

   ```
   mcp__plugin_atlassian_atlassian__editJiraIssue:
     issueIdOrKey: "{new_key}"
     fields: {"{jira.custom_fields.story_points}": {points}}
   ```

4. **Close the original story** using the same transition logic as 3b.

5. **Move the new story to the next sprint** using the same logic as 3c.

**3e. Remove from Sprint**

For each story marked for removal:

Clear the sprint field (move back to backlog):

```
mcp__plugin_atlassian_atlassian__editJiraIssue:
  issueIdOrKey: "{story_key}"
  fields: {"{jira.custom_fields.sprint}": null}
```

### Phase 4: Generate Sprint Summary

Create a summary document at:

```
{vault_path}/{directories.sprints}/Sprint {N}/sprint-close-summary.md
```

**Summary document structure:**

```markdown
---
sprint: {N}
sprint_name: "{sprint_name}"
start_date: {start_date}
end_date: {end_date}
closed_by: "{user_name}"
closed_on: {today}
---

# Sprint {N} Close-Out Summary

## Velocity

| Metric | Value |
|--------|-------|
| Stories Planned | {total_stories} |
| Stories Completed | {done_count} |
| Points Planned | {total_points} |
| Points Completed | {done_points} |
| Completion Rate | {pct}% |

## Stories Completed

| Key | Summary | Points | Assignee |
|-----|---------|--------|----------|
{for each completed story}
| {key} | {summary} | {points} | {assignee} |
{/for}

## Stories Rolled to Sprint {N+1}

| Key | Summary | Points | Status | Reason |
|-----|---------|--------|--------|--------|
{for each rolled story}
| {key} | {summary} | {points} | {status} | Rolled (incomplete) |
{/for}

{if any splits}
## Stories Split

| Original | New Story | Points | Notes |
|----------|-----------|--------|-------|
{for each split story}
| {original_key} | {new_key} | {points} | {summary} |
{/for}
{/if}

{if any removals}
## Stories Removed (Descoped)

| Key | Summary | Points | Reason |
|-----|---------|--------|--------|
{for each removed story}
| {key} | {summary} | {points} | Descoped |
{/for}
{/if}

## Team Contributions

| Member | Stories Closed | Points |
|--------|---------------|--------|
{for each team member with closed stories}
| {name} | {count} | {points} |
{/for}

## Carry-Forward to Sprint {N+1}

{list of rolled and split stories with brief context for next sprint planning}
```

**Also output the summary in conversation** so the user can review it immediately.

### Phase 5: Handoff to Next Sprint

After the summary is generated and displayed, ask:

```
Sprint {N} is closed. Want me to set up Sprint {N+1}?

1) Yes, run /start-sprint now
2) No, I'll do it later
3) Let's discuss
```

If option 1: Invoke the `/start-sprint` skill with the next sprint number (`{N+1}`).

## Team Reference

Use the team table in the monorepo CLAUDE.md for:
- Mapping Jira assignees to names
- Account IDs for any Jira queries
- Identifying team member contributions in the summary

## File Locations

All paths resolve from `~/.claude/skills-config.yaml`:

| File | Config Path |
|:-----|:------------|
| Sprint folder | `{vault_path}/{directories.sprints}/Sprint {N}/` |
| Sprint plan | `{vault_path}/{directories.sprints}/Sprint {N}/{filenames.sprint_plan}` |
| Sprint close summary | `{vault_path}/{directories.sprints}/Sprint {N}/sprint-close-summary.md` |
| Story folders | `{vault_path}/{directories.sprints}/Sprint {N}/{jira.ticket_prefix}-XXXXX/` |

## Edge Cases

- **No active sprint**: Warn the user and ask which sprint to close. Query by sprint name pattern instead of `openSprints()`.
- **All stories already Done**: Skip Phase 2 incomplete story decisions. Go straight to Phase 3 with only close transitions to execute.
- **No config file**: Run first-use setup (Config Preamble) before proceeding.
- **Mixed sprint assignment**: Some tickets may appear in multiple sprints. Only affect the current sprint's assignment — do not alter other sprint memberships.
- **Subtasks with different status than parent**: Flag these for attention during Phase 2. Example: "DW-XXXXX is marked Done but has 2 open subtasks — close the subtasks too?"
- **Transition failures**: If a transition ID fails (e.g., ticket is in an unexpected workflow state), report the error and ask the user how to proceed. Do not retry blindly.
- **Next sprint doesn't exist**: Warn during Phase 3c. The user may need to create it in Jira first.
- **Story points not set**: Include in the metrics as 0 points but flag in the summary as "unpointed".
- **No sprint plan file**: Skip the cross-reference in Phase 1d. Note in the summary that no plan was found.
