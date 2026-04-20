import { useConnectionStore } from '../../stores/useConnectionStore';
import { Wifi, WifiOff } from 'lucide-react';

const statusConfig = {
  open: {
    color: 'bg-deck-success',
    label: 'Connected',
    Icon: Wifi,
    pulse: false,
  },
  connecting: {
    color: 'bg-deck-warning',
    label: 'Reconnecting',
    Icon: Wifi,
    pulse: true,
  },
  closed: {
    color: 'bg-deck-danger',
    label: 'Disconnected',
    Icon: WifiOff,
    pulse: false,
  },
  error: {
    color: 'bg-deck-danger',
    label: 'Connection error',
    Icon: WifiOff,
    pulse: false,
  },
} as const;

/**
 * Connection status indicator.
 * Fixed bottom-left, shows WebSocket connection state.
 *
 * - Green dot + Wifi icon = connected (open)
 * - Yellow pulsing dot + Wifi icon = reconnecting (connecting)
 * - Red dot + WifiOff icon = disconnected/error
 */
export default function ConnectionIndicator() {
  const status = useConnectionStore((s) => s.status);
  const config = statusConfig[status];
  const { Icon } = config;

  return (
    <div
      className="fixed bottom-4 left-4 z-40 flex items-center gap-2 rounded-full border border-deck-border bg-deck-surface px-3 py-1.5 shadow-lg"
      role="status"
      aria-label={`WebSocket status: ${config.label}`}
    >
      <span className="relative flex h-2.5 w-2.5">
        {config.pulse && (
          <span
            className={`absolute inline-flex h-full w-full animate-ping rounded-full ${config.color} opacity-75`}
            aria-hidden="true"
          />
        )}
        <span
          className={`relative inline-flex h-2.5 w-2.5 rounded-full ${config.color}`}
          aria-hidden="true"
        />
      </span>
      <Icon size={14} className="text-deck-muted" aria-hidden="true" />
      <span className="text-xs text-deck-muted">{config.label}</span>
    </div>
  );
}
