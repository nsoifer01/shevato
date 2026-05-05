/**
 * Sync status indicators.
 *
 * Two surfaces, picked to suit each form factor:
 *
 *   1. Inline pill — rendered into `[data-sync-status-slot]` placeholders
 *      (currently just the desktop side-nav footer). Always visible,
 *      shows the full state label. Out of the way on desktop because
 *      there's plenty of sidebar real estate.
 *
 *   2. Mobile top banner (`#sync-banner`) — pinned to the top of the
 *      viewport, only shown when state is `offline`, plus a brief
 *      green "Synced" confirmation on the offline→synced transition.
 *      Silent in every other state, so it never competes with the
 *      workout screen. Hidden on desktop via CSS.
 *
 * The poll-based read is kept (2 s + online/offline events) and
 * `render()` dedupes by last (state, label) so background ticks do
 * not thrash the DOM — that was the source of the green/amber flicker
 * users saw between sets.
 */

const POLL_MS = 2000;
const RECOVERY_FLASH_MS = 2000;

let mounted = false;
let pillEls = [];
let dotEls = [];
let bannerEl = null;
let timer = null;
let lastRender = null;
let recoveryTimer = null;

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
 */
export function classifySyncStatus({ online, status, signedIn = false }) {
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
    const online = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
    const status = typeof window !== 'undefined' ? window.gymGetGlobalSyncStatus?.() : null;
    const signedIn = typeof window !== 'undefined'
        && !!window.firebaseAuth?.getCurrentUser?.();
    return classifySyncStatus({ online, status, signedIn });
}

function applyToPill(el, { state, label }) {
    el.dataset.state = state;
    el.textContent = label;
    el.setAttribute('aria-label', `Sync status: ${label}`);
    el.title = label;
}

/**
 * Decide what the mobile banner should show.
 *
 *   - state === 'offline' → persistent banner.
 *   - prev was 'offline' and now isn't → green "Synced" for ~2 s, then hide.
 *   - any other transition → hide.
 */
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

    const justRecovered = prev?.state === 'offline';
    if (justRecovered) {
        clearTimeout(recoveryTimer);
        bannerEl.hidden = false;
        bannerEl.dataset.state = 'synced';
        bannerEl.dataset.fading = 'false';
        bannerEl.textContent = 'Back online — synced';
        recoveryTimer = setTimeout(() => {
            if (!bannerEl) return;
            bannerEl.dataset.fading = 'true';
            // Wait for the CSS opacity transition before fully hiding,
            // so screen readers don't get a jarring re-announce.
            setTimeout(() => {
                if (bannerEl && bannerEl.dataset.state === 'synced') {
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
    const next = readCurrent();
    const prev = lastRender;
    if (prev && prev.state === next.state && prev.label === next.label) return;
    lastRender = next;

    for (const el of pillEls) applyToPill(el, next);
    for (const el of dotEls) el.dataset.state = next.state;
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
    dotEls.forEach((el) => { el.dataset.state = 'connecting'; });

    bannerEl = document.getElementById('sync-banner');

    if (pillEls.length === 0 && dotEls.length === 0 && !bannerEl) return;

    render();
    timer = setInterval(render, POLL_MS);

    window.addEventListener('online', render);
    window.addEventListener('offline', render);
}
