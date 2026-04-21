import { useEffect, useState } from 'react';
import type { GoalStatus } from '@shared/types';
import GoalConversation from './GoalConversation';
import GoalPlanPane from './GoalPlanPane';
import ContextHealth from './ContextHealth';

interface GoalSplitViewProps {
  goalId: string;
  goalStatus: GoalStatus;
}

interface SessionCostData {
  totalTokensIn: number;
  totalTokensOut: number;
  totalCost: number;
  turnCount: number;
}

/**
 * 60/40 split layout: conversation on the left, plan pane on the right.
 * The plan pane is collapsible (to a narrow 40px strip).
 * Uses CSS grid for the split. Resizable divider is a v1.1 enhancement.
 */
export default function GoalSplitView({
  goalId,
  goalStatus,
}: GoalSplitViewProps) {
  const [sessionCost, setSessionCost] = useState<SessionCostData>({
    totalTokensIn: 0, totalTokensOut: 0, totalCost: 0, turnCount: 0,
  });

  // Fetch session cost data for this goal
  useEffect(() => {
    fetch(`/api/goals/${goalId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Record<string, unknown> | null) => {
        if (!data) return;
        const goal = data.goal as Record<string, unknown> | undefined;
        const sessionId = goal?.current_session_id as string | undefined;
        if (!sessionId) return;
        return fetch(`/api/sessions/${sessionId}`);
      })
      .then((r) => (r && r.ok ? r.json() : null))
      .then((session: Record<string, unknown> | null) => {
        if (!session) return;
        setSessionCost({
          totalTokensIn: (session.total_tokens_in as number) ?? 0,
          totalTokensOut: (session.total_tokens_out as number) ?? 0,
          totalCost: (session.total_cost_usd as number) ?? 0,
          turnCount: (session.stream_event_count as number) ?? 0,
        });
      })
      .catch(() => {});
  }, [goalId]);

  return (
    <div
      className="flex flex-1 overflow-hidden"
      data-testid="goal-split-view"
    >
      {/* Left: Conversation */}
      <div className="flex min-w-0 flex-[3] flex-col">
        <GoalConversation goalId={goalId} goalStatus={goalStatus} />
      </div>

      {/* Right: Context Health + Document Pane */}
      <div className="flex flex-[2] flex-col">
        <div className="shrink-0 border-b border-deck-border p-2">
          <ContextHealth
            tokensIn={sessionCost.totalTokensIn}
            tokensOut={sessionCost.totalTokensOut}
            cost={sessionCost.totalCost}
            turnCount={sessionCost.turnCount}
          />
        </div>
        <div className="flex-1 overflow-hidden">
          <GoalPlanPane goalId={goalId} />
        </div>
      </div>
    </div>
  );
}
