import { Outlet } from 'react-router';
import { useWsManager } from './lib/ws-manager';
import AppShell from './components/AppShell';

export default function App() {
  useWsManager();

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
