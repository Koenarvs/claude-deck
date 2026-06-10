import { Navigate } from 'react-router';
import { useConfigStore } from '../stores/useConfigStore';

/** Index-route redirect to the user's configured home route ('/board' fallback). */
export default function HomeRedirect() {
  const home = useConfigStore((s) => s.config?.homeRoute) ?? '/board';
  return <Navigate to={home} replace />;
}
