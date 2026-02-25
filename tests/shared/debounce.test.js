import { describe, it, expect, vi } from 'vitest';
import { debounce } from '../../shared/utils/debounce.js';

describe('debounce', () => {
  it('delays function execution', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('only calls the function once for rapid invocations', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    debounced();
    debounced();

    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('passes the latest arguments', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced('first');
    debounced('second');
    debounced('third');

    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledWith('third');

    vi.useRealTimers();
  });

  it('allows separate calls after wait period', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced('a');
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);

    debounced('b');
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith('b');

    vi.useRealTimers();
  });

  it('resets the timer on each call', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    vi.advanceTimersByTime(50);
    debounced(); // resets timer
    vi.advanceTimersByTime(50);
    expect(fn).not.toHaveBeenCalled(); // only 50ms since last call

    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});
