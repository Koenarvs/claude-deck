import type { GoalStatus } from '@shared/types';
import GoalConversation from './GoalConversation';
import GoalPlanPane from './GoalPlanPane';

interface GoalSplitViewProps {
  goalId: string;
  goalStatus: GoalStatus;
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
  return (
    <div
      className="flex flex-1 overflow-hidden"
      data-testid="goal-split-view"
    >
      {/* Left: Conversation (flex-1 takes remaining space) */}
      <div className="flex min-w-0 flex-[3] flex-col">
        <GoalConversation goalId={goalId} goalStatus={goalStatus} />
      </div>

      {/* Right: Plan Pane (flex-[2] = ~40% when expanded) */}
      <div className="flex flex-[2] flex-col">
        <GoalPlanPane goalId={goalId} />
      </div>
    </div>
  );
}
