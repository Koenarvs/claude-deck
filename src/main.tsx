import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createBrowserRouter } from 'react-router';
import { routes } from './routes';
import ErrorBoundary from './components/global/ErrorBoundary';
import { installGlobalErrorReporter } from './lib/error-reporter';
import './main.css';

installGlobalErrorReporter();

const router = createBrowserRouter(routes);

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary>
      <RouterProvider router={router} />
    </ErrorBoundary>
  </StrictMode>,
);
