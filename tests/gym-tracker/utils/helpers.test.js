import { describe, it, expect } from 'vitest';
import {
  formatWeight,
  convertWeight,
  generateId,
  isToday,
  getWeekStart,
  getMonthStart,
  formatDuration,
  sortBy,
  groupBy,
  percentage,
  clamp,
} from '../../../apps/gym-tracker/js/utils/helpers.js';

describe('formatWeight', () => {
  it('formats with kg by default', () => {
    expect(formatWeight(100)).toBe('100kg');
  });

  it('formats with specified unit', () => {
    expect(formatWeight(220, 'lb')).toBe('220lb');
  });
});

describe('convertWeight', () => {
  it('kg to lb', () => {
    expect(convertWeight(100, 'kg', 'lb')).toBeCloseTo(220.5, 0);
  });

  it('lb to kg', () => {
    expect(convertWeight(220, 'lb', 'kg')).toBeCloseTo(99.8, 0);
  });

  it('same unit returns same value', () => {
    expect(convertWeight(100, 'kg', 'kg')).toBe(100);
    expect(convertWeight(220, 'lb', 'lb')).toBe(220);
  });

  it('unknown conversion returns original', () => {
    expect(convertWeight(100, 'kg', 'stone')).toBe(100);
  });
});

describe('generateId', () => {
  it('returns a string', () => {
    expect(typeof generateId()).toBe('string');
  });

  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});

describe('isToday', () => {
  it('returns true for today', () => {
    const today = new Date().toISOString().split('T')[0];
    expect(isToday(today)).toBe(true);
  });

  it('returns false for other dates', () => {
    expect(isToday('2020-01-01')).toBe(false);
  });
});

describe('getWeekStart', () => {
  it('returns Monday for a Wednesday', () => {
    const wed = new Date(2025, 0, 15); // Jan 15 2025 = Wednesday
    const start = getWeekStart(wed);
    expect(start.getDay()).toBe(1); // Monday
    expect(start.getDate()).toBe(13);
  });

  it('returns Monday for a Monday', () => {
    const mon = new Date(2025, 0, 13); // Jan 13 2025 = Monday
    const start = getWeekStart(mon);
    expect(start.getDay()).toBe(1);
    expect(start.getDate()).toBe(13);
  });

  it('returns previous Monday for a Sunday', () => {
    const sun = new Date(2025, 0, 19); // Jan 19 2025 = Sunday
    const start = getWeekStart(sun);
    expect(start.getDay()).toBe(1);
    expect(start.getDate()).toBe(13);
  });
});

describe('getMonthStart', () => {
  it('returns first of the month', () => {
    const date = new Date(2025, 5, 15);
    const start = getMonthStart(date);
    expect(start.getDate()).toBe(1);
    expect(start.getMonth()).toBe(5);
  });
});

describe('formatDuration', () => {
  it('formats seconds only', () => {
    expect(formatDuration(45)).toBe('45s');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(125)).toBe('2m 5s');
  });

  it('formats hours and minutes', () => {
    expect(formatDuration(3720)).toBe('1h 2m');
  });

  it('formats zero', () => {
    expect(formatDuration(0)).toBe('0s');
  });
});

describe('sortBy', () => {
  it('sorts ascending by default', () => {
    const arr = [{ name: 'c' }, { name: 'a' }, { name: 'b' }];
    const sorted = sortBy(arr, 'name');
    expect(sorted.map((x) => x.name)).toEqual(['a', 'b', 'c']);
  });

  it('sorts descending', () => {
    const arr = [{ val: 1 }, { val: 3 }, { val: 2 }];
    const sorted = sortBy(arr, 'val', 'desc');
    expect(sorted.map((x) => x.val)).toEqual([3, 2, 1]);
  });

  it('does not mutate original', () => {
    const arr = [{ val: 2 }, { val: 1 }];
    sortBy(arr, 'val');
    expect(arr[0].val).toBe(2);
  });

  it('handles case-insensitive string sorting', () => {
    const arr = [{ name: 'Banana' }, { name: 'apple' }];
    const sorted = sortBy(arr, 'name');
    expect(sorted[0].name).toBe('apple');
  });
});

describe('groupBy', () => {
  it('groups by key', () => {
    const arr = [
      { type: 'a', val: 1 },
      { type: 'b', val: 2 },
      { type: 'a', val: 3 },
    ];
    const grouped = groupBy(arr, 'type');
    expect(grouped.a).toHaveLength(2);
    expect(grouped.b).toHaveLength(1);
  });

  it('returns empty object for empty array', () => {
    expect(groupBy([], 'key')).toEqual({});
  });
});

describe('percentage', () => {
  it('calculates percentage', () => {
    expect(percentage(50, 200)).toBe(25);
  });

  it('rounds to integer', () => {
    expect(percentage(1, 3)).toBe(33);
  });

  it('returns 0 for zero total', () => {
    expect(percentage(5, 0)).toBe(0);
  });
});

describe('clamp', () => {
  it('clamps within range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it('clamps to min', () => {
    expect(clamp(-5, 0, 10)).toBe(0);
  });

  it('clamps to max', () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it('handles equal min and max', () => {
    expect(clamp(5, 3, 3)).toBe(3);
  });
});
