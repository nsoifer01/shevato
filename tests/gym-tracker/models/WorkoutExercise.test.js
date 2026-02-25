import { describe, it, expect } from 'vitest';
import { WorkoutExercise } from '../../../apps/gym-tracker/js/models/WorkoutExercise.js';

describe('WorkoutExercise', () => {
  it('creates with defaults', () => {
    const we = new WorkoutExercise();
    expect(we.exerciseId).toBeNull();
    expect(we.sets).toEqual([]);
    expect(we.targetSets).toBe(3);
  });

  it('creates from data with sets', () => {
    const we = new WorkoutExercise({
      exerciseId: 'bench',
      exerciseName: 'Bench Press',
      sets: [
        { weight: 80, reps: 10, completed: true },
        { weight: 80, reps: 8, completed: true },
      ],
    });
    expect(we.exerciseId).toBe('bench');
    expect(we.sets).toHaveLength(2);
    expect(we.sets[0].weight).toBe(80);
  });

  describe('totalVolume', () => {
    it('sums volume across all sets', () => {
      const we = new WorkoutExercise({
        sets: [
          { weight: 100, reps: 10 },
          { weight: 100, reps: 8 },
        ],
      });
      expect(we.totalVolume).toBe(1800); // 1000 + 800
    });

    it('returns 0 for no sets', () => {
      const we = new WorkoutExercise();
      expect(we.totalVolume).toBe(0);
    });
  });

  describe('completedSets', () => {
    it('counts completed sets', () => {
      const we = new WorkoutExercise({
        sets: [
          { weight: 80, reps: 10, completed: true },
          { weight: 80, reps: 10, completed: false },
          { weight: 80, reps: 10, completed: true },
        ],
      });
      expect(we.completedSets).toBe(2);
    });
  });

  describe('addSet', () => {
    it('adds a new set', () => {
      const we = new WorkoutExercise();
      we.addSet({ weight: 60, reps: 12 });
      expect(we.sets).toHaveLength(1);
      expect(we.sets[0].weight).toBe(60);
    });
  });

  describe('removeSet', () => {
    it('removes set at index', () => {
      const we = new WorkoutExercise({
        sets: [
          { weight: 60, reps: 12 },
          { weight: 80, reps: 10 },
        ],
      });
      we.removeSet(0);
      expect(we.sets).toHaveLength(1);
      expect(we.sets[0].weight).toBe(80);
    });

    it('ignores invalid index', () => {
      const we = new WorkoutExercise({ sets: [{ weight: 60, reps: 12 }] });
      we.removeSet(-1);
      we.removeSet(5);
      expect(we.sets).toHaveLength(1);
    });
  });

  describe('serialization', () => {
    it('round-trips through JSON', () => {
      const we = new WorkoutExercise({
        exerciseId: 'bench',
        exerciseName: 'Bench Press',
        sets: [{ weight: 100, reps: 5, completed: true }],
        targetSets: 5,
        notes: 'PR attempt',
      });
      const restored = WorkoutExercise.fromJSON(we.toJSON());
      expect(restored.exerciseId).toBe('bench');
      expect(restored.sets).toHaveLength(1);
      expect(restored.sets[0].volume).toBe(500);
      expect(restored.notes).toBe('PR attempt');
    });
  });
});
