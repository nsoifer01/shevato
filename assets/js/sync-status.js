// Shared sync-status indicator
// ----------------------------
// Renders into two surfaces, auto-mounted on DOMContentLoaded:
//
//   1. `#sync-banner` — fixed top-of-viewport banner. Only visible
//      when the user is offline (or briefly on the offline -> synced
//      transition). Silent otherwise so it never competes with the
//      app's own content.
//
//   2. Any element with `[data-sync-status-slot]` — gets an inline
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

    function updateBanner(prev, next) {
        if (!bannerEl) return;

        if (next.state === 'offline') {
            clearTimeout(recoveryTimer);
            recoveryTimer = null;
            bannerEl.hidden = false;
            bannerEl.dataset.state = 'offline';
            bannerEl.dataset.fading = 'false';
            bannerEl.textContent = 'You’re offline — changes saved on this device';
            return;
        }

        const justRecovered = prev && prev.state === 'offline';
        if (justRecovered) {
            clearTimeout(recoveryTimer);
            bannerEl.hidden = false;
            bannerEl.dataset.state = 'synced';
            bannerEl.dataset.fading = 'false';
            bannerEl.textContent = 'Back online — synced';
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
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount);
    } else {
        mount();
    }
})();
