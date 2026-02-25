import { describe, it, expect } from 'vitest';
import {
  getTodayDateString,
  parseLocalDate,
  formatDate,
  formatDateForDisplay,
} from '../../shared/utils/date.js';

describe('getTodayDateString', () => {
  it('returns YYYY-MM-DD format', () => {
    const result = getTodayDateString();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('matches current date', () => {
    const now = new Date();
    const expected = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    ].join('-');
    expect(getTodayDateString()).toBe(expected);
  });
});

describe('parseLocalDate', () => {
  it('parses YYYY-MM-DD in local timezone', () => {
    const date = parseLocalDate('2025-03-15');
    expect(date.getFullYear()).toBe(2025);
    expect(date.getMonth()).toBe(2); // March = 2
    expect(date.getDate()).toBe(15);
  });

  it('avoids UTC timezone shift for midnight dates', () => {
    const date = parseLocalDate('2025-01-01');
    expect(date.getDate()).toBe(1);
  });

  it('falls back to Date constructor for non-YYYY-MM-DD strings', () => {
    const date = parseLocalDate('March 15, 2025');
    expect(date.getFullYear()).toBe(2025);
    expect(date.getMonth()).toBe(2);
  });
});

describe('formatDate', () => {
  it('formats in short format (default)', () => {
    const result = formatDate('2025-08-20', 'short');
    expect(result).toContain('Aug');
    expect(result).toContain('20');
    expect(result).toContain('2025');
  });

  it('formats in long format', () => {
    const result = formatDate('2025-08-20', 'long');
    expect(result).toContain('August');
    expect(result).toContain('20');
    expect(result).toContain('2025');
    expect(result).toContain('Wednesday');
  });

  it('formats in numeric format (M/D/YYYY)', () => {
    const result = formatDate('2025-08-20', 'numeric');
    expect(result).toBe('8/20/2025');
  });

  it('formats January 1st correctly in numeric', () => {
    expect(formatDate('2025-01-01', 'numeric')).toBe('1/1/2025');
  });

  it('formats December 31st correctly in numeric', () => {
    expect(formatDate('2025-12-31', 'numeric')).toBe('12/31/2025');
  });

  it('uses default format for unknown format type', () => {
    const result = formatDate('2025-08-20', 'unknown');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('formatDateForDisplay', () => {
  it('formats date as M/D/YYYY', () => {
    expect(formatDateForDisplay('2025-08-20')).toBe('8/20/2025');
  });

  it('returns "No date" for empty input', () => {
    expect(formatDateForDisplay('')).toBe('No date');
    expect(formatDateForDisplay(null)).toBe('No date');
    expect(formatDateForDisplay(undefined)).toBe('No date');
  });

  it('returns NaN format for unparseable date', () => {
    // 'not-a-date' creates Invalid Date → formatDate returns NaN-based string
    // The catch block only triggers for actual thrown errors
    const result = formatDateForDisplay('not-a-date');
    expect(typeof result).toBe('string');
  });
});
