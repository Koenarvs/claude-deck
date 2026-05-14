---
name: plan-sprint
description: Sprint planning — research stories via sub-agents, generate implementation plans with human/AI task breakdown
type: workflow
arguments:
  - name: sprint-number
    required: true
    description: "Sprint number (e.g., 247)"
tags: [jira, sprint, planning]
---

# Plan Sprint

Researches each story in the sprint using sub-agents, then generates an implementation plan for each. Plans identify steps toward completion, whether each step is human-reliant or AI-executable, what can be parallelized across agents, and any open questions.

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `sprint-number` | Yes | Sprint number (e.g., 247) |

## Config Preamble

**Before doing anything else**, run the config check described in `.claude/skills/resources/config-preamble.md`. If no config exists, run first-use setup. All paths and Jira values below use config references — resolve them from `~/.claude/skills-config.yaml`.

## Prerequisites

- Atlassian MCP plugin available
- Sprint folder structure exists at `{vault_path}/{directories.sprints}/Sprint {N}/` (created by `/start-sprint`)
- User's Jira account ID is known (from config `jira.account_id`)

## Steps

### Phase 1: Load Sprint Stories

1. **Query Jira for the user's stories** in the specified sprint:

   ```
   mcp__plugin_atlassian_atlassian__searchJiraIssuesUsingJql:
     jql: "project = {jira.project_key} AND sprint = '{jira.sprint_name_pattern}' AND assignee = '{jira.account_id}' AND issuetype = Story ORDER BY priority DESC, status ASC"
     fields: ["summary", "description", "parent", "customfield_10026", "status"]
     maxResults: 30
   ```

   Replace `{jira.sprint_name_pattern}` with the config value, substituting `{N}` with the sprint number. Fallback to `Sprint {N}` if no results.

2. **Present the story list** and ask the user to confirm scope (sequential Q&A):

   ```
   Sprint {N} — {X} stories, {Y} points

   | # | Key | Summary | Pts | Status |
   |---|-----|---------|-----|--------|
   | 1 | {jira.ticket_prefix}-XXXXX | ... | 5 | Open |

   Which stories should I plan?

   1) All of them
   2) Let me pick specific stories
   3) Let's discuss
   ```

   If the user picks option 2, present a follow-up:

   ```
   Enter the story numbers from the list above (e.g., "1, 3, 5") or story keys (e.g., "{jira.ticket_prefix}-XXXXX"):
   ```

   Wait for the user's response before proceeding to Phase 2.

### Phase 2: Research Stories (Sub-Agents)

For each story in scope, dispatch a sub-agent to research the implementation. Launch up to 3 agents in parallel for independent stories.

**Each sub-agent receives:**
- The full Jira story description and acceptance criteria
- Instructions to research the codebase for relevant files, patterns, and dependencies
- Instructions to identify implementation steps

**Sub-agent prompt template:**

```
Research the implementation plan for Jira story {KEY}: "{SUMMARY}"

## Story Description
{DESCRIPTION}

## Instructions

1. Read the story description and acceptance criteria carefully
2. Search the codebase for files, views, dashboards, or patterns relevant to this story
3. Identify dependencies — what must exist or be done before this work can start?
4. Break the work into concrete implementation steps
5. For each step, assess:
   - Can Claude do this autonomously? (code changes, file creation, Jira updates)
   - Does it require human action? (manual testing, UI work, deployment, stakeholder decisions)
   - Can it run in parallel with other steps?
6. Identify open questions — anything ambiguous in the requirements or unclear from the codebase

Report your findings as a structured plan. Be specific about file paths and what changes are needed.
This is RESEARCH ONLY — do not write any code.
```

**Sub-agent type:** `general-purpose` (needs access to Read, Grep, Glob for codebase research)

**Grouping:** If stories touch overlapping areas (same dashboard, same view), research them sequentially to avoid conflicting findings. Otherwise, parallelize.

### Phase 3: Compile and Present Plans (Interactive)

As each sub-agent completes, compile its findings into a plan. Present plans to the user **one story at a time** for discussion.

**Plan format for each story:**

Plans follow the **success criteria → evals → steps** structure. Define what "done" looks like first, then how to verify progress, then the implementation steps.

```markdown
## {jira.ticket_prefix}-XXXXX — {Summary} ({N} pts)

### Success Criteria

Define what "done" looks like from the user's perspective. These are observable outcomes, not implementation details.

- {User-observable outcome 1}
- {User-observable outcome 2}
- {User-observable outcome 3}

### Evals

Checks Claude can run at milestones during implementation. If an eval fails, stop and course-correct.

| After | Eval | Pass Condition |
|-------|------|----------------|
| Step {N} | {What to check} | {Expected result} |
| Step {M} | {What to check} | {Expected result} |

### Steps

| # | Step | Owner | Parallelizable | Eval |
|---|------|-------|----------------|------|
| 1 | {Description} | Claude | Yes | {Which eval to run after} |
| 2 | {Description} | Human | No — depends on #1 | — |
| 3 | {Description} | Claude (agent) | Yes — after #1 | {Which eval to run after} |

### Owner Legend
- **Claude** — Can be done autonomously in the current session (code edits, file creation, Jira updates)
- **Claude (agent)** — Can be delegated to a background sub-agent while you work on other things
- **Human** — Requires your action (manual testing, UI verification, deployment, stakeholder communication, access to systems Claude can't reach)
- **Team** — Requires another team member (code review, deployment approval, access grants)

### Dependencies

- Depends on: {other tickets, deployments, team member actions}
- Blocks: {what this unblocks when done}

### Open Questions

1. {Question about requirements or approach — needs user input}
2. {Ambiguity in the story that should be clarified}

### Key Files

- `path/to/file.lkml` — {what needs to change}
- `path/to/other/file.view.lkml` — {what needs to change}
```

**After presenting each story plan:**
- Ask the user for feedback, corrections, or additional context
- Adjust the plan based on their input
- Move to the next story

### Phase 4: Save Plans

After all stories are reviewed and adjusted, save each plan to the sprint folder:

```
{vault_path}/{directories.sprints}/Sprint {N}/{jira.ticket_prefix}-XXXXX/{filenames.story_plan}
```

**Plan file format:**

```markdown
---
story: {jira.ticket_prefix}-XXXXX
summary: "{Summary}"
points: {N}
sprint: {N}
status: draft
date: YYYY-MM-DD
---

# {jira.ticket_prefix}-XXXXX — {Summary}

## Success Criteria

{User-observable outcomes from Phase 3 discussion}

## Evals

{Milestone checks from Phase 3 discussion}

## Steps

{Implementation steps with eval links from Phase 3 discussion}
```

### Phase 4b: Post Plans to Jira

After saving each plan to disk, also post a summary comment to the corresponding Jira ticket. This ensures the plan is visible to the team directly in Jira, not only in the vault.

For each story, post a comment using:

```
mcp__plugin_atlassian_atlassian__addCommentToJiraIssue:
  issueIdOrKey: "{jira.ticket_prefix}-XXXXX"
  commentBody: "## Implementation Plan\n\n{concise summary of approach, steps, and open questions}"
  contentFormat: "markdown"
```

Keep the Jira comment concise — summarize the approach, list steps with owners, and note open questions. The full plan lives in the vault file; the Jira comment is a pointer and quick reference.

### Phase 5: Sprint Summary

After all story plans are saved, present a sprint-level summary:

```markdown
## Sprint {N} Plan Summary

### Capacity Overview

| Metric | Value |
|--------|-------|
| Stories planned | {X} of {Y} |
| Total points | {Z} |
| Claude-autonomous steps | {A} |
| Human-required steps | {B} |
| Agent-parallelizable steps | {C} |
| Open questions | {D} |

### Execution Order

Recommended order based on dependencies and parallelization opportunities:

1. **Day 1**: Start {jira.ticket_prefix}-XXXXX (steps 1-2), dispatch agents for {jira.ticket_prefix}-YYYYY research
2. **Day 2**: ...

### Open Questions Requiring Resolution

| Story | Question |
|-------|----------|
| {jira.ticket_prefix}-XXXXX | {Question} |
| {jira.ticket_prefix}-YYYYY | {Question} |

### Risk Items

- {Story}: {Risk and mitigation}
```

Save the sprint summary to:

```
{vault_path}/{directories.sprints}/Sprint {N}/{filenames.sprint_plan}
```

## Edge Cases

- **Story has no description**: Flag it. Ask the user to describe the work verbally, then use that for planning.
- **Story already has a plan**: Check if `{vault_path}/{directories.sprints}/Sprint {N}/{jira.ticket_prefix}-XXXXX/{filenames.story_plan}` exists. If so, ask:

  ```
  Plan already exists for {jira.ticket_prefix}-XXXXX — what should I do?

  1) Update it with fresh research
  2) Skip this story
  3) Let's discuss
  ```
- **Sub-agent can't find relevant code**: Note the gap in the plan. The story may involve new development with no existing patterns to reference.
- **Story is blocked**: Note the blocker in the plan. Still plan the work so it's ready when unblocked.
- **No config file**: Run first-use setup (see Config Preamble).
- **Sprint folder doesn't exist**: Create it at `{vault_path}/{directories.sprints}/Sprint {N}/`. Don't require `/start-sprint` to have been run first — this skill should be self-sufficient.
- **User wants to re-plan a single story**: Allow running with a specific story key instead of the full sprint. Detect if the argument looks like a ticket number (e.g., `{jira.ticket_prefix}-31368`) vs a sprint number (e.g., `247`).

## File Locations

All paths resolve from `~/.claude/skills-config.yaml`:

| File | Config Path |
|:-----|:------------|
| Sprint plan | `{vault_path}/{directories.sprints}/Sprint {N}/{filenames.sprint_plan}` |
| Story plan | `{vault_path}/{directories.sprints}/Sprint {N}/{jira.ticket_prefix}-XXXXX/{filenames.story_plan}` |
| Jira JQL | `project = {jira.project_key} AND sprint = '{jira.sprint_name_pattern}' AND assignee = '{jira.account_id}'` |

## Notes

- Plans are living documents — they can be updated as work progresses
- The `/goodmorning` skill can reference these plans when building the daily priority queue
- Sub-agents should be scoped tightly — one story per agent, clear deliverable
- Keep plans concise — focus on actionable steps, not exhaustive documentation
