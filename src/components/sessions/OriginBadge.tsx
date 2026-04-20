import { Monitor, Globe } from 'lucide-react';
import type { SessionOrigin } from '../../shared/types';

interface OriginBadgeProps {
  origin: SessionOrigin;
}

const BADGE_STYLES: Record<SessionOrigin, string> = {
  dashboard: 'bg-deck-accent/15 text-deck-accent',
  external: 'bg-deck-warning/15 text-deck-warning',
};

const BADGE_ICONS: Record<SessionOrigin, React.ReactNode> = {
  dashboard: <Monitor size={12} />,
  external: <Globe size={12} />,
};

const BADGE_LABELS: Record<SessionOrigin, string> = {
  dashboard: 'Dashboard',
  external: 'External',
};

export function OriginBadge({ origin }: OriginBadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${BADGE_STYLES[origin]}`}
    >
      {BADGE_ICONS[origin]}
      {BADGE_LABELS[origin]}
    </span>
  );
}
