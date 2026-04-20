import { useState } from 'react';
import { Home, Kanban, LayoutDashboard } from 'lucide-react';

interface HomeRouteToggleProps {
  currentRoute: string;
  onRouteChange: (route: string) => void;
}

const ROUTE_OPTIONS: Array<{ value: string; label: string; icon: typeof Kanban }> = [
  { value: '/board', label: 'Kanban Board', icon: Kanban },
  { value: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
];

export default function HomeRouteToggle({ currentRoute, onRouteChange }: HomeRouteToggleProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleChange = async (route: string) => {
    if (route === currentRoute) return;

    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ homeRoute: route }),
      });
      if (!res.ok) throw new Error(`Failed to update: ${res.statusText}`);
      onRouteChange(route);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-deck-border bg-deck-surface p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-deck-text">
        <Home size={16} className="text-deck-accent" />
        Home Route
      </h3>
      <p className="mt-1 text-xs text-deck-muted">
        Choose which page loads when you navigate to the root URL.
      </p>

      <div className="mt-3 flex gap-2">
        {ROUTE_OPTIONS.map((opt) => {
          const Icon = opt.icon;
          const isSelected = currentRoute === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => void handleChange(opt.value)}
              disabled={saving}
              className={`flex flex-1 items-center justify-center gap-2 rounded-md border px-3 py-2.5 text-sm font-medium transition-colors disabled:opacity-50 ${
                isSelected
                  ? 'border-deck-accent bg-deck-accent/10 text-deck-accent'
                  : 'border-deck-border text-deck-muted hover:border-deck-accent/50 hover:text-deck-text'
              }`}
              aria-pressed={isSelected}
            >
              <Icon size={16} />
              {opt.label}
            </button>
          );
        })}
      </div>

      {error && <p className="mt-2 text-xs text-deck-danger">{error}</p>}

      <p className="mt-2 text-xs text-deck-muted">
        Current: navigating to <code>/</code> redirects to <code>{currentRoute}</code>
      </p>
    </div>
  );
}
