/**
 * GlobalApprovalQueue — floating, collapsible dock at top-right.
 * Reads approvals from the store; posts decisions via the existing api helper.
 */
import { useState } from 'react';
import { Check, X, ChevronDown } from 'lucide-react';
import { useApprovalsStore } from '../../stores/useApprovalsStore';
import { apiPost } from '../../lib/api';
import type { Approval, ApprovalDecision } from '../../shared/types';

function fmtRel(t: number): string {
  const d = Date.now() - t;
  if (d < 60_000) return `${Math.floor(d / 1000)}s`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`;
  return `${Math.floor(d / 86_400_000)}d`;
}

function argSummary(a: Approval): string {
  try {
    const args = JSON.parse(a.tool_args) as Record<string, unknown>;
    return (
      (args.path as string) ||
      (args.command as string) ||
      (args.file_path as string) ||
      JSON.stringify(args).slice(0, 80)
    );
  } catch {
    return a.tool_args.slice(0, 80);
  }
}

export default function GlobalApprovalQueue() {
  const approvals = useApprovalsStore((s) => s.pending);
  const markResolved = useApprovalsStore((s) => s.markResolved);
  const [collapsed, setCollapsed] = useState(false);

  if (approvals.length === 0) return null;

  async function decide(a: Approval, decision: ApprovalDecision) {
    markResolved(a.id, decision);
    try {
      await apiPost(`/api/approvals/${a.id}/decide`, { decision });
    } catch {
      // server broadcast will reconcile
    }
  }

  return (
    <div className="fixed right-[22px] top-[18px] z-30 flex w-[340px] flex-col gap-2">
      <div className="overflow-hidden rounded-md border border-line-strong bg-card shadow-xl">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className={`flex w-full items-center gap-2 bg-surface px-3 py-2.5 ${
            collapsed ? '' : 'border-b border-line'
          }`}
        >
          <span className="pulse-dot" style={{ background: 'var(--cd-warn)' }} />
          <span className="flex-1 text-left text-[12px] font-semibold text-fg">
            {approvals.length} approval{approvals.length > 1 ? 's' : ''} pending
          </span>
          <ChevronDown
            size={13}
            className={`transition-transform ${collapsed ? '' : 'rotate-180'}`}
          />
        </button>

        {!collapsed && (
          <div>
            {approvals.slice(0, 3).map((a, i, arr) => (
              <div
                key={a.id}
                className={`px-3 py-2.5 ${
                  i < arr.length - 1 ? 'border-b border-line' : ''
                }`}
              >
                <div className="mb-1 flex items-center gap-1.5">
                  <span className="mono-tabular rounded-sm bg-accent-soft px-1.5 py-px text-[10px] font-semibold text-accent">
                    {a.tool_name}
                  </span>
                  <span className="mono-tabular text-[10px] text-faint">
                    {fmtRel(a.requested_at)} ago
                  </span>
                </div>
                <div className="mb-0.5 text-[12px] font-medium leading-snug text-fg">
                  {a.goal_id ? `Goal ${a.goal_id.slice(0, 8)}` : 'Unlinked session'}
                </div>
                <div className="mono-tabular mb-2 truncate rounded-sm bg-inset px-1.5 py-1 text-[11px] text-dim">
                  {argSummary(a)}
                </div>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => decide(a, 'approved')}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-accent bg-accent px-2 py-1 text-[12px] font-medium text-accent-fg transition-[filter] hover:brightness-105"
                  >
                    <Check size={12} /> Approve
                  </button>
                  <button
                    type="button"
                    onClick={() => decide(a, 'denied')}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-line bg-surface px-2 py-1 text-[12px] font-medium text-fg transition-colors hover:bg-hover"
                  >
                    <X size={12} /> Deny
                  </button>
                </div>
              </div>
            ))}
            {approvals.length > 3 && (
              <div className="px-3 py-2 text-center text-[11px] text-faint">
                +{approvals.length - 3} more in queue
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
