import { useEffect } from 'react';
import { Outlet } from 'react-router';
import { useWsManager } from './lib/ws-manager';
import { useConfigStore } from './stores/useConfigStore';
import AppShell from './components/AppShell';

export default function App() {
  useWsManager();
  const setConfig = useConfigStore((s) => s.setConfig);
  // Boot-load app config so the index route can honor the persisted home route.
  useEffect(() => {
    fetch('/api/config').then((r) => r.json()).then(setConfig).catch(() => {});
  }, [setConfig]);

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
