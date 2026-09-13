/**
 * Sync status indicators.
 *
 * Three surfaces, picked to suit each form factor:
 *
 *   1. Inline pill — rendered into `[data-sync-status-slot]` placeholders
 *      (currently just the desktop side-nav footer). Always visible,
 *      shows the full state label. Out of the way on desktop because
 *      there's plenty of sidebar real estate.
 *
 *   2. Compact dot (`[data-sync-status-dot]`, on the "More" bottom-nav
 *      button): the same state as the pill, as a colour plus an aria-label.
 *
 *   3. Banner (`#sync-banner`): pinned directly BELOW the fixed site header
 *      (see placeBanner: its `top` follows #header's bottom edge, and it
 *      stacks under the header). Shown while offline, briefly on the
 *      offline→online transition, and for the two things a user has to be
 *      TOLD about: a write the cloud refused (or a sync that never started),
 *      and a sync conflict. Dismissible with its close button. The routine
 *      states are phone-only (CSS hides them on desktop, where the pill is the
 *      surface); failures and conflicts show at every width.
 *
 * This is Gym Tracker's own ES-module version of assets/js/sync-status.js
 * (the classic script the other apps load): same classifier contract, same
 * banner DOM and dismiss affordance, same failure and conflict wording. Gym
 * adds the side-nav pill and the nav dot. Keep the two in step: a behaviour
 * fixed in one is NOT fixed in the other (audit S-1, 2026-09-12, found this
 * copy with no failed or conflict state at all).
 *
 * The poll-based read is kept (2 s + online/offline events) and
 * `render()` dedupes by last (state, label) so background ticks do
 * not thrash the DOM — that was the source of the green/amber flicker
 * users saw between sets.
 */

const POLL_MS = 2000;
const RECOVERY_FLASH_MS = 2000;
/** The sync engine's namespace for this app (sync-system/app-sync-init.js). */
const GYM_NAMESPACE = 'gymTrackerApp';

/**
 * Failure copy. `failed` is a write the engine will not retry, `unsaved` is
 * one it kept and will resend, `init` is a sync that never started. State
 * names, labels and wording match the shared widget so the words mean the
 * same thing on every app.
 */
const FAILURE_COPY = {
    failed: {
        level: 'failed',
        label: 'Not saved to cloud',
        text: 'Some changes could not be saved to the cloud. They are safe on this device, but they are not syncing to your other devices.',
    },
    unsaved: {
        level: 'unsaved',
        label: 'Not saved to cloud yet',
        text: 'Some changes have not been saved to the cloud yet. They are safe on this device, and sync will try again.',
    },
    init: {
        level: 'failed',
        label: 'Sync unavailable',
        text: 'Sync could not start. Your changes are being saved on this device only.',
    },
};

let mounted = false;
let pillEls = [];
let dotEls = [];
let bannerEl = null;
let timer = null;
let lastRender = null;
let recoveryTimer = null;

// A PERMANENT FAILURE OUTRANKS EVERY HEALTHY STATE. `writeFailure` is null,
// 'unsaved' or 'failed' (the worst rejection since the last recovery);
// `initFailed` is a sync start that failed. The conflict notice is the banner
// text still owed to the user, kept until they dismiss it.
let writeFailure = null;
let initFailed = false;
let conflictNotice = null;

/**
 * Pure classifier — exported for unit tests so we can assert state
 * transitions without a DOM. Inputs are explicit so callers can mock
 * `navigator.onLine`, the global status getter, and the auth state.
 *
 * `signedIn` distinguishes "user has Firebase auth but the sync layer
 * hasn't attached yet" (treated as still connecting, dim amber) from
 * "no auth at all, app is purely local" (treated as idle, slate). The
 * former is the common transitional state on mobile when the auth
 * iframe is slow to settle; without this distinction the dot would
 * stay slate even though sync is about to come up.
 *
 * `failure` ({ level, label } or null) is checked after `offline` on purpose:
 * when the connection is down, "Offline" is the more useful and more
 * actionable truth, and the failure is still there when it comes back. It
 * outranks everything else, because saying "Synced" (or "Saving…") over a
 * write the cloud refused is the one lie this widget must never tell.
 */
export function classifySyncStatus({ online, status, signedIn = false, failure = null }) {
    if (online === false) return { state: 'offline', label: 'Offline' };
    if (failure) return { state: failure.level, label: failure.label };
    if (!status) return { state: 'connecting', label: 'Connecting…' };
    if (status.totalQueueSize > 0) return { state: 'syncing', label: 'Saving…' };
    if (status.activeNamespaces === 0) {
        if (signedIn) return { state: 'connecting', label: 'Connecting…' };
        return { state: 'idle', label: 'Local only' };
    }
    return { state: 'synced', label: 'Synced' };
}

/**
 * The standing failure, worst first, in the shared widget's order: a refused
 * write, then a write still waiting to be resent, then a failed start.
 */
function currentFailure() {
    if (writeFailure === 'failed') return FAILURE_COPY.failed;
    if (writeFailure === 'unsaved') return FAILURE_COPY.unsaved;
    if (initFailed) return FAILURE_COPY.init;
    return null;
}

function readCurrent() {
    const online = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
    const status = typeof window !== 'undefined' ? window.gymGetGlobalSyncStatus?.() : null;
    const signedIn = typeof window !== 'undefined'
        && !!window.firebaseAuth?.getCurrentUser?.();
    return classifySyncStatus({ online, status, signedIn, failure: currentFailure() });
}

function applyToPill(el, { state, label }) {
    el.dataset.state = state;
    el.textContent = label;
    el.setAttribute('aria-label', `Sync status: ${label}`);
    el.title = label;
}

/**
 * The reconnect message that matches the state we came back to (GT-36).
 *
 *   synced     - a signed-in account whose queue has drained. "Synced" is true.
 *   syncing    - signed in, work still queued. Say it is in flight.
 *   idle       - no account at all. Local-only, so nothing synced anywhere.
 *   connecting - signed in but the sync layer has not attached yet.
 */
export function reconnectMessage(state) {
    switch (state) {
        case 'synced': return 'Back online. Synced';
        case 'syncing': return 'Back online. Syncing…';
        case 'connecting': return 'Back online. Connecting…';
        default: return 'Back online';
    }
}

/**
 * What a conflict banner says. Same wording as the shared widget, and for the
 * same reason: the engine only calls something a conflict once it has ruled
 * out this device's own echo, but it cannot tell another tab from another
 * browser or another device, so "another session" is what is actually known.
 */
function conflictMessage(detail) {
    const merged = detail && detail.resolution === 'merged';
    const conflicted = merged && Array.isArray(detail.conflictedRecordIds) ? detail.conflictedRecordIds.length : 0;
    if (!merged) {
        return 'This was edited in another session too. The newer version is in use, and a copy of the other one was saved on this device.';
    }
    return conflicted
        ? `Changes from another session were merged; ${conflicted} item${conflicted === 1 ? '' : 's'} differed and a copy of yours was saved on this device`
        : 'Changes from another session were merged in';
}

/**
 * Keep the banner under the fixed site header so the header controls stay
 * clickable while it is up; on a page without #header it sits at the top.
 */
function placeBanner() {
    if (!bannerEl || bannerEl.hidden) return;
    const header = document.getElementById('header');
    const bottom = header ? Math.max(0, Math.round(header.getBoundingClientRect().bottom)) : 0;
    bannerEl.style.top = `${bottom}px`;
}

function clearRecoveryFlash() {
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
}

/** Render the banner with its label and a dismiss button, then place it. */
function showBanner(state, text) {
    bannerEl.hidden = false;
    bannerEl.dataset.state = state;
    bannerEl.dataset.fading = 'false';
    bannerEl.textContent = '';
    const label = document.createElement('span');
    label.textContent = text;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'sync-banner__close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    close.addEventListener('click', () => {
        clearRecoveryFlash();
        // Dismissing a conflict is acknowledging it. Dismissing a failure
        // hides the sentence only: the pill and the dot keep the state until
        // the failure is actually resolved.
        if (bannerEl.dataset.state === 'conflict') conflictNotice = null;
        bannerEl.hidden = true;
        bannerEl.dataset.fading = 'false';
    });
    bannerEl.appendChild(label);
    bannerEl.appendChild(close);
    placeBanner();
}

/**
 * Decide what the banner should show, in priority order.
 *
 *   - a standing failure → persistent failure banner (before anything that
 *     can hide the banner, or the next state change would wipe it).
 *   - state === 'offline' → persistent banner.
 *   - an unacknowledged conflict → persistent conflict banner.
 *   - prev was 'offline' and now isn't → a brief reconnect line, then hide.
 *   - any other transition → hide.
 */
function updateBanner(prev, next) {
    if (!bannerEl) return;

    if (next.state === 'failed' || next.state === 'unsaved') {
        clearRecoveryFlash();
        showBanner(next.state, currentFailure().text);
        return;
    }

    if (next.state === 'offline') {
        clearRecoveryFlash();
        showBanner('offline', 'You’re offline. Changes are saved on this device');
        return;
    }

    if (conflictNotice) {
        clearRecoveryFlash();
        showBanner('conflict', conflictNotice);
        return;
    }

    const justRecovered = prev?.state === 'offline';
    if (justRecovered) {
        clearTimeout(recoveryTimer);
        // GT-36: only claim a sync when one actually happened. A signed-out,
        // local-only user reconnecting was told "Back online. Synced" - there
        // was no account and nothing had been synced anywhere.
        showBanner(next.state === 'synced' ? 'synced' : 'online', reconnectMessage(next.state));
        recoveryTimer = setTimeout(() => {
            if (!bannerEl) return;
            bannerEl.dataset.fading = 'true';
            // Wait for the CSS opacity transition before fully hiding,
            // so screen readers don't get a jarring re-announce.
            setTimeout(() => {
                if (bannerEl && (bannerEl.dataset.state === 'synced' || bannerEl.dataset.state === 'online')) {
                    bannerEl.hidden = true;
                    bannerEl.dataset.fading = 'false';
                }
            }, 220);
        }, RECOVERY_FLASH_MS);
        return;
    }

    // Any other state (synced steady-state, syncing, connecting, idle):
    // banner stays hidden. The recoveryTimer above handles the only
    // case where we briefly show "Synced".
    if (!recoveryTimer) {
        bannerEl.hidden = true;
        bannerEl.dataset.fading = 'false';
    }
}

function render() {
    // A failed start can fix itself: if any namespace is syncing now, the
    // thing that failed is working, so stop saying otherwise. A refused write
    // cannot, so that one stands until the engine reports it recovered.
    if (initFailed) {
        const s = typeof window !== 'undefined' ? window.gymGetGlobalSyncStatus?.() : null;
        if (s && s.activeNamespaces > 0) initFailed = false;
    }
    const next = readCurrent();
    const prev = lastRender;
    if (prev && prev.state === next.state && prev.label === next.label) return;
    lastRender = next;

    for (const el of pillEls) applyToPill(el, next);
    for (const el of dotEls) applyToDot(el, next);
    updateBanner(prev, next);
}

/** Paint a new event now, past render's no-change guard (re-raising a dismissed banner). */
function renderNow() {
    lastRender = null;
    render();
}

/** Give the compact dot the same meaning the pill states in words. */
function applyToDot(el, { state, label }) {
    el.dataset.state = state;
    el.setAttribute('aria-label', `Cloud sync: ${label}`);
    el.title = `Cloud sync: ${label}`;
}

function createPill() {
    const el = document.createElement('div');
    el.className = 'sync-status-pill';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.dataset.state = 'connecting';
    el.textContent = 'Connecting…';
    el.setAttribute('aria-label', 'Sync status: Connecting…');
    el.title = 'Connecting…';
    return el;
}

/** An event about another app's namespace is not Gym news; one without a namespace is. */
function isGymEvent(detail) {
    return !detail || detail.namespace == null || detail.namespace === GYM_NAMESPACE;
}

/** Wrap a listener so a malformed event can never break the page. */
function safely(fn) {
    return (e) => {
        try { fn(e && e.detail); } catch (_) { /* never break a page over a status widget */ }
    };
}

export function mountSyncStatusPill() {
    if (mounted) return;
    mounted = true;

    const slots = document.querySelectorAll('[data-sync-status-slot]');
    slots.forEach((slot) => {
        const el = createPill();
        slot.appendChild(el);
        pillEls.push(el);
    });

    // Compact dots on mobile (e.g., on the "More" bottom-nav button).
    // Same state colour mapping as the pill, but no text — these are
    // pre-existing elements in the markup, so we just track them.
    dotEls = Array.from(document.querySelectorAll('[data-sync-status-dot]'));
    dotEls.forEach((el) => {
        el.dataset.state = 'connecting';
        // The dot had no name and no tooltip, so "what is the small grey dot
        // on More?" had no answer anywhere in the product (GT-36, ancillary).
        el.setAttribute('role', 'img');
    });

    bannerEl = document.getElementById('sync-banner');

    if (pillEls.length === 0 && dotEls.length === 0 && !bannerEl) return;

    render();
    timer = setInterval(render, POLL_MS);

    window.addEventListener('online', render);
    window.addEventListener('offline', render);
    // The header's height changes with the viewport, so the banner's offset
    // has to follow it.
    window.addEventListener('resize', placeBanner);
    // The site header arrives as an injected partial, so its height is not
    // known when this module mounts.
    document.addEventListener('shevato:include-loaded', placeBanner);

    // A write the cloud refused. `retryable: true` means the engine kept it
    // queued and will send it again; anything else (including an engine too
    // old to send the flag, which only fired for writes it would not retry)
    // is permanent. A permanent rejection is never downgraded by a later
    // retryable one: only `syncWriteRecovered` clears it.
    window.addEventListener('syncWriteRejected', safely((detail) => {
        if (!isGymEvent(detail)) return;
        const level = detail && detail.retryable === true ? 'unsaved' : 'failed';
        if (writeFailure !== 'failed') writeFailure = level;
        renderNow();
    }));
    // Every rejected key has since landed.
    window.addEventListener('syncWriteRecovered', safely((detail) => {
        if (!isGymEvent(detail) || !writeFailure) return;
        writeFailure = null;
        render();
    }));
    // Sync never started. Unlike a refused write this one can genuinely
    // recover on its own, so `render` clears it once any namespace is live.
    window.addEventListener('appSyncFailed', safely(() => {
        initFailed = true;
        renderNow();
    }));
    // Two sessions changed the same data; a copy of the losing side was kept.
    // The banner says so and stays up until it is dismissed.
    window.addEventListener('syncConflict', safely((detail) => {
        if (!isGymEvent(detail)) return;
        conflictNotice = conflictMessage(detail);
        renderNow();
    }));
}
