import { describe, it, expect } from 'vitest';
import { AnalyticsService } from '../../../apps/gym-tracker/js/services/AnalyticsService.js';

// Helper to create mock workout sessions
function makeSession(overrides = {}) {
  return {
    id: Date.now(),
    date: '2025-01-15',
    exercises: [],
    get totalVolume() {
      return this.exercises.reduce(
        (sum, ex) => sum + ex.sets.reduce((s, set) => s + (set.weight || 0) * (set.reps || 0), 0),
        0,
      );
    },
    ...overrides,
  };
}

function makeExercise(exerciseId, sets) {
  return {
    exerciseId,
    sets: sets.map((s) => ({
      weight: s.weight || 0,
      reps: s.reps || 0,
      get volume() {
        return this.weight * this.reps;
      },
      ...s,
    })),
    get totalVolume() {
      return this.sets.reduce((sum, s) => sum + s.volume, 0);
    },
  };
}

describe('AnalyticsService', () => {
  describe('getTotalVolume', () => {
    it('sums volume across sessions', () => {
      const sessions = [
        makeSession({
          exercises: [makeExercise('bench', [{ weight: 80, reps: 10 }])],
        }),
        makeSession({
          exercises: [makeExercise('squat', [{ weight: 100, reps: 5 }])],
        }),
      ];
      expect(AnalyticsService.getTotalVolume(sessions)).toBe(1300);
    });

    it('returns 0 for empty sessions', () => {
      expect(AnalyticsService.getTotalVolume([])).toBe(0);
    });
  });

  describe('getPersonalRecords', () => {
    it('finds max weight, reps, and volume', () => {
      const sessions = [
        makeSession({
          date: '2025-01-01',
          exercises: [makeExercise('bench', [{ weight: 80, reps: 10 }])],
        }),
        makeSession({
          date: '2025-01-15',
          exercises: [makeExercise('bench', [{ weight: 100, reps: 5 }])],
        }),
      ];
      const pr = AnalyticsService.getPersonalRecords('bench', sessions);
      expect(pr.maxWeight).toBe(100);
      expect(pr.maxReps).toBe(10);
      expect(pr.maxVolume).toBe(800); // 80*10
      expect(pr.date).toBe('2025-01-15');
    });

    it('returns null for unknown exercise', () => {
      expect(AnalyticsService.getPersonalRecords('unknown', [])).toBeNull();
    });
  });

  describe('getLastWorkoutData', () => {
    it('returns most recent session for exercise', () => {
      const sessions = [
        makeSession({
          date: '2025-01-01',
          exercises: [makeExercise('bench', [{ weight: 80, reps: 10 }])],
        }),
        makeSession({
          date: '2025-01-15',
          exercises: [makeExercise('bench', [{ weight: 90, reps: 8 }])],
        }),
      ];
      const last = AnalyticsService.getLastWorkoutData('bench', sessions);
      expect(last.date).toBe('2025-01-15');
      expect(last.sets[0].weight).toBe(90);
    });

    it('filters by beforeDate', () => {
      const sessions = [
        makeSession({
          date: '2025-01-01',
          exercises: [makeExercise('bench', [{ weight: 80, reps: 10 }])],
        }),
        makeSession({
          date: '2025-01-15',
          exercises: [makeExercise('bench', [{ weight: 90, reps: 8 }])],
        }),
      ];
      const last = AnalyticsService.getLastWorkoutData('bench', sessions, '2025-01-10');
      expect(last.date).toBe('2025-01-01');
    });

    it('returns null for no matching sessions', () => {
      expect(AnalyticsService.getLastWorkoutData('bench', [])).toBeNull();
    });
  });

  describe('hasImproved', () => {
    const makeSetWithVolume = (volume) => ({
      get volume() {
        return volume;
      },
    });

    it('returns true when volume increased', () => {
      const current = [makeSetWithVolume(1000)];
      const previous = [makeSetWithVolume(800)];
      expect(AnalyticsService.hasImproved(current, previous)).toBe(true);
    });

    it('returns false when volume decreased', () => {
      const current = [makeSetWithVolume(600)];
      const previous = [makeSetWithVolume(800)];
      expect(AnalyticsService.hasImproved(current, previous)).toBe(false);
    });

    it('returns null when volume is same', () => {
      const current = [makeSetWithVolume(800)];
      const previous = [makeSetWithVolume(800)];
      expect(AnalyticsService.hasImproved(current, previous)).toBeNull();
    });

    it('returns null for empty previous', () => {
      expect(AnalyticsService.hasImproved([], [])).toBeNull();
      expect(AnalyticsService.hasImproved([], null)).toBeNull();
    });
  });

  describe('getWorkoutFrequency', () => {
    it('calculates frequency for recent sessions', () => {
      const today = new Date().toISOString().split('T')[0];
      const sessions = [makeSession({ date: today }), makeSession({ date: today })];
      const freq = AnalyticsService.getWorkoutFrequency(sessions, 7);
      expect(freq.totalWorkouts).toBe(2);
      expect(freq.averagePerWeek).toBe(2);
      expect(freq.days).toBe(7);
    });

    it('excludes old sessions', () => {
      const sessions = [makeSession({ date: '2020-01-01' })];
      const freq = AnalyticsService.getWorkoutFrequency(sessions, 30);
      expect(freq.totalWorkouts).toBe(0);
    });
  });

  describe('getVolumeTrends', () => {
    it('groups by day (default for non-week/month)', () => {
      const sessions = [
        makeSession({
          date: '2025-01-15',
          exercises: [makeExercise('bench', [{ weight: 80, reps: 10 }])],
        }),
        makeSession({
          date: '2025-01-15',
          exercises: [makeExercise('squat', [{ weight: 100, reps: 5 }])],
        }),
      ];
      const trends = AnalyticsService.getVolumeTrends(sessions, 'day');
      expect(trends).toHaveLength(1);
      expect(trends[0].volume).toBe(1300);
      expect(trends[0].workouts).toBe(2);
    });

    it('groups by month', () => {
      const sessions = [
        makeSession({
          date: '2025-01-05',
          exercises: [makeExercise('bench', [{ weight: 80, reps: 10 }])],
        }),
        makeSession({
          date: '2025-01-20',
          exercises: [makeExercise('bench', [{ weight: 80, reps: 10 }])],
        }),
        makeSession({
          date: '2025-02-10',
          exercises: [makeExercise('bench', [{ weight: 80, reps: 10 }])],
        }),
      ];
      const trends = AnalyticsService.getVolumeTrends(sessions, 'month');
      expect(trends).toHaveLength(2);
      expect(trends[0].date).toBe('2025-01');
      expect(trends[0].workouts).toBe(2);
    });
  });

  describe('getExerciseFrequency', () => {
    it('counts exercise occurrences sorted by frequency', () => {
      const sessions = [
        makeSession({ exercises: [makeExercise('bench', []), makeExercise('squat', [])] }),
        makeSession({ exercises: [makeExercise('bench', [])] }),
      ];
      const freq = AnalyticsService.getExerciseFrequency(sessions);
      expect(freq[0]).toEqual({ exerciseId: 'bench', count: 2 });
      expect(freq[1]).toEqual({ exerciseId: 'squat', count: 1 });
    });

    it('returns empty for no sessions', () => {
      expect(AnalyticsService.getExerciseFrequency([])).toEqual([]);
    });
  });

  describe('getMuscleGroupDistribution', () => {
    it('counts muscle group occurrences', () => {
      const db = [
        { id: 'bench', muscleGroup: 'chest' },
        { id: 'squat', muscleGroup: 'legs' },
      ];
      const sessions = [
        makeSession({ exercises: [makeExercise('bench', []), makeExercise('squat', [])] }),
        makeSession({ exercises: [makeExercise('bench', [])] }),
      ];
      const dist = AnalyticsService.getMuscleGroupDistribution(sessions, db);
      expect(dist[0]).toEqual({ muscle: 'chest', count: 2 });
      expect(dist[1]).toEqual({ muscle: 'legs', count: 1 });
    });
  });

  describe('getExerciseProgression', () => {
    it('returns progression data sorted by date', () => {
      const sessions = [
        makeSession({
          date: '2025-01-15',
          exercises: [
            makeExercise('bench', [
              { weight: 80, reps: 10 },
              { weight: 80, reps: 8 },
            ]),
          ],
        }),
        makeSession({
          date: '2025-01-01',
          exercises: [makeExercise('bench', [{ weight: 70, reps: 10 }])],
        }),
      ];
      const prog = AnalyticsService.getExerciseProgression('bench', sessions);
      expect(prog).toHaveLength(2);
      expect(prog[0].date).toBe('2025-01-01'); // sorted ascending
      expect(prog[0].maxWeight).toBe(70);
      expect(prog[1].maxWeight).toBe(80);
      expect(prog[1].sets).toBe(2);
    });
  });

  describe('calculateAchievementProgress', () => {
    it('calculates total-workouts', () => {
      const sessions = [makeSession(), makeSession(), makeSession()];
      expect(AnalyticsService.calculateAchievementProgress('any', sessions, 'total-workouts')).toBe(
        3,
      );
    });

    it('calculates total-volume', () => {
      const sessions = [
        makeSession({
          exercises: [makeExercise('bench', [{ weight: 100, reps: 10 }])],
        }),
      ];
      expect(AnalyticsService.calculateAchievementProgress('any', sessions, 'total-volume')).toBe(
        1000,
      );
    });

    it('calculates exercises-completed', () => {
      const sessions = [
        makeSession({ exercises: [makeExercise('bench', []), makeExercise('squat', [])] }),
        makeSession({ exercises: [makeExercise('bench', [])] }),
      ];
      expect(
        AnalyticsService.calculateAchievementProgress('any', sessions, 'exercises-completed'),
      ).toBe(2);
    });

    it('returns 0 for unknown type', () => {
      expect(AnalyticsService.calculateAchievementProgress('any', [makeSession()], 'unknown')).toBe(
        0,
      );
    });
  });

  describe('getCalendarData', () => {
    it('returns workout data for specific month', () => {
      const sessions = [
        makeSession({
          date: '2025-01-15',
          exercises: [makeExercise('bench', [{ weight: 80, reps: 10 }])],
        }),
        makeSession({
          date: '2025-02-10',
          exercises: [makeExercise('bench', [{ weight: 80, reps: 10 }])],
        }),
      ];
      const data = AnalyticsService.getCalendarData(sessions, 2025, 0); // January
      expect(data.size).toBe(1);
      expect(data.get('2025-01-15').workouts).toBe(1);
    });
  });
});
