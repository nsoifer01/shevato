import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifySyncStatus , reconnectMessage } from '../js/utils/sync-status.js';

test('classifySyncStatus: offline beats every other signal', () => {
    // Even with a healthy status object, a non-online browser should
    // surface "Offline" so the user knows writes are buffered locally.
    const result = classifySyncStatus({
        online: false,
        status: { totalQueueSize: 0, activeNamespaces: 2 }
    });
    assert.equal(result.state, 'offline');
    assert.equal(result.label, 'Offline');
});

test('classifySyncStatus: missing status object → connecting', () => {
    // Sync layer hasn't initialised yet; pre-init we don't want to claim
    // anything is wrong, just that we're not ready.
    const result = classifySyncStatus({ online: true, status: null });
    assert.equal(result.state, 'connecting');
    assert.equal(result.label, 'Connecting…');
});

test('classifySyncStatus: queued writes → syncing', () => {
    const result = classifySyncStatus({
        online: true,
        status: { totalQueueSize: 3, activeNamespaces: 1 }
    });
    assert.equal(result.state, 'syncing');
    assert.equal(result.label, 'Saving…');
});

test('classifySyncStatus: queue takes precedence over zero namespaces', () => {
    // Edge case while a sign-out races with a flush: if we still have
    // queued writes we should call out "Saving…" rather than "Local only".
    const result = classifySyncStatus({
        online: true,
        status: { totalQueueSize: 1, activeNamespaces: 0 }
    });
    assert.equal(result.state, 'syncing');
});

test('classifySyncStatus: signed-out / no namespaces → idle, not pending', () => {
    // The previous classifier mapped this to a yellow "pending" pill,
    // which made local-only users see a permanent yellow indicator
    // even though nothing was actually pending. Idle is the honest
    // label for "no cloud target attached."
    const result = classifySyncStatus({
        online: true,
        status: { totalQueueSize: 0, activeNamespaces: 0 },
        signedIn: false
    });
    assert.equal(result.state, 'idle');
    assert.equal(result.label, 'Local only');
});

test('classifySyncStatus: signed-in but sync not yet attached → connecting', () => {
    // Mobile auth-iframe boot can leave the modular Firebase SDK's
    // `auth.currentUser` null for several seconds even after the user
    // is fully signed in via the compat SDK. During that window the
    // sync layer hasn't attached a namespace yet — we should show
    // "Connecting…" rather than mislabel as "Local only", which would
    // suggest the cloud isn't involved at all.
    const result = classifySyncStatus({
        online: true,
        status: { totalQueueSize: 0, activeNamespaces: 0 },
        signedIn: true
    });
    assert.equal(result.state, 'connecting');
    assert.equal(result.label, 'Connecting…');
});

test('classifySyncStatus: clean state → synced', () => {
    const result = classifySyncStatus({
        online: true,
        status: { totalQueueSize: 0, activeNamespaces: 2 }
    });
    assert.equal(result.state, 'synced');
    assert.equal(result.label, 'Synced');
});

test('classifySyncStatus: online=undefined treated as connected', () => {
    // Defensive: in non-browser test environments navigator may be
    // absent and the caller passes undefined. Anything that is not
    // strictly false should not flip us into Offline.
    const result = classifySyncStatus({
        online: undefined,
        status: { totalQueueSize: 0, activeNamespaces: 1 }
    });
    assert.equal(result.state, 'synced');
});

test('classifySyncStatus: offline + queued writes still reports offline', () => {
    // The user needs to know connectivity is the gating issue; the
    // queue depth is secondary information.
    const result = classifySyncStatus({
        online: false,
        status: { totalQueueSize: 5, activeNamespaces: 1 }
    });
    assert.equal(result.state, 'offline');
});

test('classifySyncStatus: offline → online transition swaps state', () => {
    const status = { totalQueueSize: 0, activeNamespaces: 1 };
    assert.equal(classifySyncStatus({ online: false, status }).state, 'offline');
    assert.equal(classifySyncStatus({ online: true,  status }).state, 'synced');
});

test('classifySyncStatus: a stuck retry surfaces as syncing, and draining flips to synced', () => {
    // The robust sync layer keeps queued writes during retry/backoff, so a
    // stuck retry shows up as a sustained "Saving…" rather than a false
    // "Synced" - and only an actually-drained queue may show success.
    // (classifySyncStatus is pure, so re-calling with identical input proves
    // nothing; the meaningful transition is queue > 0 -> queue == 0.)
    assert.equal(
        classifySyncStatus({ online: true, status: { totalQueueSize: 4, activeNamespaces: 1 } }).state,
        'syncing');
    assert.equal(
        classifySyncStatus({ online: true, status: { totalQueueSize: 0, activeNamespaces: 1 } }).state,
        'synced');
});

// ---------------------------------------------------------------------------
// GT-36: the reconnect banner must not claim a sync that never happened.
//
// With no account at all (desktop shows "Local only", the More-nav dot is
// grey), going offline and back online announced "Back online. Synced".
// Nothing had been synced anywhere - there was nowhere to sync to.
// ---------------------------------------------------------------------------

test('reconnect wording: a signed-out, local-only user is told only that they are back', () => {
    assert.equal(reconnectMessage('idle'), 'Back online');
});

test('reconnect wording: "Synced" is reserved for an actual completed sync', () => {
    assert.equal(reconnectMessage('synced'), 'Back online. Synced');
});

test('reconnect wording: work still queued says so instead of claiming success', () => {
    assert.equal(reconnectMessage('syncing'), 'Back online. Syncing…');
});

test('reconnect wording: signed in but not attached yet is "Connecting"', () => {
    assert.equal(reconnectMessage('connecting'), 'Back online. Connecting…');
});

test('reconnect wording: an unknown state never invents a sync', () => {
    assert.equal(reconnectMessage('offline'), 'Back online');
    assert.equal(reconnectMessage(undefined), 'Back online');
});

test('the local-only state is exactly the one that must not say "Synced"', () => {
    const state = classifySyncStatus({ online: true, status: { totalQueueSize: 0, activeNamespaces: 0 }, signedIn: false });
    assert.equal(state.state, 'idle');
    assert.equal(reconnectMessage(state.state), 'Back online');
});
