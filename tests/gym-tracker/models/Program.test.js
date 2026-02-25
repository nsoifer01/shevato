import { describe, it, expect } from 'vitest';
import { Program } from '../../../apps/gym-tracker/js/models/Program.js';

describe('Program', () => {
  it('creates with defaults', () => {
    const p = new Program();
    expect(p.name).toBe('');
    expect(p.exercises).toEqual([]);
    expect(p.id).toBeTruthy();
    expect(p.createdAt).toBeTruthy();
  });

  it('creates from data', () => {
    const p = new Program({ id: 1, name: 'Push Day', description: 'Chest and triceps' });
    expect(p.name).toBe('Push Day');
    expect(p.description).toBe('Chest and triceps');
  });

  describe('addExercise', () => {
    it('adds exercise with correct order', () => {
      const p = new Program();
      p.addExercise('bench', 'Bench Press', 3, 10, 'Go heavy');
      expect(p.exercises).toHaveLength(1);
      expect(p.exercises[0]).toEqual({
        exerciseId: 'bench',
        exerciseName: 'Bench Press',
        targetSets: 3,
        targetReps: 10,
        notes: 'Go heavy',
        order: 0,
      });
    });

    it('increments order for subsequent exercises', () => {
      const p = new Program();
      p.addExercise('bench', 'Bench Press');
      p.addExercise('squat', 'Squat');
      expect(p.exercises[0].order).toBe(0);
      expect(p.exercises[1].order).toBe(1);
    });

    it('uses default sets and reps', () => {
      const p = new Program();
      p.addExercise('bench', 'Bench Press');
      expect(p.exercises[0].targetSets).toBe(3);
      expect(p.exercises[0].targetReps).toBe(10);
    });

    it('updates updatedAt timestamp', () => {
      const p = new Program({ updatedAt: '2020-01-01' });
      p.addExercise('bench', 'Bench Press');
      expect(p.updatedAt).not.toBe('2020-01-01');
    });
  });

  describe('removeExercise', () => {
    it('removes exercise at index', () => {
      const p = new Program();
      p.addExercise('bench', 'Bench Press');
      p.addExercise('squat', 'Squat');
      p.removeExercise(0);
      expect(p.exercises).toHaveLength(1);
      expect(p.exercises[0].exerciseId).toBe('squat');
    });

    it('re-orders remaining exercises', () => {
      const p = new Program();
      p.addExercise('a', 'A');
      p.addExercise('b', 'B');
      p.addExercise('c', 'C');
      p.removeExercise(0);
      expect(p.exercises[0].order).toBe(0);
      expect(p.exercises[1].order).toBe(1);
    });

    it('ignores invalid index', () => {
      const p = new Program();
      p.addExercise('bench', 'Bench Press');
      p.removeExercise(-1);
      p.removeExercise(5);
      expect(p.exercises).toHaveLength(1);
    });
  });

  describe('reorderExercise', () => {
    it('moves exercise from one position to another', () => {
      const p = new Program();
      p.addExercise('a', 'A');
      p.addExercise('b', 'B');
      p.addExercise('c', 'C');
      p.reorderExercise(2, 0); // Move C to front
      expect(p.exercises[0].exerciseId).toBe('c');
      expect(p.exercises[1].exerciseId).toBe('a');
      expect(p.exercises[2].exerciseId).toBe('b');
    });

    it('updates order values after reorder', () => {
      const p = new Program();
      p.addExercise('a', 'A');
      p.addExercise('b', 'B');
      p.reorderExercise(0, 1);
      expect(p.exercises[0].order).toBe(0);
      expect(p.exercises[1].order).toBe(1);
    });

    it('ignores invalid indices', () => {
      const p = new Program();
      p.addExercise('a', 'A');
      p.reorderExercise(-1, 0);
      p.reorderExercise(0, 5);
      expect(p.exercises[0].exerciseId).toBe('a');
    });
  });

  describe('serialization', () => {
    it('round-trips through JSON', () => {
      const p = new Program({ id: 42, name: 'Test' });
      p.addExercise('bench', 'Bench Press', 4, 8);
      const restored = Program.fromJSON(p.toJSON());
      expect(restored.id).toBe(42);
      expect(restored.name).toBe('Test');
      expect(restored.exercises).toHaveLength(1);
    });
  });
});
