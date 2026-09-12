/**
 * A failed live-workout write must be VISIBLE, and must stay visible.
 *
 * `persistActiveWorkout` is the app's promise that "every change to the live
 * workout is written to storage as it happens" (README). `StorageService.set`
 * already reports a refused write by returning false, and `finishWorkout`
 * already refuses to complete on one. The live persist path ignored it: once
 * the origin's quota was exhausted mid-workout - a long session, a big
 * history, an eviction-happy iOS tab - every subsequent set commit failed
 * silently while the screen kept counting sets, and the whole workout was lost
 * on the next reload with no warning at any point.
 *
 * A toast is the wrong shape for "your data is not being saved": it dismisses
 * itself after a few seconds and the condition persists. The app's existing
 * persistent in-view banner (`.paused-workout-banner`, the same component the
 * recovery banner uses) carries it instead, with the one escape hatch that
 * actually helps - a backup download that INCLUDES the in-progress session,
 * since that is precisely the data that did not reach the disk.
 *
 * The methods are lifted from the real source rather than mirrored
 * (tests/helpers/source-extract.mjs).
 */
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMethods, loadSource } from './helpers/source-extract.mjs';

const src = loadSource('js/views/workout-view.js');

/** A storage stub whose active-workout write can be made to fail. */
function makeStorage(mode = 'ok') {
    const calls = { saves: 0, claims: 0 };
    return {
        calls,
        saveActiveWorkout() {
            calls.saves += 1;
            if (mode === 'throw') throw new DOMException('quota', 'QuotaExceededError');
            return mode === 'ok';
        },
        claimActiveWorkoutLock() { calls.claims += 1; },
    };
}

const timerService = { getWorkoutElapsed: () => 120 };

function persistView(storage) {
    const methods = buildMethods(src, ['persistActiveWorkout'], {
        storageService: storage,
        timerService,
    }, 'workout-view.js');
    const view = Object.create(methods);
    view.currentWorkoutSession = {
        completed: false,
        paused: false,
        elapsedBeforePause: 0,
        toJSON: () => ({ id: 1 }),
    };
    view._otherTabOwnsWorkout = () => false;
    view.storageFailedCalls = [];
    view.setWorkoutStorageFailed = (failed) => { view.storageFailedCalls.push(failed); };
    return view;
}

test('a refused write raises the storage-failure state', () => {
    const view = persistView(makeStorage('refuse'));
    view.persistActiveWorkout();
    assert.equal(view.storageFailedCalls.at(-1), true,
        'saveActiveWorkout returned false and nothing told the lifter');
});

test('a throwing write raises it too', () => {
    // Safari in private mode throws instead of returning false.
    const view = persistView(makeStorage('throw'));
    view.persistActiveWorkout();
    assert.equal(view.storageFailedCalls.at(-1), true,
        'the write threw and nothing told the lifter');
});

test('a successful write clears it again', () => {
    const view = persistView(makeStorage('ok'));
    view.persistActiveWorkout();
    assert.equal(view.storageFailedCalls.at(-1), false,
        'a write that succeeded must retire the warning');
});

test('a tab that does not own the workout neither writes nor warns', () => {
    // It is not this tab's data that failed; the owner is saving fine.
    const storage = makeStorage('refuse');
    const view = persistView(storage);
    view._otherTabOwnsWorkout = () => true;
    view.persistActiveWorkout();
    assert.equal(storage.calls.saves, 0);
    assert.deepEqual(view.storageFailedCalls, []);
});

// ---------------------------------------------------------------------------
// The banner itself: persistent, and its backup carries the live session.
// ---------------------------------------------------------------------------

function makeHost() {
    const host = {
        innerHTML: '',
        hidden: true,
        listeners: {},
        querySelector(sel) {
            if (!host.innerHTML.includes(sel.replace(/[[\]]/g, ''))) return null;
            return { addEventListener: (evt, fn) => { host.listeners[evt] = fn; } };
        },
    };
    return host;
}

function bannerView(host) {
    const downloads = [];
    const toasts = [];
    const methods = buildMethods(src, ['setWorkoutStorageFailed', 'downloadWorkoutRescueBackup'], {
        document: { getElementById: (id) => (id === 'workout-storage-banner' ? host : null) },
        downloadJSON: (data, filename) => { downloads.push({ data, filename }); },
        showToast: (text) => { toasts.push(text); },
    }, 'workout-view.js');
    const view = Object.create(methods);
    view.app = { exportData: () => ({ programs: [{ id: 7 }], sessions: [], version: '2.0' }) };
    view.currentWorkoutSession = { toJSON: () => ({ id: 42, exercises: [{ exerciseId: 3 }] }) };
    return { view, host, downloads, toasts };
}

test('the banner is shown on failure and removed on recovery', () => {
    const { view, host } = bannerView(makeHost());

    view.setWorkoutStorageFailed(true);
    assert.equal(host.hidden, false, 'the banner must be visible');
    assert.match(host.innerHTML, /paused-workout-banner/,
        'it uses the app\'s existing persistent banner component');
    assert.match(host.innerHTML, /not being saved|not saved|full/i,
        'it must name the problem in words');
    assert.match(host.innerHTML, /data-storage-action="backup"/,
        'it must offer the backup escape hatch');

    view.setWorkoutStorageFailed(false);
    assert.equal(host.hidden, true, 'and it goes away once a write succeeds');
    assert.equal(host.innerHTML, '');
});

test('the banner never dismisses itself', () => {
    // The condition persists until storage is freed, so the UI must too: no
    // timeout, no transition-to-hidden, no toast duration.
    const { view, host } = bannerView(makeHost());
    view.setWorkoutStorageFailed(true);
    const shown = host.innerHTML;
    assert.doesNotMatch(shown, /setTimeout|toast/i);
    view.setWorkoutStorageFailed(true);
    assert.equal(host.innerHTML, shown, 'a repeat failure must not re-render or restart anything');
});

test('the rescue backup carries the in-progress workout, not just what was saved', () => {
    // A backup of the data that DID save would rescue nothing: the live
    // session is exactly the thing the failed write was carrying.
    const { view, downloads } = bannerView(makeHost());
    view.downloadWorkoutRescueBackup();

    assert.equal(downloads.length, 1);
    const { data, filename } = downloads[0];
    assert.match(filename, /^gym-tracker-backup-.*\.json$/);
    assert.deepEqual(data.programs, [{ id: 7 }], 'the ordinary export is included');
    assert.deepEqual(data.activeWorkout, { id: 42, exercises: [{ exerciseId: 3 }] },
        'and so is the workout that could not be written');
});

test('the backup still downloads when there is no live session', () => {
    const { view, downloads } = bannerView(makeHost());
    view.currentWorkoutSession = null;
    view.downloadWorkoutRescueBackup();
    assert.equal(downloads.length, 1);
    assert.equal(downloads[0].data.activeWorkout, null);
});
