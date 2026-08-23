// TimerService: rest timers, the workout timer, and time formatting.
//
// The rest timer is deliberately wall-clock driven (remaining recomputed from
// endTime on every tick) because mobile browsers throttle setInterval in
// backgrounded tabs: with a decrement counter, locking the phone for 30s used
// to leave the countdown 30s behind reality. These tests use node:test mock
// timers to advance the clock WITHOUT firing intervals (mock.timers.setTime),
// which is exactly what a throttled tab looks like, and then assert one tick
// reports the true remaining time.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TimerService } from '../js/services/TimerService.js';

const APIS = { apis: ['setInterval', 'Date'], now: 1_000_000 };

// Node 20 MockTimers quirk: a single large tick(N) advances the mocked Date
// to the target BEFORE draining due callbacks, and a clearInterval issued
// inside a callback is not honored for the remainder of that same tick span.
// Advancing in interval-sized steps gives real-world semantics.
function tickBy(t, ms, step = 250) {
    for (let done = 0; done < ms; done += step) t.mock.timers.tick(step);
}

test('startRestTimer recomputes remaining from wall clock under throttled intervals', (t) => {
    t.mock.timers.enable(APIS);
    const svc = new TimerService();
    const ticks = [];
    svc.startRestTimer(60, (remaining) => ticks.push(remaining));

    // A throttled/backgrounded tab: 30s of real time pass with NO interval
    // callbacks, then a single tick fires.
    t.mock.timers.setTime(1_000_000 + 30_000);
    t.mock.timers.tick(250);

    assert.equal(ticks.at(-1), 30,
        'one tick after 30 silent seconds reports ~30s left, not 59s (decrement-counter bug)');
});

test('rest timer completes at zero and unregisters itself', (t) => {
    t.mock.timers.enable(APIS);
    const svc = new TimerService();
    let completions = 0;
    const id = svc.startRestTimer(2, null, () => completions++);
    // Step to exactly the 2s mark and no further. (A second quirk of node 20
    // MockTimers: clearInterval issued from inside the interval's own
    // callback is not honored, so ticking past the end would re-fire the
    // "cleared" interval and exercise the mock, not the service.)
    tickBy(t, 2_000);
    assert.equal(completions, 1, 'onComplete fired on the tick that hit zero');
    assert.equal(svc.restTimers.size, 0, 'timer removed after completion');
    assert.equal(svc.stopRestTimer(id), false, 'already stopped');
});

test('extendRestTimer adds the seconds to the in-flight countdown', (t) => {
    t.mock.timers.enable(APIS);
    const svc = new TimerService();
    const ticks = [];
    const id = svc.startRestTimer(60, (r) => ticks.push(r));
    t.mock.timers.tick(250);
    assert.equal(svc.extendRestTimer(id, 30), true, 'extend succeeds on a live timer');
    assert.equal(svc.getRestTimerRemaining(id), 90, '+30s lands on ~90s remaining');
    assert.equal(ticks.at(-1), 90, 'extend ticks immediately so the UI updates without waiting');
});

test('extendRestTimer on an unknown/elapsed timer returns false', (t) => {
    t.mock.timers.enable(APIS);
    const svc = new TimerService();
    assert.equal(svc.extendRestTimer(12345, 30), false);
});

test('stopRestTimer returns true when it stopped something, false otherwise', (t) => {
    t.mock.timers.enable(APIS);
    const svc = new TimerService();
    const ticks = [];
    const id = svc.startRestTimer(60, (r) => ticks.push(r));
    assert.equal(svc.stopRestTimer(id), true);
    assert.equal(svc.stopRestTimer(id), false, 'second stop is a no-op');
    const seen = ticks.length;
    tickBy(t, 2_000);
    assert.equal(ticks.length, seen, 'a stopped timer never ticks again');
});

test('stopAllRestTimers stops every live timer despite deleting while iterating', (t) => {
    // stopAllRestTimers mutates this.restTimers inside forEach. For a JS Map
    // that is safe (each iteration only deletes its own key, and Map.forEach
    // tolerates deletion of the current entry), so all timers must stop.
    // This test exists to keep that guarantee if the iteration style changes.
    t.mock.timers.enable(APIS);
    const svc = new TimerService();
    const ticks = [];
    for (let i = 0; i < 3; i++) {
        // timer ids are Date.now(): advance the mocked clock so ids differ.
        t.mock.timers.setTime(1_000_000 + i);
        svc.startRestTimer(60, (r) => ticks.push(r));
    }
    assert.equal(svc.restTimers.size, 3, 'three live timers');
    svc.stopAllRestTimers();
    assert.equal(svc.restTimers.size, 0, 'no timer skipped');
    const seen = ticks.length;
    tickBy(t, 2_000);
    assert.equal(ticks.length, seen, 'no orphaned interval keeps ticking');
});

// Regression for TESTING-AUDIT.md defect 17 (resolved 2026-08-15): timer ids
// used to be Date.now(), so two starts in one millisecond collided and the
// first interval leaked unclearable. Ids are a monotonic counter now.
test(
    'two rest timers started in the same millisecond get distinct handles',
    (t) => {
        t.mock.timers.enable(APIS);
        const svc = new TimerService();
        const firstTicks = [];
        const id1 = svc.startRestTimer(60, (r) => firstTicks.push(r));
        const id2 = svc.startRestTimer(60, () => {});
        assert.notEqual(id1, id2, 'correct behavior: each start returns its own handle');
        svc.stopRestTimer(id1);
        svc.stopRestTimer(id2);
        const seen = firstTicks.length;
        tickBy(t, 1_000);
        assert.equal(firstTicks.length, seen, 'correct behavior: no orphaned interval survives the stops');
    }
);

// ---------------------------------------------------------------------------
// Workout timer
// ---------------------------------------------------------------------------

test('startWorkoutTimer(initialElapsed) resumes from the carried elapsed time', (t) => {
    t.mock.timers.enable(APIS);
    const svc = new TimerService();
    const ticks = [];
    svc.startWorkoutTimer((e) => ticks.push(e), 120);
    assert.deepEqual(ticks, [120], 'immediate tick shows the resumed time, not 0:00');
    tickBy(t, 2_000, 1_000);
    assert.equal(ticks.at(-1), 122, 'keeps counting from the carried value');
    assert.equal(svc.getWorkoutElapsed(), 122);
    assert.equal(svc.isWorkoutTimerRunning(), true);
});

test('startWorkoutTimer with no initial elapsed starts at zero without an immediate tick', (t) => {
    t.mock.timers.enable(APIS);
    const svc = new TimerService();
    const ticks = [];
    svc.startWorkoutTimer((e) => ticks.push(e));
    assert.deepEqual(ticks, [], 'no synthetic 0 tick');
    tickBy(t, 3_000, 1_000);
    assert.deepEqual(ticks, [1, 2, 3]);
});

test('restarting the workout timer replaces the previous one', (t) => {
    t.mock.timers.enable(APIS);
    const svc = new TimerService();
    const first = [];
    const second = [];
    svc.startWorkoutTimer((e) => first.push(e));
    svc.startWorkoutTimer((e) => second.push(e));
    tickBy(t, 2_000, 1_000);
    assert.deepEqual(first, [], 'the replaced timer never ticks');
    assert.deepEqual(second, [1, 2]);
});

// Regression for TESTING-AUDIT.md defect 18 (resolved 2026-08-15):
// stopWorkoutTimer used to return the creation-time elapsed snapshot; it now
// recomputes from startTime at the moment of stopping.
test(
    'stopWorkoutTimer returns the elapsed seconds at the moment of stopping',
    (t) => {
        t.mock.timers.enable(APIS);
        const svc = new TimerService();
        svc.startWorkoutTimer(() => {}, 0);
        t.mock.timers.tick(5_000);
        assert.equal(svc.stopWorkoutTimer(), 5, 'correct behavior: 5 seconds ran, 5 comes back');
    }
);

test('stopWorkoutTimer with no timer running returns 0 and stays stopped', () => {
    const svc = new TimerService();
    assert.equal(svc.stopWorkoutTimer(), 0);
    assert.equal(svc.isWorkoutTimerRunning(), false);
    assert.equal(svc.getWorkoutElapsed(), 0);
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

test('formatTime rolls into H:MM:SS at one hour', () => {
    assert.equal(TimerService.formatTime(0), '0:00');
    assert.equal(TimerService.formatTime(61), '1:01');
    assert.equal(TimerService.formatTime(599), '9:59');
    assert.equal(TimerService.formatTime(3599), '59:59');
    assert.equal(TimerService.formatTime(3600), '1:00:00');
    assert.equal(TimerService.formatTime(3661), '1:01:01');
    assert.equal(TimerService.formatTime(7325), '2:02:05');
});

test('formatTimeShort never rolls into hours (dial/chip format)', () => {
    assert.equal(TimerService.formatTimeShort(0), '0:00');
    assert.equal(TimerService.formatTimeShort(90), '1:30');
    assert.equal(TimerService.formatTimeShort(3661), '61:01', 'minutes keep counting past 60');
});

// 2026-08-22 audit D7: a backwards clock change (NTP correction, manual
// edit) used to make the header read "-1:-52" and persist a negative
// elapsedBeforePause. Elapsed time must hold at the last value seen until
// the wall clock catches up, and the formatter must never emit a negative.
test('workout timer never runs backwards after a backwards clock change', (t) => {
    t.mock.timers.enable(APIS);
    const svc = new TimerService();
    const ticks = [];
    svc.startWorkoutTimer((elapsed) => ticks.push(elapsed), 0);
    tickBy(t, 5_000, 1000);
    assert.equal(ticks.at(-1), 5, 'five seconds elapsed before the clock change');

    // The clock jumps back 90 s.
    t.mock.timers.setTime(1_000_000 + 5_000 - 90_000);
    t.mock.timers.tick(1000);
    assert.equal(ticks.at(-1), 5, 'elapsed holds at the last known value, never negative');
    assert.equal(svc.getWorkoutElapsed(), 5, 'getWorkoutElapsed reports the clamped value');
    assert.ok(svc.stopWorkoutTimer() >= 5, 'stop returns the clamped value too');
});

test('formatTime clamps negative and non-finite input to 0:00', () => {
    assert.equal(TimerService.formatTime(-112), '0:00');
    assert.equal(TimerService.formatTime(NaN), '0:00');
    assert.equal(TimerService.formatTimeShort(-5), '0:00');
    assert.equal(TimerService.formatTime(3661), '1:01:01', 'positive values are untouched');
});
