import { useEffect, useState, useCallback, useRef } from 'react';
import type { GoalStatus } from '@shared/types';
import TerminalPanel from './TerminalPanel';
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
  currentContextTokens: number;
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
    totalTokensIn: 0, totalTokensOut: 0, totalCost: 0, turnCount: 0, currentContextTokens: 0,
  });
  const [splitRatio, setSplitRatio] = useState(readRatio);
  const [isDragging, setIsDragging] = useState(false);
  const [paneCollapsed, setPaneCollapsed] = useState(() => {
    try { return localStorage.getItem('claude-deck:plan-pane-collapsed') === 'true'; } catch { return false; }
  });
  const containerRef = useRef<HTMLDivElement>(null);

  // Fetch session cost + token data (from JSONL logs)
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const goalRes = await fetch(`/api/goals/${goalId}`);
        if (!goalRes.ok) return;
        const data = (await goalRes.json()) as Record<string, unknown>;
        const goal = data.goal as Record<string, unknown> | undefined;
        const sessionId = goal?.current_session_id as string | undefined;
        if (!sessionId) return;

        const [sessRes, usageRes] = await Promise.all([
          fetch(`/api/sessions/${sessionId}`),
          fetch(`/api/sessions/${sessionId}/usage`),
        ]);
        if (cancelled) return;

        const session = sessRes.ok ? (await sessRes.json()) as Record<string, unknown> : null;
        const usage = usageRes.ok ? (await usageRes.json()) as Record<string, number> : null;

        const tokensIn = (usage?.inputTokens ?? 0)
          + (usage?.cacheCreationTokens ?? 0)
          + (usage?.cacheReadTokens ?? 0);
        const tokensOut = usage?.outputTokens ?? 0;

        const jsonlCost = usage?.estimatedCostUsd ?? 0;
        setSessionCost({
          totalTokensIn: tokensIn,
          totalTokensOut: tokensOut,
          totalCost: jsonlCost,
          turnCount: (session?.stream_event_count as number) ?? 0,
          currentContextTokens: usage?.currentContextTokens ?? 0,
        });
      } catch {
        // ignore
      }
    }
    load();
    return () => { cancelled = true; };
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

  const rightWidth = paneCollapsed ? '40px' : `${((1 - splitRatio) * 100).toFixed(1)}%`;

  return (
    <div
      ref={containerRef}
      className="flex flex-1 overflow-hidden"
      data-testid="goal-split-view"
      style={isDragging ? { cursor: 'col-resize', userSelect: 'none' } : undefined}
    >
      {/* Left: Terminal — flex-1 fills remaining space */}
      <div className="flex flex-1 min-w-0 min-h-0 flex-col">
        <TerminalPanel goalId={goalId} goalStatus={goalStatus} />
      </div>

      {/* Resizable divider — hidden when collapsed */}
      {!paneCollapsed && (
        <div
          className={`flex w-1.5 shrink-0 cursor-col-resize items-center justify-center transition-colors
            ${isDragging ? 'bg-deck-accent' : 'bg-deck-border hover:bg-deck-accent/50'}`}
          onMouseDown={handleMouseDown}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize pane divider"
          title="Drag to resize"
        />
      )}

      {/* Right: Tabbed pane — shrinks to 40px when collapsed */}
      <div className="flex min-h-0 flex-col overflow-hidden shrink-0 transition-all" style={{ width: rightWidth }}>
        <GoalPlanPane
          collapsed={paneCollapsed}
          onCollapseChange={setPaneCollapsed}
          goalId={goalId}
          sessionHealth={{
            tokensIn: sessionCost.totalTokensIn,
            tokensOut: sessionCost.totalTokensOut,
            cost: sessionCost.totalCost,
            turnCount: sessionCost.turnCount,
            currentContextTokens: sessionCost.currentContextTokens,
          }}
        />
      </div>
    </div>
  );
}
