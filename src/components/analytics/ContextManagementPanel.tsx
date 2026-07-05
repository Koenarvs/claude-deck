import type { ContextItem } from '../../lib/analytics-api';
import { Empty } from './shared';

export type ContextFilter = 'all' | 'skill' | 'mcp' | 'plugin' | 'hook';

const CONTEXT_FILTERS: Array<{ value: ContextFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'skill', label: 'Skills' },
  { value: 'mcp', label: 'MCP' },
  { value: 'plugin', label: 'Plugins' },
  { value: 'hook', label: 'Hooks' },
];

export function ContextManagementPanel({ items, filter, onFilterChange }: { items: ContextItem[]; filter: ContextFilter; onFilterChange: (f: ContextFilter) => void }) {
  const filtered = filter === 'all' ? items : items.filter((i) => i.type === filter);
  const sorted = [...filtered].sort((a, b) => b.usageCount - a.usageCount);
  const totalSize = items.reduce((sum, i) => sum + i.estimatedSize, 0);

  return (
    <>
      <div className="flex items-center justify-between">
        <p className="text-sm text-dim">{items.length} items, {formatSize(totalSize)} total</p>
        <div className="flex gap-1 rounded-md border border-line p-0.5">
          {CONTEXT_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => onFilterChange(f.value)}
              className={`rounded-sm px-3 py-1 text-xs font-medium transition-colors ${
                filter === f.value
                  ? 'bg-accent text-accent-fg'
                  : 'text-dim hover:text-fg'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-md border border-line bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-dim">
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Type</th>
              <th className="px-4 py-2 font-medium">Usage Count</th>
              <th className="px-4 py-2 font-medium">Last Used</th>
              <th className="px-4 py-2 font-medium">Est. Size</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((item) => (
              <tr
                key={`${item.type}-${item.name}`}
                className={`border-b border-line last:border-0 ${item.usageCount === 0 ? 'opacity-50' : ''}`}
                {...(item.usageCount === 0 ? { 'data-zero-usage': '' } : {})}
              >
                <td className="px-4 py-2 text-fg">{item.name}</td>
                <td className="px-4 py-2 text-dim">{item.type}</td>
                <td className="px-4 py-2 mono-tabular text-fg">{item.usageCount}</td>
                <td className="px-4 py-2 text-dim">{item.lastUsed ? formatRelativeTime(item.lastUsed) : '–'}</td>
                <td className="px-4 py-2 mono-tabular text-dim">{formatSize(item.estimatedSize)}</td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr><td colSpan={5}><Empty text="No items found" /></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function formatSize(chars: number): string {
  if (chars === 0) return '0';
  if (chars < 1000) return `${chars}`;
  return `${(chars / 1000).toFixed(1)}K`;
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
