import { useEffect } from 'react';
import { Outlet } from 'react-router';
import { apiGet } from './lib/api';
import { useWsManager } from './lib/ws-manager';
import type { AppConfig } from './shared/types';
import type { AgentCatalogEntry } from './shared/agents/types';
import { useConfigStore } from './stores/useConfigStore';
import AppShell from './components/AppShell';

export default function App() {
  useWsManager();
  const setConfig = useConfigStore((s) => s.setConfig);
  const setCatalog = useConfigStore((s) => s.setCatalog);
  // Boot-load app config so the index route can honor the persisted home route
  // and every model picker can read the provider catalog. Re-fetched periodically
  // (not just once at boot) because the catalog's live model lists (e.g. Claude's
  // /v1/models) can fail transiently (ECONNRESET) — a single unlucky boot fetch
  // would otherwise wedge the picker on the static fallback for the whole session.
  useEffect(() => {
    const loadConfig = (): void => {
      apiGet<AppConfig & { catalog?: AgentCatalogEntry[] }>('/api/config')
        .then((data) => {
          setConfig(data);
          if (Array.isArray(data?.catalog)) setCatalog(data.catalog);
        })
        .catch(() => {});
    };
    loadConfig();
    const interval = setInterval(loadConfig, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [setConfig, setCatalog]);

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
