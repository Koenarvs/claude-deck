import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import {
  Search,
  Kanban,
  LayoutDashboard,
  List,
  Activity,
  BarChart3,
  Clock,
  Sparkles,
  FileText,
  Settings,
} from 'lucide-react';
import type { ReactNode } from 'react';

interface CommandItem {
  id: string;
  label: string;
  shortcut: string;
  route: string;
  icon: ReactNode;
}

const commands: CommandItem[] = [
  { id: 'board', label: 'Board', shortcut: 'G B', route: '/board', icon: <Kanban size={16} /> },
  { id: 'dashboard', label: 'Dashboard', shortcut: 'G D', route: '/dashboard', icon: <LayoutDashboard size={16} /> },
  { id: 'sessions', label: 'Sessions', shortcut: '', route: '/sessions', icon: <List size={16} /> },
  { id: 'feed', label: 'Feed', shortcut: 'G F', route: '/feed', icon: <Activity size={16} /> },
  { id: 'analytics', label: 'Analytics', shortcut: 'G A', route: '/analytics', icon: <BarChart3 size={16} /> },
  { id: 'scheduled', label: 'Scheduled', shortcut: '', route: '/scheduled', icon: <Clock size={16} /> },
  { id: 'skills', label: 'Skills', shortcut: '', route: '/skills', icon: <Sparkles size={16} /> },
  { id: 'claude-md', label: 'CLAUDE.md', shortcut: '', route: '/claude-md', icon: <FileText size={16} /> },
  { id: 'settings', label: 'Settings', shortcut: 'G S', route: '/settings', icon: <Settings size={16} /> },
];

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Command palette modal.
 * Opened via Cmd/Ctrl+K. Provides keyword-based navigation to routes.
 * Implements focus trap for accessibility.
 */
export default function CommandPalette({ isOpen, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const filtered = query.length === 0
    ? commands
    : commands.filter((cmd) =>
        cmd.label.toLowerCase().includes(query.toLowerCase()),
      );

  // Focus input on open
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      // Schedule focus after render
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [isOpen]);

  const executeCommand = useCallback(
    (cmd: CommandItem) => {
      navigate(cmd.route);
      onClose();
    },
    [navigate, onClose],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((prev) => (prev + 1) % Math.max(1, filtered.length));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((prev) =>
            prev <= 0 ? Math.max(0, filtered.length - 1) : prev - 1,
          );
          break;
        case 'Enter':
          e.preventDefault();
          if (filtered[selectedIndex]) {
            executeCommand(filtered[selectedIndex]);
          }
          break;
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
      }
    },
    [filtered, selectedIndex, executeCommand, onClose],
  );

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Palette */}
      <div
        className="fixed left-1/2 top-[20%] z-50 w-full max-w-md -translate-x-1/2 overflow-hidden rounded-xl border border-deck-border bg-deck-surface shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 border-b border-deck-border px-4 py-3">
          <Search size={18} className="text-deck-muted" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command..."
            className="flex-1 bg-transparent text-sm text-deck-text outline-none placeholder:text-deck-muted"
            aria-label="Search commands"
            aria-activedescendant={filtered[selectedIndex] ? `cmd-${filtered[selectedIndex].id}` : undefined}
            role="combobox"
            aria-expanded="true"
            aria-controls="command-list"
            aria-autocomplete="list"
          />
          <kbd className="rounded border border-deck-border px-1.5 py-0.5 text-xs text-deck-muted">
            Esc
          </kbd>
        </div>

        {/* Results list */}
        <ul
          id="command-list"
          className="max-h-72 overflow-y-auto py-2"
          role="listbox"
          aria-label="Available commands"
        >
          {filtered.length === 0 && (
            <li className="px-4 py-3 text-center text-sm text-deck-muted">No results</li>
          )}
          {filtered.map((cmd, idx) => (
            <li
              key={cmd.id}
              id={`cmd-${cmd.id}`}
              role="option"
              aria-selected={idx === selectedIndex}
              className={`flex cursor-pointer items-center gap-3 px-4 py-2 text-sm transition-colors ${
                idx === selectedIndex
                  ? 'bg-deck-accent/10 text-deck-text'
                  : 'text-deck-muted hover:bg-deck-border/50 hover:text-deck-text'
              }`}
              onClick={() => executeCommand(cmd)}
              onMouseEnter={() => setSelectedIndex(idx)}
            >
              <span className="shrink-0" aria-hidden="true">
                {cmd.icon}
              </span>
              <span className="flex-1">{cmd.label}</span>
              {cmd.shortcut && (
                <kbd className="text-xs text-deck-muted">{cmd.shortcut}</kbd>
              )}
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
