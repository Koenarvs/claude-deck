import { useState, useEffect, useCallback } from 'react';
import { AlertCircle, Clock } from 'lucide-react';

/** Common cron presets for quick selection. */
const PRESETS: Array<{ label: string; expr: string }> = [
  { label: 'Every minute', expr: '* * * * *' },
  { label: 'Every 5 minutes', expr: '*/5 * * * *' },
  { label: 'Every 15 minutes', expr: '*/15 * * * *' },
  { label: 'Every hour', expr: '0 * * * *' },
  { label: 'Every day at midnight', expr: '0 0 * * *' },
  { label: 'Every day at 9 AM', expr: '0 9 * * *' },
  { label: 'Every Monday at 9 AM', expr: '0 9 * * 1' },
  { label: 'Every weekday at 9 AM', expr: '0 9 * * 1-5' },
];

interface CronPickerProps {
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
}

/**
 * Parses a cron expression and returns the next N fire times.
 * Uses a simple field-level parser rather than requiring cron-parser at runtime.
 */
function parseNextFireTimes(expr: string, count: number): Date[] | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  // Validate each field
  const ranges = [
    { min: 0, max: 59, name: 'minute' },
    { min: 0, max: 23, name: 'hour' },
    { min: 1, max: 31, name: 'day of month' },
    { min: 1, max: 12, name: 'month' },
    { min: 0, max: 7, name: 'day of week' },
  ];

  for (let i = 0; i < 5; i++) {
    if (!isValidCronField(parts[i], ranges[i].min, ranges[i].max)) {
      return null;
    }
  }

  // Expand each field to a set of valid values
  const expandedFields = parts.map((part, i) =>
    expandCronField(part, ranges[i].min, ranges[i].max),
  );

  if (expandedFields.some((f) => f === null)) return null;

  const validMinutes = expandedFields[0] as Set<number>;
  const validHours = expandedFields[1] as Set<number>;
  const validDays = expandedFields[2] as Set<number>;
  const validMonths = expandedFields[3] as Set<number>;
  const validDows = expandedFields[4] as Set<number>;

  // Normalize day-of-week: 7 -> 0 (both mean Sunday)
  if (validDows.has(7)) {
    validDows.add(0);
    validDows.delete(7);
  }

  const results: Date[] = [];
  const now = new Date();
  const candidate = new Date(now);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  // Limit iterations to prevent infinite loops on impossible expressions
  const maxIterations = 525960; // ~1 year of minutes
  let iterations = 0;

  while (results.length < count && iterations < maxIterations) {
    iterations++;
    const month = candidate.getMonth() + 1;
    const day = candidate.getDate();
    const dow = candidate.getDay();
    const hour = candidate.getHours();
    const minute = candidate.getMinutes();

    if (
      validMonths.has(month) &&
      validDays.has(day) &&
      validDows.has(dow) &&
      validHours.has(hour) &&
      validMinutes.has(minute)
    ) {
      results.push(new Date(candidate));
    }

    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  return results.length > 0 ? results : null;
}

/** Validates a single cron field (e.g., star-slash-5, "1-3,7", "0"). */
function isValidCronField(field: string, min: number, max: number): boolean {
  if (field === '*') return true;

  // Handle comma-separated lists
  const parts = field.split(',');
  for (const part of parts) {
    // Handle step values: */2 or 1-5/2
    const stepParts = part.split('/');
    if (stepParts.length > 2) return false;

    if (stepParts.length === 2) {
      const step = parseInt(stepParts[1], 10);
      if (isNaN(step) || step < 1) return false;
    }

    const rangePart = stepParts[0];

    if (rangePart === '*') continue;

    // Handle ranges: 1-5
    const rangePieces = rangePart.split('-');
    if (rangePieces.length > 2) return false;

    for (const piece of rangePieces) {
      const num = parseInt(piece, 10);
      if (isNaN(num) || num < min || num > max) return false;
    }

    if (rangePieces.length === 2) {
      const start = parseInt(rangePieces[0], 10);
      const end = parseInt(rangePieces[1], 10);
      if (start > end) return false;
    }
  }

  return true;
}

/** Expands a cron field to a set of matching values. */
function expandCronField(field: string, min: number, max: number): Set<number> | null {
  const result = new Set<number>();

  const parts = field.split(',');
  for (const part of parts) {
    const stepParts = part.split('/');
    const rangePart = stepParts[0];
    const step = stepParts.length === 2 ? parseInt(stepParts[1], 10) : 1;

    if (isNaN(step) || step < 1) return null;

    let start: number;
    let end: number;

    if (rangePart === '*') {
      start = min;
      end = max;
    } else if (rangePart.includes('-')) {
      const [s, e] = rangePart.split('-').map(Number);
      if (isNaN(s) || isNaN(e)) return null;
      start = s;
      end = e;
    } else {
      const num = parseInt(rangePart, 10);
      if (isNaN(num)) return null;
      start = num;
      end = stepParts.length === 2 ? max : num;
    }

    for (let i = start; i <= end; i += step) {
      result.add(i);
    }
  }

  return result;
}

/** Describes a cron expression in human-readable terms. */
function describeCron(expr: string): string {
  const trimmed = expr.trim();
  const preset = PRESETS.find((p) => p.expr === trimmed);
  if (preset) return preset.label;

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return 'Invalid expression';

  // Simple description for common patterns
  const [minute, hour, dom, month, dow] = parts;

  if (minute === '*' && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return 'Every minute';
  }
  if (minute.startsWith('*/') && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return `Every ${minute.slice(2)} minutes`;
  }
  if (hour.startsWith('*/') && dom === '*' && month === '*' && dow === '*') {
    return `Every ${hour.slice(2)} hours at minute ${minute}`;
  }

  return `At ${minute} min, ${hour} hr, day ${dom}, month ${month}, dow ${dow}`;
}

export default function CronPicker({ value, onChange, error: externalError }: CronPickerProps) {
  const [nextTimes, setNextTimes] = useState<Date[] | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [showPresets, setShowPresets] = useState(false);

  const validate = useCallback((expr: string) => {
    if (!expr.trim()) {
      setValidationError(null);
      setNextTimes(null);
      return;
    }

    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) {
      setValidationError('Cron expression must have exactly 5 fields (minute hour day month weekday)');
      setNextTimes(null);
      return;
    }

    const times = parseNextFireTimes(expr, 5);
    if (times === null) {
      setValidationError('Invalid cron expression');
      setNextTimes(null);
    } else {
      setValidationError(null);
      setNextTimes(times);
    }
  }, []);

  useEffect(() => {
    validate(value);
  }, [value, validate]);

  const displayError = externalError ?? validationError;
  const isInvalid = displayError !== null && value.trim().length > 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="*/5 * * * *"
            aria-label="Cron expression"
            aria-invalid={isInvalid}
            className={`w-full rounded-md border bg-deck-bg px-3 py-2 font-mono text-sm text-deck-text placeholder-deck-muted focus:outline-none focus:ring-2 ${
              isInvalid
                ? 'border-deck-danger focus:ring-deck-danger'
                : 'border-deck-border focus:ring-deck-accent'
            }`}
          />
        </div>
        <button
          type="button"
          onClick={() => setShowPresets(!showPresets)}
          className="rounded-md border border-deck-border bg-deck-surface px-3 py-2 text-sm text-deck-muted hover:bg-deck-border hover:text-deck-text"
          aria-label="Show presets"
        >
          <Clock size={16} />
        </button>
      </div>

      {showPresets && (
        <div className="rounded-md border border-deck-border bg-deck-surface p-2">
          <div className="grid grid-cols-2 gap-1">
            {PRESETS.map((preset) => (
              <button
                key={preset.expr}
                type="button"
                onClick={() => {
                  onChange(preset.expr);
                  setShowPresets(false);
                }}
                className={`rounded px-2 py-1 text-left text-xs transition-colors ${
                  value === preset.expr
                    ? 'bg-deck-accent text-white'
                    : 'text-deck-muted hover:bg-deck-border hover:text-deck-text'
                }`}
              >
                <span className="font-mono">{preset.expr}</span>
                <span className="ml-2 text-deck-muted">{preset.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {isInvalid && (
        <div className="flex items-center gap-1 text-xs text-deck-danger" role="alert">
          <AlertCircle size={12} />
          <span>{displayError}</span>
        </div>
      )}

      {!isInvalid && value.trim() && (
        <p className="text-xs text-deck-muted">{describeCron(value)}</p>
      )}

      {nextTimes && nextTimes.length > 0 && !isInvalid && (
        <div className="rounded-md border border-deck-border bg-deck-bg p-2">
          <p className="mb-1 text-xs font-medium text-deck-muted">Next 5 fire times:</p>
          <ul className="space-y-0.5">
            {nextTimes.map((time, i) => (
              <li key={i} className="font-mono text-xs text-deck-text">
                {time.toLocaleString()}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export { parseNextFireTimes, isValidCronField, describeCron };
