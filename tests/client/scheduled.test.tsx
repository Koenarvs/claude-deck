import { describe, it, expect } from 'vitest';
import {
  parseNextFireTimes,
  isValidCronField,
  describeCron,
} from '../../src/components/scheduled/CronPicker';

// ── CronPicker: parseNextFireTimes ───────────────────────────────────────────

describe('parseNextFireTimes', () => {
  it('returns null for empty input', () => {
    expect(parseNextFireTimes('', 5)).toBeNull();
  });

  it('returns null for invalid expression with wrong field count', () => {
    expect(parseNextFireTimes('* * *', 5)).toBeNull();
    expect(parseNextFireTimes('* * * * * *', 5)).toBeNull();
  });

  it('returns null for "foo bar" (invalid tokens)', () => {
    expect(parseNextFireTimes('foo bar baz qux quux', 5)).toBeNull();
  });

  it('returns null for invalid cron field values', () => {
    expect(parseNextFireTimes('60 * * * *', 5)).toBeNull(); // minute > 59
    expect(parseNextFireTimes('* 25 * * *', 5)).toBeNull(); // hour > 23
    expect(parseNextFireTimes('* * 32 * *', 5)).toBeNull(); // day > 31
    expect(parseNextFireTimes('* * * 13 *', 5)).toBeNull(); // month > 12
    expect(parseNextFireTimes('* * * * 8', 5)).toBeNull();  // dow > 7
  });

  it('returns 5 fire times for "*/5 * * * *"', () => {
    const times = parseNextFireTimes('*/5 * * * *', 5);
    expect(times).not.toBeNull();
    expect(times).toHaveLength(5);

    // Each time should be 5 minutes apart
    for (let i = 1; i < times!.length; i++) {
      const diff = times![i].getTime() - times![i - 1].getTime();
      expect(diff).toBe(5 * 60 * 1000);
    }
  });

  it('returns fire times for "* * * * *" (every minute)', () => {
    const times = parseNextFireTimes('* * * * *', 5);
    expect(times).not.toBeNull();
    expect(times).toHaveLength(5);

    // Each time should be 1 minute apart
    for (let i = 1; i < times!.length; i++) {
      const diff = times![i].getTime() - times![i - 1].getTime();
      expect(diff).toBe(60 * 1000);
    }
  });

  it('returns fire times for "0 * * * *" (every hour)', () => {
    const times = parseNextFireTimes('0 * * * *', 5);
    expect(times).not.toBeNull();
    expect(times).toHaveLength(5);

    // Each time should be 1 hour apart
    for (let i = 1; i < times!.length; i++) {
      const diff = times![i].getTime() - times![i - 1].getTime();
      expect(diff).toBe(60 * 60 * 1000);
    }
  });

  it('returns fire times for "0 9 * * 1-5" (weekdays at 9 AM)', () => {
    const times = parseNextFireTimes('0 9 * * 1-5', 5);
    expect(times).not.toBeNull();
    expect(times).toHaveLength(5);

    for (const time of times!) {
      expect(time.getHours()).toBe(9);
      expect(time.getMinutes()).toBe(0);
      const dow = time.getDay();
      expect(dow).toBeGreaterThanOrEqual(1);
      expect(dow).toBeLessThanOrEqual(5);
    }
  });

  it('handles comma-separated values', () => {
    const times = parseNextFireTimes('0,30 * * * *', 5);
    expect(times).not.toBeNull();
    expect(times).toHaveLength(5);

    for (const time of times!) {
      expect([0, 30]).toContain(time.getMinutes());
    }
  });

  it('returns fire times in chronological order', () => {
    const times = parseNextFireTimes('*/15 * * * *', 5);
    expect(times).not.toBeNull();

    for (let i = 1; i < times!.length; i++) {
      expect(times![i].getTime()).toBeGreaterThan(times![i - 1].getTime());
    }
  });

  it('all fire times are in the future', () => {
    const now = Date.now();
    const times = parseNextFireTimes('*/5 * * * *', 5);
    expect(times).not.toBeNull();

    for (const time of times!) {
      expect(time.getTime()).toBeGreaterThan(now);
    }
  });
});

// ── CronPicker: isValidCronField ─────────────────────────────────────────────

describe('isValidCronField', () => {
  it('accepts wildcard', () => {
    expect(isValidCronField('*', 0, 59)).toBe(true);
  });

  it('accepts simple number in range', () => {
    expect(isValidCronField('5', 0, 59)).toBe(true);
    expect(isValidCronField('0', 0, 59)).toBe(true);
    expect(isValidCronField('59', 0, 59)).toBe(true);
  });

  it('rejects number out of range', () => {
    expect(isValidCronField('60', 0, 59)).toBe(false);
    expect(isValidCronField('-1', 0, 59)).toBe(false);
  });

  it('accepts step values', () => {
    expect(isValidCronField('*/5', 0, 59)).toBe(true);
    expect(isValidCronField('*/1', 0, 59)).toBe(true);
  });

  it('rejects invalid step values', () => {
    expect(isValidCronField('*/0', 0, 59)).toBe(false);
    expect(isValidCronField('*/-1', 0, 59)).toBe(false);
  });

  it('accepts range', () => {
    expect(isValidCronField('1-5', 0, 59)).toBe(true);
    expect(isValidCronField('0-23', 0, 23)).toBe(true);
  });

  it('rejects reversed range', () => {
    expect(isValidCronField('5-1', 0, 59)).toBe(false);
  });

  it('accepts range with step', () => {
    expect(isValidCronField('1-30/5', 0, 59)).toBe(true);
  });

  it('accepts comma-separated values', () => {
    expect(isValidCronField('1,5,10', 0, 59)).toBe(true);
    expect(isValidCronField('0,30', 0, 59)).toBe(true);
  });

  it('rejects comma-separated with out-of-range values', () => {
    expect(isValidCronField('1,60', 0, 59)).toBe(false);
  });

  it('rejects non-numeric values', () => {
    expect(isValidCronField('abc', 0, 59)).toBe(false);
    expect(isValidCronField('foo', 0, 59)).toBe(false);
  });
});

// ── CronPicker: describeCron ─────────────────────────────────────────────────

describe('describeCron', () => {
  it('describes "* * * * *" as every minute', () => {
    expect(describeCron('* * * * *')).toBe('Every minute');
  });

  it('describes "*/5 * * * *" as every 5 minutes', () => {
    expect(describeCron('*/5 * * * *')).toBe('Every 5 minutes');
  });

  it('describes presets with their labels', () => {
    expect(describeCron('0 0 * * *')).toBe('Every day at midnight');
    expect(describeCron('0 9 * * 1')).toBe('Every Monday at 9 AM');
  });

  it('returns Invalid expression for wrong field count', () => {
    expect(describeCron('* *')).toBe('Invalid expression');
  });
});
