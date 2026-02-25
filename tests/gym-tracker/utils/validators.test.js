import { describe, it, expect } from 'vitest';
import {
  validateProgramName,
  validateWorkoutDayName,
  validateExerciseSelection,
  validateSets,
  validateReps,
  validateWeight,
  validateDate,
  validateHeartRate,
  validateCalories,
  validateRestTime,
  validateImportData,
} from '../../../apps/gym-tracker/js/utils/validators.js';

describe('validateProgramName', () => {
  it('returns null for valid name', () => {
    expect(validateProgramName('Push Day')).toBeNull();
  });

  it('rejects empty name', () => {
    expect(validateProgramName('')).toBeTruthy();
    expect(validateProgramName('   ')).toBeTruthy();
  });

  it('rejects null/undefined', () => {
    expect(validateProgramName(null)).toBeTruthy();
    expect(validateProgramName(undefined)).toBeTruthy();
  });

  it('rejects names over 50 characters', () => {
    expect(validateProgramName('a'.repeat(51))).toBeTruthy();
  });

  it('accepts 50-character name', () => {
    expect(validateProgramName('a'.repeat(50))).toBeNull();
  });
});

describe('validateWorkoutDayName', () => {
  it('returns null for valid name', () => {
    expect(validateWorkoutDayName('Leg Day')).toBeNull();
  });

  it('rejects empty name', () => {
    expect(validateWorkoutDayName('')).toBeTruthy();
  });

  it('rejects names over 50 characters', () => {
    expect(validateWorkoutDayName('a'.repeat(51))).toBeTruthy();
  });
});

describe('validateExerciseSelection', () => {
  it('returns null for valid id', () => {
    expect(validateExerciseSelection('bench-press')).toBeNull();
  });

  it('rejects falsy values', () => {
    expect(validateExerciseSelection(null)).toBeTruthy();
    expect(validateExerciseSelection('')).toBeTruthy();
    expect(validateExerciseSelection(undefined)).toBeTruthy();
  });
});

describe('validateSets', () => {
  it('returns null for valid range (1-20)', () => {
    expect(validateSets(1)).toBeNull();
    expect(validateSets(10)).toBeNull();
    expect(validateSets(20)).toBeNull();
  });

  it('rejects 0 and below', () => {
    expect(validateSets(0)).toBeTruthy();
    expect(validateSets(-1)).toBeTruthy();
  });

  it('rejects above 20', () => {
    expect(validateSets(21)).toBeTruthy();
  });
});

describe('validateReps', () => {
  it('returns null for valid range (1-100)', () => {
    expect(validateReps(1)).toBeNull();
    expect(validateReps(50)).toBeNull();
    expect(validateReps(100)).toBeNull();
  });

  it('rejects 0 and below', () => {
    expect(validateReps(0)).toBeTruthy();
  });

  it('rejects above 100', () => {
    expect(validateReps(101)).toBeTruthy();
  });
});

describe('validateWeight', () => {
  it('returns null for valid range (0-1000)', () => {
    expect(validateWeight(0)).toBeNull();
    expect(validateWeight(100)).toBeNull();
    expect(validateWeight(1000)).toBeNull();
  });

  it('rejects negative weight', () => {
    expect(validateWeight(-1)).toBeTruthy();
  });

  it('rejects above 1000', () => {
    expect(validateWeight(1001)).toBeTruthy();
  });

  it('rejects null/undefined', () => {
    expect(validateWeight(null)).toBeTruthy();
    expect(validateWeight(undefined)).toBeTruthy();
  });
});

describe('validateDate', () => {
  it('returns null for valid date', () => {
    expect(validateDate('2025-01-15')).toBeNull();
  });

  it('rejects empty date', () => {
    expect(validateDate('')).toBeTruthy();
    expect(validateDate(null)).toBeTruthy();
  });

  it('rejects invalid date format', () => {
    expect(validateDate('not-a-date')).toBeTruthy();
  });
});

describe('validateHeartRate', () => {
  it('returns null for valid range (30-250)', () => {
    expect(validateHeartRate(30)).toBeNull();
    expect(validateHeartRate(140)).toBeNull();
    expect(validateHeartRate(250)).toBeNull();
  });

  it('returns null for empty (optional field)', () => {
    expect(validateHeartRate(null)).toBeNull();
    expect(validateHeartRate(undefined)).toBeNull();
    expect(validateHeartRate('')).toBeNull();
  });

  it('rejects out of range', () => {
    expect(validateHeartRate(29)).toBeTruthy();
    expect(validateHeartRate(251)).toBeTruthy();
  });
});

describe('validateCalories', () => {
  it('returns null for valid range (0-5000)', () => {
    expect(validateCalories(0)).toBeNull();
    expect(validateCalories(500)).toBeNull();
    expect(validateCalories(5000)).toBeNull();
  });

  it('returns null for empty (optional)', () => {
    expect(validateCalories(null)).toBeNull();
    expect(validateCalories('')).toBeNull();
  });

  it('rejects out of range', () => {
    expect(validateCalories(-1)).toBeTruthy();
    expect(validateCalories(5001)).toBeTruthy();
  });
});

describe('validateRestTime', () => {
  it('returns null for valid range (0-600)', () => {
    expect(validateRestTime(0)).toBeNull();
    expect(validateRestTime(300)).toBeNull();
    expect(validateRestTime(600)).toBeNull();
  });

  it('returns null for empty (optional)', () => {
    expect(validateRestTime(null)).toBeNull();
    expect(validateRestTime(undefined)).toBeNull();
  });

  it('rejects out of range', () => {
    expect(validateRestTime(-1)).toBeTruthy();
    expect(validateRestTime(601)).toBeTruthy();
  });
});

describe('validateImportData', () => {
  it('returns null for valid data with programs', () => {
    expect(validateImportData({ programs: [] })).toBeNull();
  });

  it('returns null for valid data with sessions', () => {
    expect(validateImportData({ sessions: [] })).toBeNull();
  });

  it('returns null for valid data with settings', () => {
    expect(validateImportData({ settings: {} })).toBeNull();
  });

  it('rejects null', () => {
    expect(validateImportData(null)).toBeTruthy();
  });

  it('rejects non-object', () => {
    expect(validateImportData('string')).toBeTruthy();
  });

  it('rejects object without required keys', () => {
    expect(validateImportData({ random: true })).toBeTruthy();
  });
});
