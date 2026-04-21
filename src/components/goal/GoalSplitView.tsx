import { useEffect, useState, useCallback, useRef } from 'react';
import type { GoalStatus } from '@shared/types';
import GoalConversation from './GoalConversation';
import GoalPlanPane from './GoalPlanPane';

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

const DIVIDER_STORAGE_KEY = 'claude-deck:split-ratio';
const DEFAULT_RATIO = 0.6; // 60% conversation, 40% pane
const MIN_RATIO = 0.3;
const MAX_RATIO = 0.85;

function readRatio(): number {
  try {
    const raw = localStorage.getItem(DIVIDER_STORAGE_KEY);
    if (raw) {
      const val = parseFloat(raw);
      if (val >= MIN_RATIO && val <= MAX_RATIO) return val;
    }
  } catch {}
  return DEFAULT_RATIO;
}

export default function GoalSplitView({ goalId, goalStatus }: GoalSplitViewProps) {
  const [sessionCost, setSessionCost] = useState<SessionCostData>({
    totalTokensIn: 0, totalTokensOut: 0, totalCost: 0, turnCount: 0,
  });
  const [splitRatio, setSplitRatio] = useState(readRatio);
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Fetch session cost data
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

  // Drag handler for resizable divider
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    function handleMouseMove(e: MouseEvent) {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, (e.clientX - rect.left) / rect.width));
      setSplitRatio(ratio);
    }

    function handleMouseUp() {
      setIsDragging(false);
      // Persist ratio
      try { localStorage.setItem(DIVIDER_STORAGE_KEY, String(splitRatio)); } catch {}
    }

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, splitRatio]);

  const leftPercent = `${(splitRatio * 100).toFixed(1)}%`;
  const rightPercent = `${((1 - splitRatio) * 100).toFixed(1)}%`;

  return (
    <div
      ref={containerRef}
      className="flex flex-1 overflow-hidden"
      data-testid="goal-split-view"
      style={isDragging ? { cursor: 'col-resize', userSelect: 'none' } : undefined}
    >
      {/* Left: Conversation */}
      <div className="flex min-w-0 min-h-0 flex-col" style={{ width: leftPercent }}>
        <GoalConversation goalId={goalId} goalStatus={goalStatus} />
      </div>

      {/* Resizable divider */}
      <div
        className={`flex w-1.5 shrink-0 cursor-col-resize items-center justify-center transition-colors
          ${isDragging ? 'bg-deck-accent' : 'bg-deck-border hover:bg-deck-accent/50'}`}
        onMouseDown={handleMouseDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize pane divider"
        title="Drag to resize"
      />

      {/* Right: Tabbed pane */}
      <div className="flex min-h-0 flex-col overflow-hidden" style={{ width: rightPercent }}>
        <GoalPlanPane
          goalId={goalId}
          sessionHealth={{
            tokensIn: sessionCost.totalTokensIn,
            tokensOut: sessionCost.totalTokensOut,
            cost: sessionCost.totalCost,
            turnCount: sessionCost.turnCount,
          }}
        />
      </div>
    </div>
  );
}
