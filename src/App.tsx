import { useEffect } from 'react';
import { Outlet } from 'react-router';
import { useWsManager } from './lib/ws-manager';
import { useConfigStore } from './stores/useConfigStore';
import AppShell from './components/AppShell';

export default function App() {
  useWsManager();
  const setConfig = useConfigStore((s) => s.setConfig);
  const setCatalog = useConfigStore((s) => s.setCatalog);
  // Boot-load app config so the index route can honor the persisted home route
  // and every model picker can read the provider catalog.
  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((data) => {
        setConfig(data);
        if (Array.isArray(data?.catalog)) setCatalog(data.catalog);
      })
      .catch(() => {});
  }, [setConfig, setCatalog]);

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
