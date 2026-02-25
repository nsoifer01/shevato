import { describe, it, expect } from 'vitest';
import { WorkoutDay } from '../../../apps/gym-tracker/js/models/WorkoutDay.js';

describe('WorkoutDay', () => {
  it('creates with defaults', () => {
    const wd = new WorkoutDay();
    expect(wd.name).toBe('');
    expect(wd.exercises).toEqual([]);
    expect(wd.order).toBe(0);
  });

  describe('addExercise', () => {
    it('adds exercise with correct order', () => {
      const wd = new WorkoutDay();
      wd.addExercise('bench', 'Bench Press', 4, 8, 'Heavy');
      expect(wd.exercises).toHaveLength(1);
      expect(wd.exercises[0].order).toBe(0);
      expect(wd.exercises[0].targetSets).toBe(4);
    });

    it('auto-increments order', () => {
      const wd = new WorkoutDay();
      wd.addExercise('a', 'A');
      wd.addExercise('b', 'B');
      expect(wd.exercises[1].order).toBe(1);
    });
  });

  describe('removeExercise', () => {
    it('removes and re-orders', () => {
      const wd = new WorkoutDay();
      wd.addExercise('a', 'A');
      wd.addExercise('b', 'B');
      wd.addExercise('c', 'C');
      wd.removeExercise(1);
      expect(wd.exercises).toHaveLength(2);
      expect(wd.exercises[0].exerciseId).toBe('a');
      expect(wd.exercises[1].exerciseId).toBe('c');
      expect(wd.exercises[1].order).toBe(1);
    });

    it('ignores invalid index', () => {
      const wd = new WorkoutDay();
      wd.addExercise('a', 'A');
      wd.removeExercise(5);
      expect(wd.exercises).toHaveLength(1);
    });
  });

  describe('reorderExercise', () => {
    it('moves exercise and updates order', () => {
      const wd = new WorkoutDay();
      wd.addExercise('a', 'A');
      wd.addExercise('b', 'B');
      wd.addExercise('c', 'C');
      wd.reorderExercise(0, 2);
      expect(wd.exercises.map((e) => e.exerciseId)).toEqual(['b', 'c', 'a']);
      expect(wd.exercises.every((e, i) => e.order === i)).toBe(true);
    });
  });

  describe('serialization', () => {
    it('round-trips through JSON', () => {
      const wd = new WorkoutDay({ id: 1, name: 'Push Day', order: 0 });
      wd.addExercise('bench', 'Bench Press');
      const restored = WorkoutDay.fromJSON(wd.toJSON());
      expect(restored.name).toBe('Push Day');
      expect(restored.exercises).toHaveLength(1);
    });
  });
});
