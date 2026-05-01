/**
 * Sync status pill — a small visual indicator of sync state, mounted into
 * the bottom-right corner of the gym tracker viewport. Reflects three
 * states the user actually cares about:
 *   - Synced  — no pending writes, last flush succeeded
 *   - Pending — debounced writes queued waiting to flush
 *   - Offline — browser reports no connectivity (we keep recording locally)
 *
 * Polls `getGlobalSyncStatus()` every 2s and `navigator.onLine`. The cost
 * is trivial — getGlobalStatus() reads two Map sizes — and beats wiring
 * an event channel through the sync layer for now.
 */

const POLL_MS = 2000;

let mounted = false;
let pillEl = null;
let timer = null;

function classify() {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return { state: 'offline', label: 'Offline' };
    }
    const status = window.gymGetGlobalSyncStatus?.();
    if (!status) return { state: 'pending', label: 'Connecting…' };
    if (status.totalQueueSize > 0) return { state: 'pending', label: 'Saving…' };
    if (status.activeNamespaces === 0) return { state: 'pending', label: 'Signed out' };
    return { state: 'synced', label: 'Synced' };
}

function render() {
    if (!pillEl) return;
    const { state, label } = classify();
    pillEl.dataset.state = state;
    pillEl.textContent = label;
}

export function mountSyncStatusPill() {
    if (mounted) return;
    mounted = true;

    pillEl = document.createElement('div');
    pillEl.className = 'sync-status-pill';
    pillEl.setAttribute('role', 'status');
    pillEl.setAttribute('aria-live', 'polite');
    pillEl.dataset.state = 'pending';
    pillEl.textContent = 'Connecting…';
    document.body.appendChild(pillEl);

    render();
    timer = setInterval(render, POLL_MS);

    window.addEventListener('online', render);
    window.addEventListener('offline', render);
}

export function unmountSyncStatusPill() {
    if (timer) { clearInterval(timer); timer = null; }
    if (pillEl && pillEl.parentNode) pillEl.parentNode.removeChild(pillEl);
    pillEl = null;
    mounted = false;
}
