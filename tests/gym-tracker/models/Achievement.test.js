import { describe, it, expect } from 'vitest';
import { Achievement } from '../../../apps/gym-tracker/js/models/Achievement.js';

describe('Achievement', () => {
  it('creates with defaults', () => {
    const a = new Achievement();
    expect(a.id).toBe('');
    expect(a.unlocked).toBe(false);
    expect(a.progress).toBe(0);
    expect(a.target).toBe(100);
  });

  describe('progressPercentage', () => {
    it('calculates correct percentage', () => {
      const a = new Achievement({ progress: 50, target: 100 });
      expect(a.progressPercentage).toBe(50);
    });

    it('caps at 100%', () => {
      const a = new Achievement({ progress: 150, target: 100 });
      expect(a.progressPercentage).toBe(100);
    });

    it('returns 0 for no progress', () => {
      const a = new Achievement({ progress: 0, target: 10 });
      expect(a.progressPercentage).toBe(0);
    });

    it('floors to integer', () => {
      const a = new Achievement({ progress: 1, target: 3 });
      expect(a.progressPercentage).toBe(33);
    });
  });

  describe('unlock', () => {
    it('sets unlocked and unlockedAt', () => {
      const a = new Achievement();
      a.unlock();
      expect(a.unlocked).toBe(true);
      expect(a.unlockedAt).toBeTruthy();
    });

    it('does not overwrite unlockedAt on second call', () => {
      const a = new Achievement();
      a.unlock();
      const firstTime = a.unlockedAt;
      a.unlock();
      expect(a.unlockedAt).toBe(firstTime);
    });
  });

  describe('updateProgress', () => {
    it('updates progress value', () => {
      const a = new Achievement({ target: 10 });
      a.updateProgress(5);
      expect(a.progress).toBe(5);
    });

    it('auto-unlocks when reaching target', () => {
      const a = new Achievement({ target: 10 });
      a.updateProgress(10);
      expect(a.unlocked).toBe(true);
    });

    it('auto-unlocks when exceeding target', () => {
      const a = new Achievement({ target: 10 });
      a.updateProgress(15);
      expect(a.unlocked).toBe(true);
    });

    it('does not unlock below target', () => {
      const a = new Achievement({ target: 10 });
      a.updateProgress(9);
      expect(a.unlocked).toBe(false);
    });
  });

  describe('serialization', () => {
    it('round-trips through JSON', () => {
      const a = new Achievement({
        id: 'first-workout',
        name: 'First Workout',
        type: 'global',
        icon: '💪',
        target: 1,
      });
      a.updateProgress(1);

      const restored = Achievement.fromJSON(a.toJSON());
      expect(restored.id).toBe('first-workout');
      expect(restored.unlocked).toBe(true);
      expect(restored.progress).toBe(1);
    });
  });
});
