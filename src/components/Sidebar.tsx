import { useState, useEffect } from 'react';
import { NavLink } from 'react-router';
import {
  LayoutGrid,
  Layers,
  Gauge,
  Clock,
  Sparkles,
  Settings,
  Search,
} from 'lucide-react';
import { useSessionsStore } from '../stores/useSessionsStore';
import { useApprovalsStore } from '../stores/useApprovalsStore';

interface NavItem {
  to: string;
  label: string;
  icon: React.ReactNode;
  badgeKey?: 'approvals' | 'active';
  accent?: boolean;
}

const navItems: NavItem[] = [
  { to: '/board', label: 'Board', icon: <LayoutGrid size={15} />, badgeKey: 'approvals', accent: true },
  { to: '/sessions', label: 'Sessions', icon: <Layers size={15} /> },
  { to: '/analytics', label: 'Analytics', icon: <Gauge size={15} /> },
  { to: '/scheduled', label: 'Scheduled', icon: <Clock size={15} /> },
  { to: '/skills', label: 'Skills', icon: <Sparkles size={15} /> },
  { to: '/settings', label: 'Settings', icon: <Settings size={15} /> },
];

export default function Sidebar() {
  const activeSessions = useSessionsStore(
    (s) => s.sessions.filter((x) => x.ended_at === null).length,
  );
  const pendingApprovals = useApprovalsStore((s) => s.pending.length);

  const badgeFor = (k?: 'approvals' | 'active') => {
    if (k === 'approvals') return pendingApprovals;
    if (k === 'active') return activeSessions;
    return 0;
  };

  return (
    <aside className="flex h-full w-[220px] shrink-0 flex-col border-r border-line bg-surface px-2.5 py-3.5">
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-2 pb-4 pt-1">
        <div className="flex h-[26px] w-[26px] items-center justify-center rounded-md bg-accent text-[13px] font-bold tracking-tight text-accent-fg">
          C
        </div>
        <div className="leading-tight">
          <div className="text-[13px] font-semibold tracking-tight text-fg">
            Claude Deck
          </div>
          <div className="mono-tabular text-[10px] text-faint">v0.1.0 · local</div>
        </div>
      </div>

      {/* Search */}
      <button
        type="button"
        className="mb-3.5 flex items-center justify-between rounded-md border border-line bg-surface px-3 py-1.5 text-[13px] text-faint transition-colors hover:border-line-strong hover:bg-hover"
      >
        <span className="flex items-center gap-2">
          <Search size={13} /> Search…
        </span>
        <kbd className="mono-tabular rounded border border-line bg-inset px-1 text-[10px] text-dim">
          ⌘K
        </kbd>
      </button>

      {/* Nav */}
      <nav className="flex flex-col gap-[1px]">
        {navItems.map((n) => {
          const badge = badgeFor(n.badgeKey);
          return (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                `relative flex items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13px] transition-colors ${
                  isActive
                    ? 'bg-hover font-medium text-fg'
                    : 'font-normal text-dim hover:bg-hover hover:text-fg'
                }`
              }
            >
              {n.icon}
              <span className="flex-1">{n.label}</span>
              {badge > 0 && (
                <span
                  className={`mono-tabular min-w-[18px] rounded-full px-1.5 text-center text-[10px] font-semibold leading-[16px] ${
                    n.accent
                      ? 'bg-accent text-accent-fg'
                      : 'border border-line bg-inset text-dim'
                  }`}
                >
                  {badge}
                </span>
              )}
            </NavLink>
          );
        })}
      </nav>

      {/* Footer: today strip */}
      <div className="mt-auto flex flex-col gap-2">
        <UsageStrip />
        <ConnectedStrip />
      </div>
    </aside>
  );
}

function UsageStrip() {
  const [todayCost, setTodayCost] = useState(0);
  const [newTokens, setNewTokens] = useState(0);
  const [cachedTokens, setCachedTokens] = useState(0);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/sessions?limit=50');
        if (!res.ok) return;
        const sessions = (await res.json()) as Array<Record<string, unknown>>;

        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todaySessions = sessions.filter(
          (s) => ((s.started_at as number) ?? 0) >= todayStart.getTime(),
        );

        let cost = 0;
        let fresh = 0;
        let cached = 0;
        await Promise.all(
          todaySessions.map(async (s) => {
            try {
              const uRes = await fetch(`/api/sessions/${s.id}/usage`);
              if (!uRes.ok) return;
              const u = (await uRes.json()) as Record<string, number>;
              cost += u.estimatedCostUsd ?? 0;
              fresh += (u.inputTokens ?? 0) + (u.cacheCreationTokens ?? 0) + (u.outputTokens ?? 0);
              cached += u.cacheReadTokens ?? 0;
            } catch {}
          }),
        );

        setTodayCost(cost);
        setNewTokens(fresh);
        setCachedTokens(cached);
      } catch {}
    }
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, []);

  const fmt = (n: number) =>
    n === 0 ? '0' : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : String(n);

  return (
    <div className="rounded-md border border-line bg-card p-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="mono-tabular text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">
          Today
        </span>
        <span className="mono-tabular text-[11px] text-fg">
          {todayCost === 0 ? '$0.00' : `$${todayCost.toFixed(2)}`}
        </span>
      </div>
      <div className="flex items-center justify-between">
        <span className="mono-tabular text-[10px] text-dim">{fmt(newTokens)} new</span>
        <span className="mono-tabular text-[10px] text-faint">{fmt(cachedTokens)} cached</span>
      </div>
    </div>
  );
}

function ConnectedStrip() {
  return (
    <div className="flex items-center gap-2 px-2 py-1">
      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line bg-accent-soft text-[10px] font-semibold text-accent">
        —
      </div>
      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="truncate text-[12px] font-medium text-fg">Local</div>
        <div className="mono-tabular whitespace-nowrap text-[10px] text-faint">
          <span className="pulse-dot mr-1.5 !h-[5px] !w-[5px] align-middle" />
          connected · :4100
        </div>
      </div>
    </div>
  );
}
