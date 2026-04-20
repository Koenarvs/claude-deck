import { useEffect, useRef, useCallback, useState } from 'react';
import { Bell } from 'lucide-react';
import { useApprovalsStore } from '../../stores/useApprovalsStore';
import { notify, getPermission, requestPermission } from '../../lib/notifications';
import { setBadge, clearBadge } from '../../lib/tab-badge';
import { toast } from '../../lib/toast-store';
import ApprovalCard from './ApprovalCard';

/**
 * Global floating approval queue.
 * Visible on every route, positioned top-right.
 *
 * - Renders pending approvals as a stack of ApprovalCards
 * - Fires browser notifications on new pending approvals
 * - Updates tab-title badge with pending count
 * - Shows a one-time notification consent banner if permission is 'default'
 */
export default function GlobalApprovalQueue() {
  const pending = useApprovalsStore((s) => s.pending);
  const markResolved = useApprovalsStore((s) => s.markResolved);
  const prevCountRef = useRef(0);
  const [showConsentBanner, setShowConsentBanner] = useState(false);
  const consentDismissedRef = useRef(false);

  // Update tab badge whenever pending count changes
  useEffect(() => {
    if (pending.length > 0) {
      setBadge(pending.length);
    } else {
      clearBadge();
    }
  }, [pending.length]);

  // Fire browser notification and show consent banner on new approvals
  useEffect(() => {
    if (pending.length > prevCountRef.current) {
      const newest = pending[pending.length - 1];

      if (newest) {
        const permission = getPermission();

        if (permission === 'granted') {
          notify('Approval Required', `${newest.tool_name} needs approval`, {
            tag: `approval-${newest.id}`,
            onClick: () => window.focus(),
          });
        } else if (permission === 'default' && !consentDismissedRef.current) {
          setShowConsentBanner(true);
        }
      }
    }

    prevCountRef.current = pending.length;
  }, [pending]);

  const handleAllow = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/approvals/${id}/decide`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision: 'approved' }),
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        markResolved(id, 'approved');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        toast.error(`Failed to approve: ${message}`);
      }
    },
    [markResolved],
  );

  const handleDeny = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/approvals/${id}/decide`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision: 'denied' }),
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        markResolved(id, 'denied');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        toast.error(`Failed to deny: ${message}`);
      }
    },
    [markResolved],
  );

  const handleEnableNotifications = useCallback(async () => {
    const result = await requestPermission();
    setShowConsentBanner(false);
    consentDismissedRef.current = true;

    if (result === 'granted') {
      toast.success('Browser notifications enabled');
    } else {
      toast.info('Notifications not enabled. You can change this in browser settings.');
    }
  }, []);

  const handleDismissConsent = useCallback(() => {
    setShowConsentBanner(false);
    consentDismissedRef.current = true;
  }, []);

  if (pending.length === 0 && !showConsentBanner) return null;

  return (
    <div className="fixed right-4 top-4 z-50 flex flex-col gap-2" aria-label="Pending approvals">
      {/* Notification consent banner */}
      {showConsentBanner && (
        <div
          className="flex w-80 items-center gap-3 rounded-lg border border-deck-accent/50 bg-deck-surface px-4 py-3 shadow-xl"
          role="alert"
        >
          <Bell size={18} className="shrink-0 text-deck-accent" aria-hidden="true" />
          <div className="flex-1">
            <p className="text-sm text-deck-text">Enable browser notifications for approval alerts?</p>
          </div>
          <div className="flex gap-1">
            <button
              onClick={handleEnableNotifications}
              className="rounded px-2 py-1 text-xs font-medium text-deck-accent transition-colors hover:bg-deck-accent/10"
              aria-label="Enable browser notifications"
            >
              Enable
            </button>
            <button
              onClick={handleDismissConsent}
              className="rounded px-2 py-1 text-xs text-deck-muted transition-colors hover:text-deck-text"
              aria-label="Dismiss notification prompt"
            >
              Skip
            </button>
          </div>
        </div>
      )}

      {/* Approval cards */}
      {pending.map((approval) => (
        <ApprovalCard
          key={approval.id}
          approval={approval}
          onAllow={handleAllow}
          onDeny={handleDeny}
        />
      ))}
    </div>
  );
}
