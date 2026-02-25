import { describe, it, expect } from 'vitest';
import { Exercise } from '../../../apps/gym-tracker/js/models/Exercise.js';

describe('Exercise', () => {
  it('creates from data', () => {
    const exercise = new Exercise({
      id: 'bench-press',
      name: 'Bench Press',
      category: 'chest',
      muscleGroup: 'chest',
      equipment: 'barbell',
    });
    expect(exercise.id).toBe('bench-press');
    expect(exercise.name).toBe('Bench Press');
    expect(exercise.category).toBe('chest');
    expect(exercise.muscleGroup).toBe('chest');
    expect(exercise.equipment).toBe('barbell');
  });

  it('defaults to empty values', () => {
    const exercise = new Exercise({});
    expect(exercise.id).toBeNull();
    expect(exercise.name).toBe('');
    expect(exercise.secondaryMuscles).toEqual([]);
    expect(exercise.tips).toEqual([]);
    expect(exercise.imageUrl).toBeNull();
  });

  describe('serialization', () => {
    it('round-trips through JSON', () => {
      const data = {
        id: 'squat',
        name: 'Barbell Squat',
        category: 'legs',
        muscleGroup: 'quadriceps',
        secondaryMuscles: ['glutes', 'hamstrings'],
        equipment: 'barbell',
        instructions: 'Stand with feet shoulder-width apart',
        tips: ['Keep your back straight', 'Push through heels'],
        imageUrl: '/images/squat.png',
      };
      const exercise = new Exercise(data);
      const restored = Exercise.fromJSON(exercise.toJSON());
      expect(restored.id).toBe('squat');
      expect(restored.secondaryMuscles).toEqual(['glutes', 'hamstrings']);
      expect(restored.tips).toHaveLength(2);
    });
  });
});
