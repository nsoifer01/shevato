/**
 * The screen must stay awake for the whole of an active workout.
 *
 * A phone screen sleeps after ~30 s. Programmed rests are 60-180 s
 * (`WorkoutExercise.restSeconds` defaults to 90), so the screen died during
 * EVERY rest, and once the tab is backgrounded the 250 ms rest tick
 * (`js/services/TimerService.js`) is throttled: `restTickCues` never observes
 * `remaining === firstWarningSeconds`, and `playSound` schedules against
 * `ctx.currentTime` at tick time with nothing pre-scheduled, so the warning
 * ping and the countdown pips never fire at all. The README's "rest timer cues
 * via audio pings and vibration" was only true while you held the phone and
 * watched it.
 *
 * The Screen Wake Lock API fixes that, but it is a minefield of silent
 * failure modes, and every one of them must leave the WORKOUT running:
 *
 *   - It does not exist on Firefox or on Safari before 16.4.
 *   - `request()` REJECTS when the page is hidden, or when the user/platform
 *     denies it. An unhandled rejection there would break `startWorkout`.
 *   - The sentinel is dropped by the platform whenever the page is hidden,
 *     so without a visibilitychange re-acquire it works exactly once - which
 *     is the one failure mode that looks fine in a desk test and fails in a
 *     gym, because locking the phone is the whole point.
 *
 * The state machine is lifted from the real source rather than mirrored
 * (tests/helpers/source-extract.mjs). Only `_wakeLockApi()` - the one-line
 * platform accessor - is stubbed, the same way other suites stub
 * `_otherTabOwnsWorkout`.
 */
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMethods, extractClassMethod, loadSource } from './helpers/source-extract.mjs';

const src = loadSource('js/views/workout-view.js');

const METHODS = [
    'acquireWakeLock',
    'releaseWakeLock',
    'handleWakeLockVisibility',
    'wakeLockPreferred',
    'syncWakeLock',
    '_releaseSentinel',
];

const methods = buildMethods(src, METHODS, {}, 'workout-view.js');

/**
 * A fake `navigator.wakeLock`. `mode` picks the platform behaviour:
 *   'ok'      - grants, and hands back a sentinel that can be released
 *   'deny'    - rejects, the way a hidden page or a denied permission does
 *   'throw'   - throws synchronously
 *   'absent'  - the API is not implemented at all
 */
function makeWakeLockApi(mode = 'ok') {
    const calls = { requests: [], releases: 0 };
    if (mode === 'absent') return { api: null, calls };
    const api = {
        request(type) {
            calls.requests.push(type);
            if (mode === 'throw') throw new Error('nope');
            if (mode === 'deny') {
                return Promise.reject(
                    new DOMException('permission denied', 'NotAllowedError'));
            }
            const listeners = [];
            const sentinel = {
                type,
                released: false,
                addEventListener(name, fn) { if (name === 'release') listeners.push(fn); },
                release() {
                    calls.releases += 1;
                    sentinel.released = true;
                    listeners.forEach((fn) => fn());
                    return Promise.resolve();
                },
                /** The platform dropping the lock on its own (page hidden). */
                platformRelease() {
                    sentinel.released = true;
                    listeners.forEach((fn) => fn());
                },
            };
            return Promise.resolve(sentinel);
        },
    };
    return { api, calls };
}

function makeView({ mode = 'ok', active = true, keepScreenAwake = true, visible = true } = {}) {
    const { api, calls } = makeWakeLockApi(mode);
    const view = Object.create(methods);
    view.app = { settings: { keepScreenAwake } };
    view.currentWorkoutSession = active ? { id: 1, completed: false } : null;
    view.hasActiveWorkout = () => view.currentWorkoutSession !== null
        && !view.currentWorkoutSession.completed;
    view._wakeLockApi = () => api;
    view._wakeLockVisibility = () => (visible ? 'visible' : 'hidden');
    view.wakeLockCalls = calls;
    return view;
}

test('starting a workout takes a screen wake lock', async () => {
    const view = makeView();
    await view.acquireWakeLock();
    assert.deepEqual(view.wakeLockCalls.requests, ['screen'],
        'the wake lock must be requested for the screen');
    assert.ok(view._wakeLockSentinel, 'the sentinel must be held so it can be released later');
});

test('a DENIED request leaves the workout running', async () => {
    const view = makeView({ mode: 'deny' });
    await view.acquireWakeLock();
    assert.equal(view._wakeLockSentinel ?? null, null, 'nothing should be held after a rejection');
    assert.equal(view.hasActiveWorkout(), true,
        'a refused wake lock must never take the workout down with it');
});

test('a THROWING request leaves the workout running', async () => {
    const view = makeView({ mode: 'throw' });
    await view.acquireWakeLock();
    assert.equal(view._wakeLockSentinel ?? null, null);
    assert.equal(view.hasActiveWorkout(), true);
});

test('a browser without the API is a silent no-op', async () => {
    const view = makeView({ mode: 'absent' });
    await view.acquireWakeLock();
    assert.equal(view._wakeLockSentinel ?? null, null);
    assert.equal(view.hasActiveWorkout(), true,
        'Firefox and Safari < 16.4 must still be able to start a workout');
});

test('releasing drops the lock and forgets the sentinel', async () => {
    const view = makeView();
    await view.acquireWakeLock();
    view.releaseWakeLock();
    assert.equal(view.wakeLockCalls.releases, 1, 'the sentinel must actually be released');
    assert.equal(view._wakeLockSentinel ?? null, null);
});

test('releasing with nothing held is harmless', () => {
    const view = makeView();
    assert.doesNotThrow(() => view.releaseWakeLock());
});

test('a second acquire while one is held does not request again', async () => {
    const view = makeView();
    await view.acquireWakeLock();
    await view.acquireWakeLock();
    assert.equal(view.wakeLockCalls.requests.length, 1,
        'holding two sentinels leaks the first one, which then never releases');
});

test('the platform dropping the lock clears our reference', async () => {
    const view = makeView();
    await view.acquireWakeLock();
    view._wakeLockSentinel.platformRelease();
    assert.equal(view._wakeLockSentinel ?? null, null,
        'a stale sentinel makes the re-acquire below a no-op, which is the exactly-once bug');
});

test('coming back to a visible page re-acquires the lock', async () => {
    const view = makeView();
    await view.acquireWakeLock();
    // The platform drops the lock the moment the page is hidden.
    view._wakeLockSentinel.platformRelease();
    await view.handleWakeLockVisibility();
    assert.equal(view.wakeLockCalls.requests.length, 2,
        'without a re-acquire on visibilitychange the wake lock works exactly once');
    assert.ok(view._wakeLockSentinel, 'the re-acquired sentinel must be held');
});

test('a hidden page does not try to re-acquire', async () => {
    const view = makeView({ visible: false });
    await view.handleWakeLockVisibility();
    assert.equal(view.wakeLockCalls.requests.length, 0,
        'request() rejects on a hidden page; asking there is pure noise');
});

test('visibilitychange with no workout running takes no lock', async () => {
    const view = makeView({ active: false });
    await view.handleWakeLockVisibility();
    assert.equal(view.wakeLockCalls.requests.length, 0,
        'the screen is only pinned DURING a workout');
});

test('the setting off means no lock is ever requested', async () => {
    const view = makeView({ keepScreenAwake: false });
    await view.acquireWakeLock();
    assert.equal(view.wakeLockCalls.requests.length, 0,
        'some people do not want their screen pinned on');
});

test('the setting defaults ON when it has never been chosen', async () => {
    const view = makeView();
    delete view.app.settings.keepScreenAwake;
    assert.equal(view.wakeLockPreferred(), true);
    await view.acquireWakeLock();
    assert.equal(view.wakeLockCalls.requests.length, 1);
});

test('turning the setting off mid-workout releases the lock', async () => {
    const view = makeView();
    await view.acquireWakeLock();
    view.app.settings.keepScreenAwake = false;
    await view.syncWakeLock();
    assert.equal(view.wakeLockCalls.releases, 1,
        'the toggle must take effect on the workout that is running now');
    assert.equal(view._wakeLockSentinel ?? null, null);
});

test('turning the setting on mid-workout takes the lock', async () => {
    const view = makeView({ keepScreenAwake: false });
    await view.acquireWakeLock();
    view.app.settings.keepScreenAwake = true;
    await view.syncWakeLock();
    assert.equal(view.wakeLockCalls.requests.length, 1);
    assert.ok(view._wakeLockSentinel);
});

// --- Wiring guards -------------------------------------------------------
// The lifecycle methods are far too DOM-bound to run here, but the whole
// feature is worthless if one of the five call sites is missing: a workout
// that acquires and never releases pins the screen on forever, and one that
// releases without re-acquiring on resume is dead after the first pause.

const WIRING = [
    ['startWorkout', 'acquireWakeLock', 'a workout that starts must pin the screen'],
    ['startQuickWorkout', 'acquireWakeLock', 'a quick workout is still a workout'],
    ['resumeWorkout', 'acquireWakeLock', 'resume is the second half of "a workout becomes active"'],
    ['pauseAndSaveWorkout', 'releaseWakeLock', 'a paused workout must give the screen back'],
    ['discardWorkout', 'releaseWakeLock', 'a discarded workout must give the screen back'],
    ['endWorkout', 'releaseWakeLock', 'endWorkout() is the path the Discard menu item actually runs'],
    ['finishWorkout', 'releaseWakeLock', 'a finished workout must give the screen back'],
    ['handleWorkoutTakenOver', 'releaseWakeLock', 'a tab that stopped driving must not keep the screen on'],
];

for (const [method, call, why] of WIRING) {
    test(`${method}() calls ${call}() - ${why}`, () => {
        const body = extractClassMethod(src, method, 'workout-view.js');
        assert.ok(body.includes(`this.${call}()`),
            `${method}() does not call this.${call}(): ${why}`);
    });
}

test('the visibilitychange listener is registered', () => {
    const body = extractClassMethod(src, 'setupWakeLock', 'workout-view.js');
    assert.ok(body.includes('visibilitychange'),
        'without a visibilitychange listener the wake lock survives exactly one screen-off');
    assert.ok(body.includes('handleWakeLockVisibility'),
        'the listener must run the re-acquire path');
    const init = extractClassMethod(src, 'init', 'workout-view.js');
    assert.ok(init.includes('this.setupWakeLock()'),
        'setupWakeLock() is never called, so the listener is never registered');
});
