// Shared sync-status indicator
// ----------------------------
// Renders into two surfaces, auto-mounted on DOMContentLoaded:
//
//   1. `#sync-banner` - fixed banner pinned just below the site header
//      (its `top` follows #header's bottom edge, see placeBanner). Only
//      visible when something needs saying: offline (and briefly on the
//      offline -> online transition), a sync conflict, a write that has
//      not reached the cloud, or a sync that could not start. Dismissible
//      with its close button, and silent otherwise so it never competes
//      with the app's content.
//      The recovery copy says "synced" only for a signed-in user whose
//      sync is active; a signed-out visitor just gets "Back online".
//
//   2. Any element with `[data-sync-status-slot]`, gets an inline
//      pill showing the full state label. Use this in a sidebar
//      footer or header. Apps that don't want the pill just skip
//      this attribute.
//
// Gym-tracker has its own ES-module version of this (with the same
// classifier output and DOM contract) that mounts via an explicit
// import. To avoid double-mounting, this classic-script version
// checks `window.__syncStatusMounted` before binding.

(function () {
    'use strict';

    if (window.__syncStatusMounted) return;

    const POLL_MS = 2000;
    const RECOVERY_FLASH_MS = 2000;

    // A FAILURE OUTRANKS EVERY HEALTHY STATE.
    //
    // The engine tells us two things, and for a long time nobody was
    // listening to either. `syncWriteRejected` means a flush did not reach
    // Firestore; `appSyncFailed` means sync could not start at all. Saying
    // "Synced" over either is the one lie this widget must never tell.
    //
    // A rejected write carries `retryable` (2026-09-12 audit S-3):
    //   - true:  the retry ladder ran out on a network-type failure. The engine
    //            has kept the write and resends it when the connection comes
    //            back, the tab becomes visible, the user edits again or sync
    //            restarts. Reads "Not saved to cloud yet" (amber).
    //   - false: the server refused it (rules, shape, size). Reads "Not saved
    //            to cloud" (red). A missing flag means false, which is what
    //            the event meant before the flag existed.
    // Either way the namespace stays unsaved until the engine dispatches
    // `syncWriteRecovered` for THAT namespace. A healthy poll, or another
    // namespace recovering, is not evidence that this one landed.
    //
    // Failures are checked after `offline` on purpose: when the connection is
    // down, "Offline" is the more useful and more actionable truth, and the
    // failure is still there when the connection comes back.
    const writeFailures = new Map();   // namespace -> { retryable: boolean }
    let initFailure = null;

    function namesOf(retryable) {
        const names = [];
        writeFailures.forEach(function (f, ns) {
            if (f.retryable === retryable && ns) names.push(ns);
        });
        return names;
    }

    // The failure to show, most serious first: a refused write, then a write
    // still waiting to be resent, then a sync that never started.
    function currentFailure() {
        const refused = namesOf(false);
        const pending = namesOf(true);
        if (refused.length || (writeFailures.size && !pending.length)) {
            const where = refused.length ? ' in ' + refused.join(', ') : '';
            return {
                state: 'failed',
                label: 'Not saved to cloud',
                text: 'Some changes' + where + ' could not be saved to the cloud. They are safe on this '
                    + 'device, but they are not syncing to your other devices.',
            };
        }
        if (pending.length) {
            return {
                state: 'unsaved',
                label: 'Not saved to cloud yet',
                text: 'Some changes in ' + pending.join(', ') + ' have not been saved to the cloud yet. '
                    + 'They are safe on this device, and sync will try again.',
            };
        }
        if (initFailure) {
            return {
                state: 'failed',
                label: 'Sync unavailable',
                text: 'Sync could not start. Your changes are being saved on this device only.',
            };
        }
        return null;
    }

    function classify(online, status, signedIn) {
        if (online === false) return { state: 'offline', label: 'Offline' };
        const failure = currentFailure();
        if (failure) return { state: failure.state, label: failure.label };
        if (!status) return { state: 'connecting', label: 'Connecting…' };
        if (status.totalQueueSize > 0) return { state: 'syncing', label: 'Saving…' };
        if (status.activeNamespaces === 0) {
            if (signedIn) return { state: 'connecting', label: 'Connecting…' };
            return { state: 'idle', label: 'Local only' };
        }
        return { state: 'synced', label: 'Synced' };
    }

    function readCurrent() {
        const online = navigator.onLine !== false;
        const status = typeof window.gymGetGlobalSyncStatus === 'function'
            ? window.gymGetGlobalSyncStatus()
            : null;
        const signedIn = !!(window.firebaseAuth && typeof window.firebaseAuth.getCurrentUser === 'function'
            && window.firebaseAuth.getCurrentUser());
        return classify(online, status, signedIn);
    }

    let pillEls = [];
    let bannerEl = null;
    let lastRender = null;
    let recoveryTimer = null;
    let pollTimer = null;

    function applyToPill(el, next) {
        el.dataset.state = next.state;
        el.textContent = next.label;
        el.setAttribute('aria-label', 'Sync status: ' + next.label);
        el.title = next.label;
    }

    // Keep the banner under the fixed site header so the header controls
    // stay clickable; on pages without #header it sits at the top.
    function placeBanner() {
        if (!bannerEl || bannerEl.hidden) return;
        const header = document.getElementById('header');
        const bottom = header ? Math.max(0, Math.round(header.getBoundingClientRect().bottom)) : 0;
        bannerEl.style.top = bottom + 'px';
    }

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
        close.textContent = '\u00d7';
        close.addEventListener('click', function () {
            clearTimeout(recoveryTimer);
            recoveryTimer = null;
            bannerEl.hidden = true;
            bannerEl.dataset.fading = 'false';
        });
        bannerEl.appendChild(label);
        bannerEl.appendChild(close);
        placeBanner();
    }

    function updateBanner(prev, next) {
        if (!bannerEl) return;

        // Before anything that can hide the banner: a standing failure keeps
        // its message up. Without this the 2s poll would wipe it on the very
        // next tick, because the tail of this function hides the banner for
        // every state it does not recognise.
        const failure = currentFailure();
        if (failure && next.state === failure.state) {
            clearTimeout(recoveryTimer);
            recoveryTimer = null;
            showBanner(failure.state, failure.text);
            return;
        }

        if (next.state === 'offline') {
            clearTimeout(recoveryTimer);
            recoveryTimer = null;
            showBanner('offline', 'You\u2019re offline, changes saved on this device');
            return;
        }

        const justRecovered = prev && prev.state === 'offline';
        if (justRecovered) {
            clearTimeout(recoveryTimer);
            showBanner('synced', next.state === 'synced' ? 'Back online, synced' : 'Back online');
            recoveryTimer = setTimeout(function () {
                if (!bannerEl) return;
                bannerEl.dataset.fading = 'true';
                setTimeout(function () {
                    if (bannerEl && bannerEl.dataset.state === 'synced') {
                        bannerEl.hidden = true;
                        bannerEl.dataset.fading = 'false';
                    }
                }, 220);
            }, RECOVERY_FLASH_MS);
            return;
        }

        if (!recoveryTimer) {
            bannerEl.hidden = true;
            bannerEl.dataset.fading = 'false';
        }
    }

    // A sync conflict is the one sync event a user has to be TOLD about.
    //
    // Two devices editing the same collection used to resolve silently, and
    // the losing side simply stopped existing. The engine now merges what it
    // can and keeps a recoverable copy of whatever it cannot, but neither is
    // any use if nobody knows it happened - so the banner says so, and stays
    // up (no auto-fade) until it is dismissed.
    //
    // WORDING. This used to open with "Another device had changed this too",
    // which the engine had no way of knowing. It fired whenever a remote
    // value differed from the local one while a local write was still in
    // flight, which was routinely this same device's own Firestore echo
    // arriving a moment late. The engine now recognises its own writes and
    // an unchanged cloud before it will call anything a conflict (see
    // decideRemoteChange), so by the time this runs there really was an edit
    // from somewhere else. It still cannot tell WHERE: another tab, another
    // browser and another device are indistinguishable to it, and only one
    // of those is a "device". "Another session" is what is actually known.
    function showConflictBanner(detail) {
        if (!bannerEl) return;
        clearTimeout(recoveryTimer);
        recoveryTimer = null;
        const merged = detail && detail.resolution === 'merged';
        const conflicted = merged && detail.conflictedRecordIds && detail.conflictedRecordIds.length;
        showBanner('conflict', merged
            ? (conflicted
                ? 'Changes from another session were merged; ' + conflicted
                  + ' item' + (conflicted === 1 ? '' : 's') + ' differed and a copy of yours was saved on this device'
                : 'Changes from another session were merged in')
            : 'This was edited in another session too. The newer version is in use, and a copy of the other one was saved on this device.');
    }

    /**
     * Record a sync failure and paint it immediately.
     *
     * Deliberately NOT auto-dismissed: the condition lasts until the engine
     * reports recovery, and a message that fades is a message that was never
     * delivered. The banner's close button hides the banner; the pill keeps
     * the state.
     */
    function noteFailure(kind, detail) {
        if (kind === 'init') {
            initFailure = { kind: 'init' };
        } else {
            const ns = detail && detail.namespace ? String(detail.namespace) : '';
            const prev = writeFailures.get(ns);
            // Once refused, a namespace stays refused until it recovers: a later
            // retryable failure on another key does not soften the message.
            const retryable = detail && detail.retryable === true && !(prev && prev.retryable === false);
            writeFailures.set(ns, { retryable: retryable });
        }
        lastRender = null;   // force the next render past its no-change guard
        render();
    }

    // The engine confirmed every rejected write in this namespace has landed.
    function noteRecovered(detail) {
        const ns = detail && detail.namespace ? String(detail.namespace) : '';
        if (!writeFailures.delete(ns)) return;
        lastRender = null;
        render();
    }

    function render() {
        // An init failure can fix itself: if any namespace is syncing now, the
        // thing that failed is working, so stop saying otherwise. A rejected
        // write is retired only by `syncWriteRecovered`, never by a poll.
        if (initFailure) {
            const s = typeof window.gymGetGlobalSyncStatus === 'function'
                ? window.gymGetGlobalSyncStatus()
                : null;
            if (s && s.activeNamespaces > 0) initFailure = null;
        }
        const next = readCurrent();
        const prev = lastRender;
        if (prev && prev.state === next.state && prev.label === next.label) return;
        lastRender = next;
        for (let i = 0; i < pillEls.length; i++) applyToPill(pillEls[i], next);
        updateBanner(prev, next);
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

    function mount() {
        if (window.__syncStatusMounted) return;
        window.__syncStatusMounted = true;

        const slots = document.querySelectorAll('[data-sync-status-slot]');
        for (let i = 0; i < slots.length; i++) {
            const pill = createPill();
            slots[i].appendChild(pill);
            pillEls.push(pill);
        }

        bannerEl = document.getElementById('sync-banner');

        if (pillEls.length === 0 && !bannerEl) {
            window.__syncStatusMounted = false;
            return;
        }

        render();
        pollTimer = setInterval(render, POLL_MS);
        window.addEventListener('online', render);
        window.addEventListener('offline', render);
        window.addEventListener('resize', placeBanner);
        // The site header is an injected partial: if the banner is already up
        // when it lands, re-place the banner under it (main.js dispatches this
        // from every include callback).
        document.addEventListener('shevato:include-loaded', placeBanner);
        window.addEventListener('syncConflict', function (e) {
            try { showConflictBanner(e && e.detail); } catch (err) { /* never break a page */ }
        });
        // A write that did not reach the cloud, retryable or not. It names the
        // app whose data is affected, because on a site where eight apps share
        // one account "sync failed" without a subject is not actionable.
        window.addEventListener('syncWriteRejected', function (e) {
            try { noteFailure('write', e && e.detail); } catch (err) { /* never break a page */ }
        });
        window.addEventListener('syncWriteRecovered', function (e) {
            try { noteRecovered(e && e.detail); } catch (err) { /* never break a page */ }
        });
        // Sync never started. Unlike a rejected write this one can genuinely
        // recover on its own, so `render` clears it once any namespace is live.
        window.addEventListener('appSyncFailed', function (e) {
            try { noteFailure('init', e && e.detail); } catch (err) { /* never break a page */ }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount);
    } else {
        mount();
    }
})();
