import { useState, useEffect } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useNavigate } from 'react-router';
import { Cpu, Archive, FolderOpen, AlertCircle, Pause } from 'lucide-react';
import { useGoalsStore } from '../../stores/useGoalsStore';
import { useApprovalsStore } from '../../stores/useApprovalsStore';
import { useActiveToolStore } from '../../stores/useActiveToolStore';
import { estimateContextUsage } from '../../stores/useSessionHealthStore';
import { fmtCost, fmtTokens } from '../../lib/format';
import type { Goal, GoalModel } from '../../shared/types';

interface KanbanCardProps {
  goal: Goal;
}

interface SessionStats {
  turns: number;
  cost: number;
  tokensIn: number;
  tokensOut: number;
  contextPct: number;
}

const STATUS_RAIL_COLORS: Record<string, string> = {
  planning: 'border-l-[var(--cd-warn)]',
  active: 'border-l-[var(--cd-accent)]',
  waiting: 'border-l-[var(--cd-dim)]',
  complete: 'border-l-[var(--cd-ok)]',
  archived: 'border-l-[var(--cd-faint)]',
};

const MODEL_LABELS: Record<GoalModel, string> = {
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  default: 'Default',
};

const MODEL_COLORS: Record<GoalModel, string> = {
  opus: 'text-amber-400',
  sonnet: 'text-indigo-400',
  haiku: 'text-emerald-400',
  default: 'text-dim',
};

function shortenCwd(cwd: string): string {
  const parts = cwd.replace(/\\/g, '/').split('/');
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : cwd;
}

export default function KanbanCard({ goal }: KanbanCardProps) {
  const navigate = useNavigate();
  const removeGoal = useGoalsStore((s) => s.removeGoal);
  const [stats, setStats] = useState<SessionStats | null>(null);

  const pendingApproval = useApprovalsStore((s) =>
    s.pending.find((a) => a.goal_id === goal.id),
  );

  const sessionId = goal.current_session_id;
  const activeTool = useActiveToolStore((s) =>
    sessionId ? s.bySessionId[sessionId] ?? null : null,
  );

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const goalRes = await fetch(`/api/goals/${goal.id}`);
        if (!goalRes.ok) return;
        const goalData = (await goalRes.json()) as Record<string, unknown>;
        const g = goalData.goal as Record<string, unknown> | undefined;
        const sessionId = (g?.current_session_id as string) ?? null;
        if (!sessionId) return;

        const [sessRes, usageRes] = await Promise.all([
          fetch(`/api/sessions/${sessionId}`),
          fetch(`/api/sessions/${sessionId}/usage`),
        ]);
        if (!sessRes.ok) return;
        const sess = (await sessRes.json()) as Record<string, unknown>;
        const usage = usageRes.ok
          ? (await usageRes.json()) as Record<string, number>
          : null;
        if (cancelled) return;

        const tokensIn = (usage?.inputTokens ?? 0)
          + (usage?.cacheCreationTokens ?? 0)
          + (usage?.cacheReadTokens ?? 0);
        const tokensOut = usage?.outputTokens ?? 0;
        const currentContext = usage?.currentContextTokens ?? 0;
        const jsonlCost = usage?.estimatedCostUsd ?? 0;
        setStats({
          turns: (sess.stream_event_count as number) ?? 0,
          cost: jsonlCost,
          tokensIn,
          tokensOut,
          contextPct: estimateContextUsage(currentContext, goal.model ?? 'default'),
        });
      } catch {
        // ignore
      }
    }

    load();
    return () => { cancelled = true; };
  }, [goal.id, goal.current_session_id, goal.model]);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: goal.id,
    data: { goal },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  function handleClick() {
    navigate(`/goals/${goal.id}`);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick();
    }
  }

  const turns = stats?.turns ?? 0;
  const cost = stats?.cost ?? 0;
  const tokens = (stats?.tokensIn ?? 0) + (stats?.tokensOut ?? 0);
  const contextPct = stats?.contextPct ?? 0;
  const isLive = goal.status === 'active' || goal.status === 'waiting';

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      aria-label={`Goal: ${goal.title}`}
      className={`group cursor-pointer rounded-md border border-line bg-card p-3 pl-3.5
        border-l-[3px] ${STATUS_RAIL_COLORS[goal.status] ?? 'border-l-[var(--cd-dim)]'}
        transition-all hover:border-line-strong hover:shadow-md
        focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-1 focus:ring-offset-bg
        ${isDragging ? 'z-50 opacity-50 shadow-lg' : ''}`}
    >
      {/* Title */}
      <h3 className="text-[13px] font-medium leading-snug text-fg line-clamp-2">
        {goal.title}
      </h3>

      {/* Working directory */}
      <div className="mt-1 flex items-center gap-1 text-faint">
        <FolderOpen size={10} className="shrink-0" />
        <span className="mono-tabular truncate text-[10px]">
          {shortenCwd(goal.cwd)}
        </span>
      </div>

      {/* Context bar (active/waiting) */}
      {isLive && stats && (
        <div className="mt-2 flex items-center gap-2">
          <div className="h-[4px] flex-1 overflow-hidden rounded-full bg-inset">
            <div
              className={`h-full rounded-full transition-all ${
                contextPct > 80 ? 'bg-danger' : contextPct > 50 ? 'bg-warn' : 'bg-accent'
              }`}
              style={{ width: `${Math.min(100, contextPct)}%` }}
            />
          </div>
          <span className="mono-tabular text-[10px] text-faint">
            {contextPct}%
          </span>
        </div>
      )}

      {/* Current action (active) or blocker/idle (waiting) */}
      {goal.status === 'active' && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <span className="pulse-dot !h-[5px] !w-[5px]" />
          <span className="mono-tabular text-[10px] text-accent">
            {activeTool ?? 'Running'}
          </span>
        </div>
      )}

      {pendingApproval && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <AlertCircle size={11} className="text-warn" />
          <span className="mono-tabular truncate text-[10px] text-warn">
            {pendingApproval.tool_name}
          </span>
        </div>
      )}

      {goal.status === 'waiting' && !pendingApproval && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <Pause size={11} className="text-faint" />
          <span className="mono-tabular text-[10px] text-faint">
            Idle
          </span>
        </div>
      )}

      {/* Model + stats row */}
      <div className="mt-2 flex items-center gap-1.5">
        {goal.model && goal.model !== 'default' && (
          <span
            className={`mono-tabular inline-flex items-center gap-0.5 rounded-sm bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold ${MODEL_COLORS[goal.model]}`}
          >
            <Cpu size={9} />
            {MODEL_LABELS[goal.model]}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2 mono-tabular text-[10px] text-faint">
          {turns > 0 && <span>{turns}t</span>}
          {cost > 0 && <span>{fmtCost(cost)}</span>}
          {tokens > 0 && <span>{fmtTokens(tokens)}</span>}
        </div>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            fetch(`/api/goals/${goal.id}`, { method: 'DELETE' })
              .then((res) => {
                if (res.ok) removeGoal(goal.id);
              })
              .catch(() => {});
          }}
          className="rounded p-0.5 text-faint opacity-0 transition-opacity hover:bg-danger/20 hover:text-danger group-hover:opacity-100"
          aria-label="Archive goal"
          title="Archive"
        >
          <Archive size={12} />
        </button>
      </div>
    </div>
  );
}
