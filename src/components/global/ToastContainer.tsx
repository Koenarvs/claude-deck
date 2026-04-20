import { useToastStore } from '../../lib/toast-store';
import Toast from './Toast';

/**
 * Renders a stack of toast notifications in the bottom-right corner.
 * Visible on every route. Up to 5 toasts shown at once.
 */
export default function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2"
      aria-label="Notifications"
    >
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} onDismiss={removeToast} />
      ))}
    </div>
  );
}
