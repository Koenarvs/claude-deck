import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportClientError } from '../../lib/error-reporter';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Top-level render-error catcher: reports to /api/client-errors (persisted via
 * the server logger) and shows a recoverable fallback instead of a white page.
 */
export default class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    reportClientError({
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
      ...(info.componentStack ? { componentStack: info.componentStack } : {}),
      source: 'error-boundary',
    });
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <p className="max-w-lg text-sm opacity-70">
            The error was reported to the server log. Reloading usually recovers.
          </p>
          <pre className="max-w-2xl overflow-auto rounded border border-red-500/40 bg-red-500/10 p-3 text-left text-xs">
            {this.state.error.message}
          </pre>
          <button
            type="button"
            className="rounded-md border px-4 py-2 text-sm"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
