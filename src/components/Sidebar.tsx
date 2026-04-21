import { NavLink } from 'react-router';
import {
  Kanban,
  LayoutDashboard,
  List,
  BarChart3,
  Clock,
  Sparkles,
  FileText,
  Settings,
} from 'lucide-react';
import type { ReactNode } from 'react';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
}

const navItems: NavItem[] = [
  { to: '/board', label: 'Board', icon: <Kanban size={20} /> },
  { to: '/dashboard', label: 'Dashboard', icon: <LayoutDashboard size={20} /> },
  { to: '/sessions', label: 'Sessions', icon: <List size={20} /> },
  { to: '/analytics', label: 'Analytics', icon: <BarChart3 size={20} /> },
  { to: '/scheduled', label: 'Scheduled', icon: <Clock size={20} /> },
  { to: '/skills', label: 'Skills', icon: <Sparkles size={20} /> },
  { to: '/claude-md', label: 'CLAUDE.md', icon: <FileText size={20} /> },
  { to: '/settings', label: 'Settings', icon: <Settings size={20} /> },
];

export default function Sidebar() {
  return (
    <aside className="flex h-screen w-56 flex-col border-r border-deck-border bg-deck-surface">
      <div className="flex h-14 items-center px-4">
        <h1 className="text-lg font-semibold text-deck-text">claude-deck</h1>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 py-2">
        <ul className="space-y-1">
          {navItems.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-deck-accent text-white'
                      : 'text-deck-muted hover:bg-deck-border hover:text-deck-text'
                  }`
                }
              >
                {item.icon}
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}
