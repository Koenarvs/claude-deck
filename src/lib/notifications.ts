/**
 * Browser Notifications API wrapper for approval alerts.
 *
 * - `requestPermission()` wraps `Notification.requestPermission()`
 * - `notify(title, body, options?)` creates a Notification if permission granted; no-op otherwise
 * - Handles the "default" permission state by returning without error
 */

/** Whether the browser supports the Notifications API. */
function isSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/** Current permission state, or `'denied'` if the API is unsupported. */
export function getPermission(): NotificationPermission {
  if (!isSupported()) return 'denied';
  return Notification.permission;
}

/**
 * Requests notification permission from the user.
 * Returns the resulting permission state.
 * If the API is unsupported, returns `'denied'` without throwing.
 */
export async function requestPermission(): Promise<NotificationPermission> {
  if (!isSupported()) return 'denied';
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

export interface NotifyOptions {
  icon?: string;
  tag?: string;
  requireInteraction?: boolean;
  onClick?: () => void;
}

/**
 * Fires a browser notification if permission is granted.
 * No-op if permission is `'default'` or `'denied'`, or if the API is unsupported.
 * Returns the Notification instance (if created) for testing purposes.
 */
export function notify(
  title: string,
  body: string,
  options?: NotifyOptions,
): Notification | null {
  if (!isSupported()) return null;
  if (Notification.permission !== 'granted') return null;

  const notification = new Notification(title, {
    body,
    icon: options?.icon,
    tag: options?.tag,
    requireInteraction: options?.requireInteraction,
  });

  if (options?.onClick) {
    notification.onclick = options.onClick;
  }

  return notification;
}
