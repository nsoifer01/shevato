import { describe, it, expect, beforeEach } from 'vitest';
import { StorageService } from '../../../apps/gym-tracker/js/services/StorageService.js';

describe('StorageService', () => {
  let storage;

  beforeEach(() => {
    storage = new StorageService();
  });

  describe('generic storage', () => {
    it('get returns parsed JSON', () => {
      localStorage.setItem('test', JSON.stringify({ a: 1 }));
      expect(storage.get('test')).toEqual({ a: 1 });
    });

    it('get returns default for missing key', () => {
      expect(storage.get('missing', [])).toEqual([]);
    });

    it('set stores JSON', () => {
      storage.set('key', { name: 'test' });
      expect(JSON.parse(localStorage.getItem('key'))).toEqual({ name: 'test' });
    });

    it('remove deletes key', () => {
      localStorage.setItem('key', 'value');
      storage.remove('key');
      expect(localStorage.getItem('key')).toBeNull();
    });
  });

  describe('programs CRUD', () => {
    it('getPrograms returns empty array by default', () => {
      expect(storage.getPrograms()).toEqual([]);
    });

    it('saveProgram adds new program', () => {
      storage.saveProgram({ id: 1, name: 'Push' });
      expect(storage.getPrograms()).toHaveLength(1);
    });

    it('saveProgram updates existing program', () => {
      storage.saveProgram({ id: 1, name: 'Push' });
      storage.saveProgram({ id: 1, name: 'Push Updated' });
      const programs = storage.getPrograms();
      expect(programs).toHaveLength(1);
      expect(programs[0].name).toBe('Push Updated');
    });

    it('getProgramById finds program', () => {
      storage.saveProgram({ id: 42, name: 'Leg Day' });
      expect(storage.getProgramById(42).name).toBe('Leg Day');
    });

    it('getProgramById returns undefined for missing', () => {
      expect(storage.getProgramById(999)).toBeUndefined();
    });

    it('deleteProgram removes program', () => {
      storage.saveProgram({ id: 1, name: 'Push' });
      storage.saveProgram({ id: 2, name: 'Pull' });
      storage.deleteProgram(1);
      expect(storage.getPrograms()).toHaveLength(1);
      expect(storage.getPrograms()[0].id).toBe(2);
    });
  });

  describe('active program', () => {
    it('getActiveProgram returns null when none set', () => {
      expect(storage.getActiveProgram()).toBeNull();
    });

    it('set and get active program', () => {
      storage.saveProgram({ id: 1, name: 'Push' });
      storage.setActiveProgram(1);
      expect(storage.getActiveProgram().name).toBe('Push');
    });
  });

  describe('workout sessions CRUD', () => {
    it('getWorkoutSessions returns empty array by default', () => {
      expect(storage.getWorkoutSessions()).toEqual([]);
    });

    it('saveWorkoutSession adds new session', () => {
      storage.saveWorkoutSession({ id: 1, date: '2025-01-15', exercises: [] });
      expect(storage.getWorkoutSessions()).toHaveLength(1);
    });

    it('saveWorkoutSession updates existing', () => {
      storage.saveWorkoutSession({ id: 1, date: '2025-01-15', exercises: [] });
      storage.saveWorkoutSession({ id: 1, date: '2025-01-15', exercises: [], notes: 'Updated' });
      const sessions = storage.getWorkoutSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].notes).toBe('Updated');
    });

    it('deleteWorkoutSession removes session', () => {
      storage.saveWorkoutSession({ id: 1, date: '2025-01-15', exercises: [] });
      storage.deleteWorkoutSession(1);
      expect(storage.getWorkoutSessions()).toEqual([]);
    });

    it('getWorkoutSessionsByDateRange filters correctly', () => {
      storage.saveWorkoutSessions([
        { id: 1, date: '2025-01-01', exercises: [] },
        { id: 2, date: '2025-01-15', exercises: [] },
        { id: 3, date: '2025-02-01', exercises: [] },
      ]);
      const results = storage.getWorkoutSessionsByDateRange('2025-01-10', '2025-01-20');
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(2);
    });

    it('getWorkoutSessionsByExercise filters correctly', () => {
      storage.saveWorkoutSessions([
        { id: 1, exercises: [{ exerciseId: 'bench' }] },
        { id: 2, exercises: [{ exerciseId: 'squat' }] },
      ]);
      const results = storage.getWorkoutSessionsByExercise('bench');
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(1);
    });
  });

  describe('settings', () => {
    it('getSettings returns null by default', () => {
      expect(storage.getSettings()).toBeNull();
    });

    it('save and get settings', () => {
      storage.saveSettings({ weightUnit: 'lb' });
      expect(storage.getSettings().weightUnit).toBe('lb');
    });
  });

  describe('achievements', () => {
    it('getAchievements returns empty array by default', () => {
      expect(storage.getAchievements()).toEqual([]);
    });

    it('save and get achievements', () => {
      storage.saveAchievements([{ id: 'first', unlocked: true }]);
      expect(storage.getAchievements()).toHaveLength(1);
    });
  });

  describe('custom exercises', () => {
    it('addCustomExercise appends', () => {
      storage.addCustomExercise({ id: 'custom1', name: 'Custom' });
      expect(storage.getCustomExercises()).toHaveLength(1);
    });

    it('deleteCustomExercise removes by id', () => {
      storage.addCustomExercise({ id: 'c1', name: 'A' });
      storage.addCustomExercise({ id: 'c2', name: 'B' });
      storage.deleteCustomExercise('c1');
      expect(storage.getCustomExercises()).toHaveLength(1);
      expect(storage.getCustomExercises()[0].id).toBe('c2');
    });
  });

  describe('active workout', () => {
    it('hasActiveWorkout returns false by default', () => {
      expect(storage.hasActiveWorkout()).toBe(false);
    });

    it('save and get active workout', () => {
      storage.saveActiveWorkout({ id: 1, exercises: [] });
      expect(storage.hasActiveWorkout()).toBe(true);
      expect(storage.getActiveWorkout().id).toBe(1);
    });

    it('clearActiveWorkout removes it', () => {
      storage.saveActiveWorkout({ id: 1 });
      storage.clearActiveWorkout();
      expect(storage.hasActiveWorkout()).toBe(false);
    });
  });

  describe('data management', () => {
    it('exportAllData returns all data', () => {
      storage.savePrograms([{ id: 1 }]);
      storage.saveSettings({ theme: 'dark' });
      const exported = storage.exportAllData();
      expect(exported.programs).toHaveLength(1);
      expect(exported.settings.theme).toBe('dark');
      expect(exported.version).toBe('1.0');
      expect(exported.exportDate).toBeTruthy();
    });

    it('importAllData restores data', () => {
      const data = {
        programs: [{ id: 1, name: 'Push' }],
        sessions: [{ id: 1, date: '2025-01-15' }],
        settings: { weightUnit: 'lb' },
      };
      storage.importAllData(data);
      expect(storage.getPrograms()).toHaveLength(1);
      expect(storage.getWorkoutSessions()).toHaveLength(1);
      expect(storage.getSettings().weightUnit).toBe('lb');
    });

    it('clearAllData removes everything', () => {
      storage.savePrograms([{ id: 1 }]);
      storage.saveSettings({ theme: 'dark' });
      storage.clearAllData();
      expect(storage.getPrograms()).toEqual([]);
      expect(storage.getSettings()).toBeNull();
    });

    it('createBackup includes backup date', () => {
      const backup = storage.createBackup();
      expect(backup.backupDate).toBeTruthy();
    });
  });
});
