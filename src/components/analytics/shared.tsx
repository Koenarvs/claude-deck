import type { TimeRange } from '../../hooks/useAnalyticsData';

export const tooltipStyle = { backgroundColor: 'var(--cd-card)', border: '1px solid var(--cd-line)', color: 'var(--cd-fg)' };

export function TimeRangeSelector({ value, onChange }: { value: TimeRange; onChange: (v: TimeRange) => void }) {
  const options: { value: TimeRange; label: string }[] = [
    { value: '7d', label: '7 days' },
    { value: '30d', label: '30 days' },
    { value: '90d', label: '90 days' },
    { value: 'all', label: 'All time' },
  ];
  return (
    <div className="flex gap-1 rounded-md border border-line p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`rounded-sm px-3 py-1 text-xs font-medium transition-colors ${
            value === opt.value
              ? 'bg-accent text-accent-fg'
              : 'text-dim hover:text-fg'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function StatBox({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-line bg-card p-4">
      <p className="text-xs text-dim">{label}</p>
      <p className="mt-1 mono-tabular text-xl font-bold text-fg">{value}</p>
    </div>
  );
}

export function Empty({ text }: { text: string }) {
  return <p className="py-8 text-center text-sm text-faint">{text}</p>;
}

export function ChartError() {
  return <p data-testid="chart-error" className="py-8 text-center text-sm text-red-500">Failed to load data</p>;
}
