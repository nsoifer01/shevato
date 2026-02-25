import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TimerService } from '../../../apps/gym-tracker/js/services/TimerService.js';

describe('TimerService', () => {
  let timer;

  beforeEach(() => {
    vi.useFakeTimers();
    timer = new TimerService();
  });

  afterEach(() => {
    timer.cleanup();
    vi.useRealTimers();
  });

  describe('rest timer', () => {
    it('starts and ticks down', () => {
      const onTick = vi.fn();
      timer.startRestTimer(5, onTick);
      vi.advanceTimersByTime(1000);
      expect(onTick).toHaveBeenCalledWith(4);
    });

    it('calls onComplete when timer expires', () => {
      const onComplete = vi.fn();
      timer.startRestTimer(2, null, onComplete);
      vi.advanceTimersByTime(2000);
      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it('stopRestTimer clears the timer', () => {
      const onTick = vi.fn();
      const id = timer.startRestTimer(10, onTick);
      vi.advanceTimersByTime(2000);
      timer.stopRestTimer(id);
      vi.advanceTimersByTime(5000);
      // Should have been called 2 times (at 1s and 2s), not more
      expect(onTick).toHaveBeenCalledTimes(2);
    });

    it('stopRestTimer returns false for invalid id', () => {
      expect(timer.stopRestTimer(999)).toBe(false);
    });

    it('stopAllRestTimers clears all', () => {
      const tick1 = vi.fn();
      const tick2 = vi.fn();
      timer.startRestTimer(10, tick1);
      // Advance time slightly so second timer gets a different Date.now() ID
      vi.advanceTimersByTime(1);
      timer.startRestTimer(10, tick2);
      timer.stopAllRestTimers();
      const callsAfterStop1 = tick1.mock.calls.length;
      const callsAfterStop2 = tick2.mock.calls.length;
      vi.advanceTimersByTime(5000);
      // No new calls after stopAll
      expect(tick1.mock.calls.length).toBe(callsAfterStop1);
      expect(tick2.mock.calls.length).toBe(callsAfterStop2);
    });

    it('getRestTimerRemaining returns 0 for invalid id', () => {
      expect(timer.getRestTimerRemaining(999)).toBe(0);
    });
  });

  describe('workout timer', () => {
    it('isWorkoutTimerRunning returns false initially', () => {
      expect(timer.isWorkoutTimerRunning()).toBe(false);
    });

    it('starts and tracks elapsed time', () => {
      const onTick = vi.fn();
      timer.startWorkoutTimer(onTick);
      expect(timer.isWorkoutTimerRunning()).toBe(true);
      vi.advanceTimersByTime(3000);
      expect(onTick).toHaveBeenCalled();
    });

    it('stopWorkoutTimer stops and returns elapsed', () => {
      timer.startWorkoutTimer();
      vi.advanceTimersByTime(5000);
      timer.stopWorkoutTimer();
      expect(timer.isWorkoutTimerRunning()).toBe(false);
    });

    it('stopWorkoutTimer returns 0 when no timer running', () => {
      expect(timer.stopWorkoutTimer()).toBe(0);
    });

    it('handles initialElapsed parameter', () => {
      const onTick = vi.fn();
      timer.startWorkoutTimer(onTick, 60);
      // Should immediately call onTick with 60
      expect(onTick).toHaveBeenCalledWith(60);
    });

    it('stops previous timer when starting new one', () => {
      const tick1 = vi.fn();
      const tick2 = vi.fn();
      timer.startWorkoutTimer(tick1);
      timer.startWorkoutTimer(tick2);
      vi.advanceTimersByTime(2000);
      // tick1 should not receive more calls after second start
      const tick1Calls = tick1.mock.calls.length;
      vi.advanceTimersByTime(2000);
      expect(tick1.mock.calls.length).toBe(tick1Calls);
    });
  });

  describe('formatTime', () => {
    it('formats seconds only', () => {
      expect(TimerService.formatTime(45)).toBe('0:45');
    });

    it('formats minutes and seconds', () => {
      expect(TimerService.formatTime(125)).toBe('2:05');
    });

    it('formats hours', () => {
      expect(TimerService.formatTime(3661)).toBe('1:01:01');
    });

    it('formats zero', () => {
      expect(TimerService.formatTime(0)).toBe('0:00');
    });
  });

  describe('formatTimeShort', () => {
    it('formats minutes and seconds', () => {
      expect(TimerService.formatTimeShort(90)).toBe('1:30');
    });

    it('pads seconds', () => {
      expect(TimerService.formatTimeShort(65)).toBe('1:05');
    });
  });

  describe('cleanup', () => {
    it('stops all timers', () => {
      const tick = vi.fn();
      timer.startRestTimer(10, tick);
      timer.startWorkoutTimer(tick);
      timer.cleanup();
      vi.advanceTimersByTime(5000);
      expect(tick).not.toHaveBeenCalled();
    });
  });
});
