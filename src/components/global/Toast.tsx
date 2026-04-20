import { useEffect, useState } from 'react';
import { X, Info, CheckCircle, AlertTriangle, AlertCircle } from 'lucide-react';
import type { Toast as ToastData } from '../../lib/toast-store';

interface ToastProps {
  toast: ToastData;
  onDismiss: (id: string) => void;
}

const iconMap = {
  info: Info,
  success: CheckCircle,
  warn: AlertTriangle,
  error: AlertCircle,
} as const;

const colorMap = {
  info: 'border-deck-accent bg-deck-accent/10 text-deck-accent',
  success: 'border-deck-success bg-deck-success/10 text-deck-success',
  warn: 'border-deck-warning bg-deck-warning/10 text-deck-warning',
  error: 'border-deck-danger bg-deck-danger/10 text-deck-danger',
} as const;

export default function Toast({ toast: toastData, onDismiss }: ToastProps) {
  const [exiting, setExiting] = useState(false);
  const Icon = iconMap[toastData.type];

  useEffect(() => {
    if (toastData.duration > 0) {
      const fadeTimer = setTimeout(() => {
        setExiting(true);
      }, toastData.duration - 300);

      return () => clearTimeout(fadeTimer);
    }
  }, [toastData.duration]);

  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-start gap-3 rounded-lg border px-4 py-3 shadow-lg backdrop-blur-sm transition-all duration-300 ${
        colorMap[toastData.type]
      } ${exiting ? 'translate-x-4 opacity-0' : 'translate-x-0 opacity-100'}`}
    >
      <Icon size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
      <p className="flex-1 text-sm text-deck-text">{toastData.message}</p>
      <button
        onClick={() => onDismiss(toastData.id)}
        className="shrink-0 rounded p-0.5 text-deck-muted transition-colors hover:text-deck-text"
        aria-label="Dismiss notification"
      >
        <X size={14} />
      </button>
    </div>
  );
}
