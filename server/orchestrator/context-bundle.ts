import type { OrchestratorTrigger, OrchestratorRole } from '../../src/shared/orchestrator';

export interface ContextInput {
  personaName: string;
  memory: string;
  snapshotMd: string;
  recentTurns: Array<{ role: OrchestratorRole; content: string }>;
  trigger: OrchestratorTrigger;
}

/** Describes the triggering event in natural language for the brain. */
function describeTrigger(t: OrchestratorTrigger): string {
  switch (t.kind) {
    case 'owner_message':
      return `The owner sent you a message:\n"""\n${t.text ?? ''}\n"""\nRespond and act as needed.`;
    case 'approval':
      return `A supervised session raised an APPROVAL request (approvalId=${t.approvalId ?? '?'}${t.goalId ? `, goal=${t.goalId}` : ''}). Review the situation using your tools, then produce a concise RECOMMENDATION (allow / deny + why) for the owner to ratify. Do NOT resolve it yourself.`;
    case 'session_ended':
      return `A session ended/stalled (session=${t.sessionId ?? '?'}${t.goalId ? `, goal=${t.goalId}` : ''}). Assess whether it needs attention and produce a RECOMMENDATION for the owner.`;
    case 'scheduled':
      return `A scheduled task fired${t.goalId ? ` and created goal ${t.goalId}` : ''} (task=${t.taskId ?? '?'}). Supervise it and report.`;
    case 'heartbeat':
      return `Heartbeat sweep. Check the board for anything needing attention. If nothing is actionable, reply briefly that all is quiet — do not invent work.`;
  }
}

/**
 * Assembles the full prompt handed to the headless brain. The brain must end its reply
 * with an updated memory block delimited by <memory-update>...</memory-update>; the runner
 * extracts it and persists it.
 */
export function buildContextPrompt(input: ContextInput): string {
  const turns = input.recentTurns.length
    ? input.recentTurns.map((t) => `${t.role}: ${t.content}`).join('\n')
    : '(no prior conversation)';

  return `You are ${input.personaName}, the always-on orchestrator for Claude Deck — a control plane for multiple Claude Code sessions. You triage, route, summarize, and dispatch work through the claude-deck MCP tools. You keep the owner in the loop on consequential decisions and never act unilaterally on irreversible or outward-facing actions.

# Your durable memory
${input.memory}

# Live board snapshot (read-only, current)
${input.snapshotMd}

# Recent conversation
${turns}

# This wake was triggered by
${describeTrigger(input.trigger)}

# Rules
- Act through the claude-deck MCP tools. Everything you do is visible to the owner.
- For approvals/stalls: review and RECOMMEND; the owner ratifies.
- Respect rate limits; if you cannot complete, say so plainly.
- Be concise.

# Required: update your memory
End your reply with your full updated memory document, wrapped exactly like:
<memory-update>
# Orchestrator Memory
...your updated memory...
</memory-update>
If nothing changed, echo the current memory unchanged inside the block.`;
}
