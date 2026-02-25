import { describe, it, expect } from 'vitest';
import { Set } from '../../../apps/gym-tracker/js/models/Set.js';

describe('Set', () => {
  it('creates with default values', () => {
    const set = new Set();
    expect(set.weight).toBe(0);
    expect(set.reps).toBe(0);
    expect(set.duration).toBe(0);
    expect(set.completed).toBe(false);
    expect(set.restTime).toBe(0);
    expect(set.notes).toBe('');
  });

  it('creates from data', () => {
    const set = new Set({ weight: 100, reps: 8, completed: true, notes: 'Heavy' });
    expect(set.weight).toBe(100);
    expect(set.reps).toBe(8);
    expect(set.completed).toBe(true);
    expect(set.notes).toBe('Heavy');
  });

  describe('volume', () => {
    it('calculates weight * reps for rep-based exercises', () => {
      const set = new Set({ weight: 100, reps: 10 });
      expect(set.volume).toBe(1000);
    });

    it('returns duration for time-based exercises', () => {
      const set = new Set({ duration: 60 });
      expect(set.volume).toBe(60);
    });

    it('returns 0 for empty set', () => {
      const set = new Set();
      expect(set.volume).toBe(0);
    });

    it('prefers duration over weight*reps when duration > 0', () => {
      const set = new Set({ weight: 50, reps: 10, duration: 30 });
      expect(set.volume).toBe(30);
    });
  });

  describe('serialization', () => {
    it('serializes to JSON', () => {
      const set = new Set({ weight: 80, reps: 12, completed: true });
      const json = set.toJSON();
      expect(json).toEqual({
        weight: 80,
        reps: 12,
        duration: 0,
        completed: true,
        restTime: 0,
        notes: '',
      });
    });

    it('round-trips through JSON', () => {
      const original = new Set({ weight: 60, reps: 15, restTime: 90, notes: 'Warmup' });
      const restored = Set.fromJSON(original.toJSON());
      expect(restored.weight).toBe(60);
      expect(restored.reps).toBe(15);
      expect(restored.restTime).toBe(90);
      expect(restored.notes).toBe('Warmup');
    });
  });
});
