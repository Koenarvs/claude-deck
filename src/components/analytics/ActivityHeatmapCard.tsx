import { Calendar } from 'lucide-react';
import type { HeatmapDay } from '../../lib/analytics-api';

export function ActivityHeatmapCard({ data, dayCount, rangeLabel }: { data: HeatmapDay[]; dayCount: number; rangeLabel: string }) {
  return (
    <div className="rounded-md border border-line bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <Calendar size={16} className="text-dim" />
        <h2 className="text-sm font-medium text-dim">Activity ({rangeLabel})</h2>
      </div>
      <ActivityHeatmap data={data} dayCount={dayCount} />
    </div>
  );
}

function ActivityHeatmap({ data, dayCount }: { data: HeatmapDay[]; dayCount: number }) {
  const today = new Date();
  const days: { date: string; count: number; dayOfWeek: number }[] = [];
  const countMap = new Map(data.map((d) => [d.date, d.count]));

  for (let i = dayCount - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    days.push({ date: dateStr, count: countMap.get(dateStr) ?? 0, dayOfWeek: d.getDay() });
  }

  const maxCount = Math.max(1, ...days.map((d) => d.count));

  function intensity(count: number): string {
    if (count === 0) return 'bg-inset';
    const ratio = count / maxCount;
    if (ratio <= 0.25) return 'bg-accent/20';
    if (ratio <= 0.5) return 'bg-accent/40';
    if (ratio <= 0.75) return 'bg-accent/70';
    return 'bg-accent';
  }

  // Group into weeks
  const weeks: typeof days[] = [];
  let currentWeek: typeof days = [];
  for (const day of days) {
    if (day.dayOfWeek === 0 && currentWeek.length > 0) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
    currentWeek.push(day);
  }
  if (currentWeek.length > 0) weeks.push(currentWeek);

  return (
    <div className="flex gap-1 overflow-x-auto">
      {weeks.map((week, wi) => (
        <div key={wi} className="flex flex-col gap-1">
          {week.map((day) => (
            <div
              key={day.date}
              className={`h-3 w-3 rounded-sm ${intensity(day.count)}`}
              title={`${day.date}: ${day.count} session${day.count !== 1 ? 's' : ''}`}
            />
          ))}
        </div>
      ))}
      <div className="ml-2 flex items-end gap-1 text-[10px] text-faint">
        <span>Less</span>
        <div className="h-3 w-3 rounded-sm bg-inset" />
        <div className="h-3 w-3 rounded-sm bg-accent/20" />
        <div className="h-3 w-3 rounded-sm bg-accent/40" />
        <div className="h-3 w-3 rounded-sm bg-accent/70" />
        <div className="h-3 w-3 rounded-sm bg-accent" />
        <span>More</span>
      </div>
    </div>
  );
}
