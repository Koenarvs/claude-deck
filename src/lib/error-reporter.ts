/**
 * Frontend error capture: forwards uncaught errors and unhandled rejections to
 * POST /api/client-errors, where they're logged through the server's pino
 * pipeline (and thus land in the persisted log files). Fire-and-forget with a
 * per-session cap so a render loop can't flood the server.
 */

const MAX_REPORTS_PER_SESSION = 20;
let reportsSent = 0;
let installed = false;

export interface ClientErrorReport {
  message: string;
  stack?: string;
  componentStack?: string;
  source?: 'window.onerror' | 'unhandledrejection' | 'error-boundary';
}

export function reportClientError(report: ClientErrorReport): void {
  if (reportsSent >= MAX_REPORTS_PER_SESSION) return;
  reportsSent += 1;
  try {
    void fetch('/api/client-errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...report,
        message: report.message.slice(0, 4000),
        url: window.location.href,
      }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    /* reporting must never throw */
  }
}

export function installGlobalErrorReporter(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('error', (event) => {
    reportClientError({
      message: event.message || String(event.error ?? 'unknown error'),
      ...(event.error instanceof Error && event.error.stack ? { stack: event.error.stack } : {}),
      source: 'window.onerror',
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason;
    reportClientError({
      message: reason instanceof Error ? reason.message : String(reason),
      ...(reason instanceof Error && reason.stack ? { stack: reason.stack } : {}),
      source: 'unhandledrejection',
    });
  });
}

/** Test seam. */
export function _resetForTesting(): void {
  reportsSent = 0;
  installed = false;
}
