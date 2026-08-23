// Tab ownership of the live workout (2026-08-22 audit D2), plus the two
// pieces of live state the finish/resume paths grew in the same round: the
// rest countdown persisted on the session, and inline post-workout metric
// validation.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockedByOtherTab, LOCK_STALE_MS } from '../js/utils/active-workout.js';
import { WorkoutSession } from '../js/models/WorkoutSession.js';
import { buildFunctions, loadSource } from './helpers/source-extract.mjs';

test('lockedByOtherTab: fresh foreign lock blocks, own/stale/missing locks do not', () => {
    const now = 1_000_000;
    assert.equal(lockedByOtherTab({ tabId: 'B', at: now - 1000 }, 'A', now), true, 'a fresh lock held by B blocks A');
    assert.equal(lockedByOtherTab({ tabId: 'A', at: now - 1000 }, 'A', now), false, 'own lock never blocks');
    assert.equal(lockedByOtherTab({ tabId: 'B', at: now - LOCK_STALE_MS - 1 }, 'A', now), false, 'a lock whose owner stopped heartbeating is stale');
    assert.equal(lockedByOtherTab(null, 'A', now), false);
    assert.equal(lockedByOtherTab({ tabId: 'B', at: 'junk' }, 'A', now), false, 'a corrupt lock never traps the user');
});

test('StorageService lock accessors: claim, refuse to release another tab\'s claim, release own', async () => {
    const store = new Map();
    globalThis.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
    };
    globalThis.sessionStorage = { getItem: () => 'tab-A', setItem() {} };
    const { StorageService } = await import('../js/services/StorageService.js');
    const svc = new StorageService();
    assert.equal(svc.tabId, 'tab-A');
    svc.claimActiveWorkoutLock();
    assert.equal(svc.getActiveWorkoutLock().tabId, 'tab-A');
    store.set('gymTrackerActiveWorkoutLock', JSON.stringify({ tabId: 'tab-B', at: Date.now() }));
    assert.equal(svc.releaseActiveWorkoutLock(), false, 'B\'s claim is not ours to drop');
    assert.equal(svc.getActiveWorkoutLock().tabId, 'tab-B');
    svc.claimActiveWorkoutLock();
    assert.equal(svc.releaseActiveWorkoutLock(), true);
    assert.equal(svc.getActiveWorkoutLock(), null);
    assert.ok(!svc.tabSyncKeys.includes('gymTrackerActiveWorkoutLock'), 'the lock is coordination state, never a tab-sync re-read trigger');
    assert.ok(!svc.tabSyncKeys.includes('gymTrackerActiveWorkout'), 'the active workout is owned through the lock, not re-read');
});

test('restState survives a WorkoutSession JSON round trip so Resume can restore the countdown', () => {
    const s = new WorkoutSession({ id: 1, exercises: [] });
    assert.equal(s.restState, null);
    s.restState = { endsAt: 123456, exerciseIndex: 0, restType: 'set' };
    const back = WorkoutSession.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
    assert.deepEqual(back.restState, { endsAt: 123456, exerciseIndex: 0, restType: 'set' });
    assert.equal(WorkoutSession.fromJSON({ id: 2, restState: 'junk' }).restState, null);
});

test('validatePostWorkoutMetrics: optional fields, whole numbers inside the declared ranges', () => {
    const src = loadSource('js/views/workout-view.js');
    const { validatePostWorkoutMetrics } = buildFunctions(src, ['validatePostWorkoutMetrics'], {}, 'workout-view.js');
    assert.equal(validatePostWorkoutMetrics({ avgHR: '', maxHR: '', calories: '' }), null);
    assert.equal(validatePostWorkoutMetrics({ avgHR: '140', maxHR: '175', calories: '450' }), null);
    assert.equal(validatePostWorkoutMetrics({ avgHR: '-20', maxHR: '', calories: '' })?.field, 'avg-heart-rate');
    assert.equal(validatePostWorkoutMetrics({ avgHR: '', maxHR: '999', calories: '' })?.field, 'max-heart-rate');
    assert.equal(validatePostWorkoutMetrics({ avgHR: '', maxHR: '', calories: '12.5' })?.field, 'calories-burned');
    assert.match(validatePostWorkoutMetrics({ avgHR: '-20', maxHR: '', calories: '' }).message, /30 and 250 bpm/);
});
