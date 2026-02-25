import { describe, it, expect } from 'vitest';
import { WorkoutSession } from '../../../apps/gym-tracker/js/models/WorkoutSession.js';

describe('WorkoutSession', () => {
  it('creates with defaults', () => {
    const ws = new WorkoutSession();
    expect(ws.programId).toBeNull();
    expect(ws.exercises).toEqual([]);
    expect(ws.completed).toBe(false);
    expect(ws.paused).toBe(false);
    expect(ws.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('creates from full data', () => {
    const ws = new WorkoutSession({
      id: 1,
      programId: 10,
      workoutDayName: 'Push Day',
      exercises: [
        {
          exerciseId: 'bench',
          exerciseName: 'Bench Press',
          sets: [{ weight: 80, reps: 10 }],
        },
      ],
    });
    expect(ws.programId).toBe(10);
    expect(ws.exercises).toHaveLength(1);
    expect(ws.exercises[0].exerciseName).toBe('Bench Press');
  });

  describe('duration', () => {
    it('calculates minutes between start and end', () => {
      const ws = new WorkoutSession({
        startTime: '2025-01-01T10:00:00Z',
        endTime: '2025-01-01T11:30:00Z',
      });
      expect(ws.duration).toBe(90);
    });

    it('returns 0 when no start/end times', () => {
      const ws = new WorkoutSession();
      expect(ws.duration).toBe(0);
    });
  });

  describe('totalVolume', () => {
    it('sums volume across all exercises', () => {
      const ws = new WorkoutSession({
        exercises: [
          { exerciseId: 'bench', sets: [{ weight: 80, reps: 10 }] },
          { exerciseId: 'squat', sets: [{ weight: 100, reps: 8 }] },
        ],
      });
      expect(ws.totalVolume).toBe(1600); // 800 + 800
    });
  });

  describe('totalSets', () => {
    it('counts total sets across exercises', () => {
      const ws = new WorkoutSession({
        exercises: [
          {
            sets: [
              { weight: 80, reps: 10 },
              { weight: 80, reps: 8 },
            ],
          },
          { sets: [{ weight: 100, reps: 5 }] },
        ],
      });
      expect(ws.totalSets).toBe(3);
    });
  });

  describe('workout lifecycle', () => {
    it('startWorkout sets startTime', () => {
      const ws = new WorkoutSession();
      ws.startWorkout();
      expect(ws.startTime).toBeTruthy();
    });

    it('endWorkout sets endTime and completed', () => {
      const ws = new WorkoutSession();
      ws.startWorkout();
      ws.endWorkout();
      expect(ws.endTime).toBeTruthy();
      expect(ws.completed).toBe(true);
    });

    it('pauseWorkout sets paused state', () => {
      const ws = new WorkoutSession();
      ws.pauseWorkout(120);
      expect(ws.paused).toBe(true);
      expect(ws.pausedAt).toBeTruthy();
      expect(ws.elapsedBeforePause).toBe(120);
    });

    it('resumeWorkout clears paused state but keeps elapsed', () => {
      const ws = new WorkoutSession();
      ws.pauseWorkout(120);
      ws.resumeWorkout();
      expect(ws.paused).toBe(false);
      expect(ws.pausedAt).toBeNull();
      expect(ws.elapsedBeforePause).toBe(120);
    });
  });

  describe('serialization', () => {
    it('round-trips through JSON', () => {
      const ws = new WorkoutSession({
        id: 42,
        programId: 1,
        workoutDayName: 'Leg Day',
        exercises: [
          {
            exerciseId: 'squat',
            exerciseName: 'Squat',
            sets: [{ weight: 100, reps: 5, completed: true }],
          },
        ],
        notes: 'Felt strong',
        avgHeartRate: 140,
      });
      const restored = WorkoutSession.fromJSON(ws.toJSON());
      expect(restored.id).toBe(42);
      expect(restored.workoutDayName).toBe('Leg Day');
      expect(restored.exercises).toHaveLength(1);
      expect(restored.notes).toBe('Felt strong');
      expect(restored.avgHeartRate).toBe(140);
    });
  });
});
