---
name: start-sprint
description: Sprint kickoff — validate stories, create goals per story with autonomous research, initialize sprint folder structure
type: workflow
arguments:
  - name: sprint-number
    required: true
    description: "Sprint number (e.g., 249)"
tags: [jira, sprint, planning, claude-deck]
---

# Start Sprint

Validates and initializes a sprint. Confirms all stories have an epic and story points, creates the sprint folder structure, and creates a Claude Deck goal for each story that autonomously researches and plans the work.

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `sprint-number` | Yes | Sprint number (e.g., 249) |

## Prerequisites

- Atlassian MCP plugin available
- User's Jira account ID is known (from monorepo CLAUDE.md team table, or ask)
- Claude Deck MCP tools available (for goal creation — falls back to folder-only if unavailable)

## Steps

### Phase 1: Identify Sprint and Stories

1. **Determine the current user's Jira account ID**
   - Check the team table in the monorepo CLAUDE.md
   - Match by name or email
   - If not found, ask the user for their Jira account ID

2. **Query the specified sprint for the user's stories**

   Use the sprint number from the argument. The Jira sprint name follows the pattern `Rangers Sprint {N}`.

   ```
   mcp__plugin_atlassian_atlassian__searchJiraIssuesUsingJql:
     jql: "project = DW AND sprint = 'Rangers Sprint {N}' AND assignee = '<account_id>' AND issuetype = Story ORDER BY priority DESC, status ASC"
     fields: ["summary", "description", "parent", "customfield_10026", "status", "customfield_10020"]
   ```

   If the sprint name pattern doesn't match, try `Sprint {N}` as a fallback. If still no results, ask the user for the exact sprint name.

3. **Extract sprint metadata** from the results:
   - Sprint name and number (from `customfield_10020`)
   - Sprint start/end dates
   - Story count and total points

4. **Present the story list** to the user for confirmation:

   ```
   Sprint {N} — Your Stories (X stories, Y points)

   | # | Key | Summary | Epic | Points | Status |
   |---|-----|---------|------|--------|--------|
   | 1 | DW-XXXXX | ... | DW-XXXXX | 5 | Open |
   ```

### Phase 2: Validate Stories

For each story, check:

1. **Epic (parent)** — `parent` field must be populated
2. **Story points** — `customfield_10026` must be populated and > 0

**If gaps are found**, present them:

```
Validation Issues:

| Key | Issue |
|-----|-------|
| DW-XXXXX | Missing epic — which epic should this belong to? |
| DW-YYYYY | Missing story points — how many points? |
```

Ask the user for the missing values. Fix each via `editJiraIssue`:

```
mcp__plugin_atlassian_atlassian__editJiraIssue:
  issueIdOrKey: "DW-XXXXX"
  fields: {"parent": {"key": "DW-EPIC"}}   # or {"customfield_10026": 5}
```

**Do not proceed to Phase 3 until all stories pass validation.**

### Phase 3: Create Sprint Folder Structure

Create the folder structure under `C:\CTDW Repository\Wellsky\Sprints\`:

```
Wellsky/Sprints/
  Sprint {N}/
    DW-XXXXX/      (one folder per story)
    DW-YYYYY/
    ...
```

```bash
mkdir -p "C:\CTDW Repository\Wellsky\Sprints\Sprint {N}\DW-XXXXX"
```

Create one folder per story. These folders become each goal's working directory.

### Phase 4: Create Goals in Claude Deck

**Prerequisite check:** Verify Claude Deck MCP tools are available by attempting `list_goals`. If the tool is not found, skip this phase and note it in the summary.

**Determine the source goal ID:** Call `list_goals` and identify the current primary/orchestrator goal. If unclear, ask the user which goal is the source.

For each story, create a goal with a research instruction:

```
Tool: create_goal_and_instruct

title: "DW-XXXXX: <story summary>"
cwd: "C:\CTDW Repository\Wellsky\Sprints\Sprint {N}\DW-XXXXX"
source_goal_id: "<primary goal ID>"
spawn_session: true
instruction: <see Research Instruction below>
```

**Goal configuration:**
- **CWD**: The sprint story folder — gives each goal its own space for Research.md, Plan.md, Notes.md, Handoff.md
- **spawn_session**: true — goal immediately starts researching
- The goal's instruction tells it which repo(s) to work in for actual code changes

#### Research Instruction

For each story, construct the instruction from this template. Replace placeholders with actual values:

```
You are researching Jira story DW-XXXXX: "<summary>".
Epic: DW-YYYYY — <epic summary>
Points: N
Description: <full Jira description>

## Your Task

1. Research this story thoroughly using all available sources
2. Produce a Research.md in your working directory with findings and source inventory
3. Draft a Plan.md with implementation steps
4. Create a To Do list based on the plan steps

## Sources to Check

Document ALL sources in Research.md — whether they were useful or not.

### Required Sources
- **Jira ticket**: Read DW-XXXXX using the Atlassian MCP — full description, all comments, linked tickets, epic context, existing subtasks
- **Confluence**: Search the team space (space ID: 102297180) for related pages using Atlassian MCP search
- **Obsidian vault**: Read files in C:\CTDW Repository\Wellsky\ for prior research, handoffs, design docs, and patterns related to this work
- **Repository code**: Search relevant repos for existing implementations, patterns, and related code:
  - Looker: C:\CTDW Repository\cpt-dwdi\looker
  - Dataform: C:\CTDW Repository\cpt-dwdi\dataform
  - Docs: C:\CTDW Repository\cpt-dwdi\docs
  - Oracle: C:\CTDW Repository\cpt-dwdi\oracle (legacy, migration source)
- **Web**: Search for external documentation, best practices, API references, or similar implementations if the work involves unfamiliar technology

### Research.md Format

Write your Research.md with this structure:

# Research: DW-XXXXX — <summary>

## Jira Context
<ticket description, acceptance criteria, comments from team, linked tickets>

## Sources Reviewed
| Source | Location | Used | Notes |
|--------|----------|------|-------|
| Jira: DW-XXXXX | wellsky.atlassian.net/browse/DW-XXXXX | Yes | Primary requirements |
| Confluence: <page title> | <URL> | Yes/No | <what was found or why not useful> |
| Vault: <file> | <path> | Yes/No | <relevance> |
| Repo: <file> | <path> | Yes/No | <relevance> |
| Web: <source> | <URL> | Yes/No | <relevance> |

## Findings
<organized by topic — what you learned that informs the implementation>

## Open Questions
<anything that needs human input before implementation can proceed>

## Recommendations
<suggested approach based on research, with rationale>

### Plan.md Format

Write your Plan.md with this structure:

# Plan: DW-XXXXX — <summary>

## Objective
<what this story achieves, in business terms>

## Prerequisites
<dependencies on other tickets, access needed, data availability>

## Implementation Steps
1. [ ] Step description — (Claude/Human/Team) — estimated effort
2. [ ] ...

## Success Criteria
- <how to verify this is done correctly>
- <specific tests, validations, or acceptance criteria>

## Risks
- <what could go wrong, and mitigation>

After producing Research.md and Plan.md, set your To Do items based on the implementation steps in your plan.

When research is complete, report back to the source goal with a brief summary of findings and any open questions that need human input.
```

**Note:** Construct the instruction with the actual Jira ticket data (description, epic, points) — don't make the goal re-fetch what we already have.

### Phase 5: Summary

Present the final summary:

```
Sprint {N} initialized:

- {X} stories validated (all have epic + points)
- {Y} goals created in Claude Deck (researching autonomously)
- Folder structure at Wellsky/Sprints/Sprint {N}/

| Key | Summary | Pts | Goal Status |
|-----|---------|-----|-------------|
| DW-XXXXX | ... | 5 | Researching |
| DW-YYYYY | ... | 3 | Researching |

Total: {X} stories, {Y} points

Next steps:
- Goals will produce Research.md and Plan.md autonomously
- Review research output on the Claude Deck board as goals complete
- After reviewing, subtasks will be created from the plans (not guessed from descriptions)
```

### Phase 6: Generate Subtasks (DEFERRED)

**This phase runs AFTER research is complete — not during sprint initialization.**

The user triggers this when they've reviewed research output and approved plans. It can be a follow-up command or manual step.

When triggered:
- For each story with a completed and approved Plan.md, read the implementation steps
- Propose subtasks based on plan steps (informed by actual research, not Jira description guesswork)
- Create via Jira after user confirmation
- Update the goal's To Do list to match the subtasks

## Fallback Mode

If Claude Deck MCP tools are not available (running in regular CLI without Claude Deck):
- Skip Phase 4 (goal creation)
- Create folder structure only (Phase 3)
- Log: "Claude Deck MCP tools not available — goals not created. Run this skill from a Claude Deck goal session for full functionality."

## Edge Cases

- **Sprint not found**: If `Rangers Sprint {N}` doesn't match, try `Sprint {N}`. If still no results, ask the user for the exact sprint name.
- **No stories found**: Confirm sprint number and assignment. Re-query if needed.
- **Stories already have subtasks**: Note them in the summary. Phase 6 will handle additional subtasks after research.
- **Story has no description**: Flag it in the instruction — the goal will note this as an open question in Research.md.
- **Claude Deck server not running**: Goal creation will fail with a connection error. Note which stories failed and suggest retry.
- **Goal research stalls**: Goals run autonomously. If a goal stalls (no progress), the user can click into its terminal in Claude Deck and interact directly.
- **Multiple assignees**: Only create goals for the current user's stories. Other team members manage their own goals.
