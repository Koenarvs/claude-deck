import type { ReactNode } from 'react';
import Sidebar from './Sidebar';

import ConnectionIndicator from './global/ConnectionIndicator';
import ToastContainer from './global/ToastContainer';
import CommandPalette from './global/CommandPalette';
import TweaksPanel from './global/TweaksPanel';
import GlobalApprovalQueue from './global/GlobalApprovalQueue';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useApplyUIConfig } from '../hooks/useApplyUIConfig';
import { useUIConfigStore } from '../stores/useUIConfigStore';

interface AppShellProps {
  children: ReactNode;
}

export default function AppShell({ children }: AppShellProps) {
  const { isCommandPaletteOpen, closeCommandPalette } = useKeyboardShortcuts();
  const tweaksOpen = useUIConfigStore((s) => s.tweaksOpen);

  useApplyUIConfig();

  return (
    <div className="flex h-screen bg-bg text-fg">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {children}
      </main>

      {/* Global overlays */}
      <ConnectionIndicator />
      <ToastContainer />
      <GlobalApprovalQueue />
      <CommandPalette
        isOpen={isCommandPaletteOpen}
        onClose={closeCommandPalette}
      />
      {tweaksOpen && <TweaksPanel />}
    </div>
  );
}
