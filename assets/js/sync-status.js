// Shared sync-status indicator
// ----------------------------
// Renders into two surfaces, auto-mounted on DOMContentLoaded:
//
//   1. `#sync-banner` - fixed banner pinned just below the site header
//      (its `top` follows #header's bottom edge, see placeBanner). Only
//      visible when the user is offline (or briefly on the offline ->
//      online transition), dismissible with its close button, and
//      silent otherwise so it never competes with the app's content.
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

    function classify(online, status, signedIn) {
        if (online === false) return { state: 'offline', label: 'Offline' };
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

    function render() {
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
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount);
    } else {
        mount();
    }
})();
