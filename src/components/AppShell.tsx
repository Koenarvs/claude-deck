import type { ReactNode } from 'react';
import Sidebar from './Sidebar';
import GlobalApprovalQueue from './global/GlobalApprovalQueue';
import ConnectionIndicator from './global/ConnectionIndicator';
import ToastContainer from './global/ToastContainer';
import CommandPalette from './global/CommandPalette';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';

interface AppShellProps {
  children: ReactNode;
}

export default function AppShell({ children }: AppShellProps) {
  const { isCommandPaletteOpen, closeCommandPalette } = useKeyboardShortcuts();

  return (
    <div className="flex h-screen bg-deck-bg">
      <Sidebar />
      <main className="flex-1 overflow-y-auto p-6">{children}</main>

      {/* Global overlays — visible on every route */}
      <GlobalApprovalQueue />
      <ConnectionIndicator />
      <ToastContainer />
      <CommandPalette isOpen={isCommandPaletteOpen} onClose={closeCommandPalette} />
    </div>
  );
}
