import { useState, useEffect, useCallback } from 'react';
import { Shield, Check, X, Clock } from 'lucide-react';
import type { Approval } from '../../shared/types';

/** Default timeout for approvals: 30 minutes in ms */
const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;

interface ApprovalCardProps {
  approval: Approval;
  onAllow: (id: string) => void;
  onDeny: (id: string) => void;
}

/**
 * Formats milliseconds remaining as MM:SS.
 */
function formatCountdown(ms: number): string {
  if (ms <= 0) return '0:00';
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Parses and pretty-prints tool_args JSON.
 * Truncates to maxLength characters for display.
 */
function formatArgs(argsJson: string, maxLength = 200): string {
  try {
    const parsed: unknown = JSON.parse(argsJson);
    const pretty = JSON.stringify(parsed, null, 2);
    if (pretty.length > maxLength) {
      return pretty.slice(0, maxLength) + '\u2026';
    }
    return pretty;
  } catch {
    return argsJson.length > maxLength ? argsJson.slice(0, maxLength) + '\u2026' : argsJson;
  }
}

export default function ApprovalCard({ approval, onAllow, onDeny }: ApprovalCardProps) {
  const [timeRemaining, setTimeRemaining] = useState(() => {
    const elapsed = Date.now() - approval.requested_at;
    return Math.max(0, APPROVAL_TIMEOUT_MS - elapsed);
  });
  const [deciding, setDeciding] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      const elapsed = Date.now() - approval.requested_at;
      const remaining = Math.max(0, APPROVAL_TIMEOUT_MS - elapsed);
      setTimeRemaining(remaining);

      if (remaining <= 0) {
        clearInterval(interval);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [approval.requested_at]);

  const handleAllow = useCallback(() => {
    setDeciding(true);
    onAllow(approval.id);
  }, [approval.id, onAllow]);

  const handleDeny = useCallback(() => {
    setDeciding(true);
    onDeny(approval.id);
  }, [approval.id, onDeny]);

  const isExpired = timeRemaining <= 0;
  const isUrgent = timeRemaining < 60_000 && timeRemaining > 0;

  return (
    <div
      className="w-80 rounded-lg border border-deck-border bg-deck-surface shadow-xl"
      role="alert"
      aria-label={`Approval request for ${approval.tool_name}`}
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-deck-border px-3 py-2">
        <Shield size={16} className="text-deck-warning" aria-hidden="true" />
        <span className="flex-1 text-sm font-medium text-deck-text">
          {approval.tool_name}
        </span>
        <span
          className={`flex items-center gap-1 text-xs ${
            isExpired
              ? 'text-deck-danger'
              : isUrgent
                ? 'text-deck-warning'
                : 'text-deck-muted'
          }`}
          aria-label={`Time remaining: ${formatCountdown(timeRemaining)}`}
        >
          <Clock size={12} aria-hidden="true" />
          {formatCountdown(timeRemaining)}
        </span>
      </div>

      {/* Args preview */}
      <div className="max-h-32 overflow-y-auto px-3 py-2">
        <pre className="whitespace-pre-wrap break-all text-xs text-deck-muted">
          {formatArgs(approval.tool_args)}
        </pre>
      </div>

      {/* Actions */}
      <div className="flex gap-2 border-t border-deck-border px-3 py-2">
        <button
          onClick={handleAllow}
          disabled={deciding || isExpired}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-deck-success/20 px-3 py-1.5 text-sm font-medium text-deck-success transition-colors hover:bg-deck-success/30 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="Allow this tool use"
        >
          <Check size={14} aria-hidden="true" />
          Allow
        </button>
        <button
          onClick={handleDeny}
          disabled={deciding || isExpired}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-deck-danger/20 px-3 py-1.5 text-sm font-medium text-deck-danger transition-colors hover:bg-deck-danger/30 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="Deny this tool use"
        >
          <X size={14} aria-hidden="true" />
          Deny
        </button>
      </div>
    </div>
  );
}
