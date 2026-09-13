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

// ---------------------------------------------------------------------------
// S-1 (audit 2026-09-12): failure and conflict honesty.
//
// This module is Gym Tracker's own copy of assets/js/sync-status.js, and the
// copy had no failed or conflict state and no listener for the engine's
// `syncWriteRejected`, `appSyncFailed` or `syncConflict` events, so the pill,
// the More-nav dot and the banner went on saying "Synced" (or nothing) over a
// write the cloud had refused. These cases mirror the failure cases of
// assets/js/tests/sync-status.test.js, against the fixed event contract:
//   syncWriteRejected  { namespace, keys, code, retryable }
//   syncWriteRecovered { namespace }
// The widget is mounted for real (a fresh module instance per test) against a
// stubbed page, and driven only through window events and the poll.
// ---------------------------------------------------------------------------

const GYM = 'gymTrackerApp';
const HEALTHY = { totalQueueSize: 0, activeNamespaces: 1 };
let caseNo = 0;

function fakeEl(tag) {
    const el = {
        tagName: tag, hidden: true, dataset: {}, style: {}, className: '', title: '',
        children: [], attrs: {}, listeners: {}, _text: '',
        get textContent() { return this._text || this.children.map((c) => c.textContent).join(''); },
        set textContent(v) { this._text = String(v); if (v === '') this.children = []; },
        setAttribute(k, v) { this.attrs[k] = String(v); },
        getAttribute(k) { return this.attrs[k]; },
        appendChild(c) { this.children.push(c); return c; },
        addEventListener(type, fn) { this.listeners[type] = fn; },
        getBoundingClientRect() { return { bottom: 0 }; },
    };
    return el;
}

/** Mount the real widget on a stubbed page; globals are restored by `done()`. */
async function mountWidget({ status = HEALTHY, signedIn = true } = {}) {
    const listeners = {};
    const intervals = [];
    const state = { status, onLine: true };
    const slot = fakeEl('div');
    const dot = fakeEl('span');
    const banner = fakeEl('div');

    const saved = {};
    const stub = (name, value) => {
        saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
        Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    };
    stub('window', {
        addEventListener(type, fn) { listeners[type] = fn; },
        gymGetGlobalSyncStatus: () => state.status,
        firebaseAuth: { getCurrentUser: () => (signedIn ? { uid: 'u1' } : null) },
    });
    stub('document', {
        addEventListener() {},
        getElementById: (id) => (id === 'sync-banner' ? banner : null),
        querySelectorAll: (sel) => (sel === '[data-sync-status-slot]' ? [slot] : sel === '[data-sync-status-dot]' ? [dot] : []),
        createElement: (tag) => fakeEl(tag),
    });
    stub('navigator', { get onLine() { return state.onLine; } });
    stub('setInterval', (fn) => { intervals.push(fn); return intervals.length; });
    stub('clearInterval', () => {});
    stub('setTimeout', () => 0);
    stub('clearTimeout', () => {});

    const mod = await import(`../js/utils/sync-status.js?s1-case=${++caseNo}`);
    mod.mountSyncStatusPill();
    const pill = slot.children[0];
    return {
        pill, dot, banner,
        bannerText: () => banner.children.map((c) => (c.className === 'sync-banner__close' ? '' : c.textContent)).join(' ').trim(),
        dismiss: () => banner.children.find((c) => c.className === 'sync-banner__close').listeners.click(),
        fire: (type, detail) => listeners[type] && listeners[type]({ detail }),
        tick: () => intervals.forEach((fn) => fn()),
        setStatus: (next) => { state.status = next; },
        setOnline: (v) => { state.onLine = v; listeners[v ? 'online' : 'offline']?.({}); },
        done: () => {
            for (const [name, desc] of Object.entries(saved)) {
                if (desc) Object.defineProperty(globalThis, name, desc);
                else delete globalThis[name];
            }
        },
    };
}

/** Run one scenario with the page stubbed, always restoring the globals. */
function widgetTest(name, opts, fn) {
    test(name, async () => {
        const w = await mountWidget(opts);
        try { await fn(w); } finally { w.done(); }
    });
}

widgetTest('S-1 control: a healthy signed-in session still reads Synced on pill and dot', {}, (w) => {
    assert.equal(w.pill.dataset.state, 'synced');
    assert.equal(w.pill.textContent, 'Synced');
    assert.equal(w.dot.dataset.state, 'synced');
});

// ---------- a permanently rejected write ----------

widgetTest('a permanently rejected Gym write never reads Synced, on the pill, the dot or the banner', {}, (w) => {
    w.fire('syncWriteRejected', { namespace: GYM, keys: ['gymTrackerSessions'], code: 'invalid-argument', retryable: false });
    assert.equal(w.pill.dataset.state, 'failed');
    assert.equal(w.pill.textContent, 'Not saved to cloud');
    assert.equal(w.dot.dataset.state, 'failed', 'the phone surface says it too');
    assert.match(w.dot.attrs['aria-label'], /Not saved to cloud/);
    assert.equal(w.banner.hidden, false);
    assert.equal(w.banner.dataset.state, 'failed');
    assert.match(w.bannerText(), /could not be saved to the cloud/i);
    assert.match(w.bannerText(), /safe on this device/i);
});

widgetTest('a rejection without a retryable flag is treated as permanent', {}, (w) => {
    // The engine before the retryable contract only fired for writes it would
    // not retry, so a missing flag must not read as "will retry".
    w.fire('syncWriteRejected', { namespace: GYM, keys: ['k'], code: 'payload-too-large' });
    assert.equal(w.pill.textContent, 'Not saved to cloud');
});

widgetTest('a permanent failure stays visible through the poll and a healthy status', {}, (w) => {
    w.fire('syncWriteRejected', { namespace: GYM, keys: ['k'], code: 'invalid-argument', retryable: false });
    w.setStatus(HEALTHY);
    w.tick();
    w.tick();
    assert.equal(w.pill.dataset.state, 'failed', 'a green queue elsewhere is not evidence the write landed');
    assert.equal(w.banner.hidden, false, 'and the banner is still up');
});

widgetTest('dismissing the failure banner hides the banner only; the pill and dot keep saying it', {}, (w) => {
    w.fire('syncWriteRejected', { namespace: GYM, keys: ['k'], code: 'invalid-argument', retryable: false });
    w.dismiss();
    assert.equal(w.banner.hidden, true);
    w.tick();
    assert.equal(w.pill.dataset.state, 'failed');
    assert.equal(w.dot.dataset.state, 'failed');
});

// ---------- a retryable rejection ----------

widgetTest('a retryable rejection reads as not saved yet, never Synced', {}, (w) => {
    w.fire('syncWriteRejected', { namespace: GYM, keys: ['gymTrackerPrograms'], code: 'unavailable', retryable: true });
    assert.notEqual(w.pill.dataset.state, 'synced');
    assert.equal(w.pill.textContent, 'Not saved to cloud yet');
    assert.equal(w.dot.dataset.state, w.pill.dataset.state);
    assert.equal(w.banner.hidden, false);
    assert.match(w.bannerText(), /not been saved to the cloud yet/i);
    w.tick();
    assert.equal(w.pill.textContent, 'Not saved to cloud yet', 'the poll does not wipe it');
});

widgetTest('a permanent rejection outranks a retryable one, in either order', {}, (w) => {
    w.fire('syncWriteRejected', { namespace: GYM, keys: ['a'], code: 'unavailable', retryable: true });
    w.fire('syncWriteRejected', { namespace: GYM, keys: ['b'], code: 'invalid-argument', retryable: false });
    assert.equal(w.pill.textContent, 'Not saved to cloud');
    w.fire('syncWriteRejected', { namespace: GYM, keys: ['c'], code: 'unavailable', retryable: true });
    assert.equal(w.pill.textContent, 'Not saved to cloud', 'a later retryable batch does not downgrade it');
});

// ---------- recovery ----------

widgetTest('syncWriteRecovered for Gym clears the failure; for another namespace it does not', {}, (w) => {
    w.fire('syncWriteRejected', { namespace: GYM, keys: ['k'], code: 'invalid-argument', retryable: false });
    w.fire('syncWriteRecovered', { namespace: 'marioKartApp' });
    assert.equal(w.pill.dataset.state, 'failed');
    w.fire('syncWriteRecovered', { namespace: GYM });
    assert.equal(w.pill.dataset.state, 'synced');
    assert.equal(w.dot.dataset.state, 'synced');
    assert.equal(w.banner.hidden, true, 'the failure banner goes when the failure does');
});

widgetTest('a rejection in another app namespace is not Gym news', {}, (w) => {
    w.fire('syncWriteRejected', { namespace: 'marioKartApp', keys: ['k'], code: 'invalid-argument', retryable: false });
    assert.equal(w.pill.dataset.state, 'synced');
    assert.equal(w.banner.hidden, true);
});

// ---------- sync that never started ----------

widgetTest('a failed sync start reads as unavailable, not Synced or Connecting', { status: { totalQueueSize: 0, activeNamespaces: 0 } }, (w) => {
    w.fire('appSyncFailed', { message: 'firestore unreachable' });
    assert.equal(w.pill.dataset.state, 'failed');
    assert.equal(w.pill.textContent, 'Sync unavailable');
    assert.equal(w.dot.dataset.state, 'failed');
    assert.equal(w.banner.hidden, false);
    assert.match(w.bannerText(), /could not start/i);
});

widgetTest('a failed start clears itself once a namespace is actually syncing', { status: { totalQueueSize: 0, activeNamespaces: 0 } }, (w) => {
    w.fire('appSyncFailed', { message: 'firestore unreachable' });
    w.setStatus(HEALTHY);
    w.tick();
    assert.equal(w.pill.dataset.state, 'synced', 'retired by real evidence, not by a timer');
    assert.equal(w.banner.hidden, true);
});

// ---------- precedence ----------

widgetTest('offline outranks a standing failure, and the failure is back when the connection is', {}, (w) => {
    w.fire('syncWriteRejected', { namespace: GYM, keys: ['k'], code: 'invalid-argument', retryable: false });
    w.setOnline(false);
    assert.equal(w.pill.dataset.state, 'offline');
    w.setOnline(true);
    assert.equal(w.pill.dataset.state, 'failed');
    assert.doesNotMatch(w.bannerText(), /Synced/, 'no "Back online. Synced" over a failure');
});

test('classifySyncStatus: a failure outranks every healthy state but not offline', () => {
    const failure = { level: 'failed', label: 'Not saved to cloud' };
    assert.deepEqual(classifySyncStatus({ online: true, status: HEALTHY, failure }), { state: 'failed', label: 'Not saved to cloud' });
    assert.deepEqual(classifySyncStatus({ online: true, status: { totalQueueSize: 3, activeNamespaces: 1 }, failure }), { state: 'failed', label: 'Not saved to cloud' });
    assert.equal(classifySyncStatus({ online: false, status: HEALTHY, failure }).state, 'offline');
    assert.equal(classifySyncStatus({ online: true, status: HEALTHY, failure: null }).state, 'synced');
});

// ---------- conflicts ----------

widgetTest('a merge conflict is shown with the shared wording and stays up until dismissed', {}, (w) => {
    w.fire('syncConflict', { key: 'gymTrackerPrograms', resolution: 'merged', conflictedRecordIds: ['p1', 'p2'] });
    assert.equal(w.banner.hidden, false);
    assert.equal(w.banner.dataset.state, 'conflict');
    assert.equal(w.bannerText(),
        'Changes from another session were merged; 2 items differed and a copy of yours was saved on this device');
    // A state change that would normally hide the banner must not swallow it.
    w.setStatus({ totalQueueSize: 2, activeNamespaces: 1 });
    w.tick();
    w.setStatus(HEALTHY);
    w.tick();
    assert.equal(w.banner.hidden, false, 'still up after the queue drained');
    assert.equal(w.banner.dataset.state, 'conflict');
    w.dismiss();
    assert.equal(w.banner.hidden, true);
    w.setStatus({ totalQueueSize: 1, activeNamespaces: 1 });
    w.tick();
    assert.equal(w.banner.hidden, true, 'and once dismissed it stays dismissed');
});

widgetTest('a non-merge conflict says a copy of the other version was kept', {}, (w) => {
    w.fire('syncConflict', { key: 'gymTrackerSettings', resolution: 'remote-wins' });
    assert.equal(w.banner.dataset.state, 'conflict');
    assert.equal(w.bannerText(),
        'This was edited in another session too. The newer version is in use, and a copy of the other one was saved on this device.');
});
