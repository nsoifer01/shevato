/**
 * Tiny custom event bus.
 *
 * Replaces the existing pattern of "mutate `app.programs`, manually call
 * `app.savePrograms()`, manually call `view.render()`" with a single
 * mutation funnel that emits a domain event. Views subscribe to the
 * events they care about and re-render on their own schedule.
 *
 * Why custom over RxJS / mitt: this app's needs are 30 lines of code
 * — `on`, `off`, `emit`, `once`. A library wouldn't pay for itself in
 * either bundle size or expressivity here. Listeners receive one
 * payload arg; multi-arg `emit` collapses to an args array if needed.
 *
 * Listener errors are isolated — one listener throwing does not stop
 * the rest of the dispatch. Errors are surfaced to console.error so
 * they aren't silently swallowed.
 */

const listeners = new Map(); // event name → Set<fn>

export function on(event, fn) {
    if (typeof fn !== 'function') return () => {};
    let set = listeners.get(event);
    if (!set) {
        set = new Set();
        listeners.set(event, set);
    }
    set.add(fn);
    return () => off(event, fn);
}

export function once(event, fn) {
    const wrapper = (payload) => {
        off(event, wrapper);
        fn(payload);
    };
    return on(event, wrapper);
}

export function off(event, fn) {
    const set = listeners.get(event);
    if (!set) return;
    set.delete(fn);
    if (set.size === 0) listeners.delete(event);
}

export function emit(event, payload) {
    const set = listeners.get(event);
    if (!set || set.size === 0) return;
    // Snapshot so a listener that off()s itself mid-dispatch doesn't
    // mutate the iteration.
    for (const fn of [...set]) {
        try { fn(payload); }
        catch (err) { console.error(`event-bus listener for "${event}" threw`, err); }
    }
}

/** Test / debug helper: nuke every listener on every event. */
export function _clearAllListenersForTesting() {
    listeners.clear();
}

/** Domain event names. Centralised so views don't typo a string. */
export const EVENTS = Object.freeze({
    PROGRAMS_CHANGED: 'programs:changed',
    SESSIONS_CHANGED: 'sessions:changed',
    ACHIEVEMENTS_CHANGED: 'achievements:changed',
    SETTINGS_CHANGED: 'settings:changed',
    CUSTOM_EXERCISES_CHANGED: 'custom-exercises:changed',
    MEASUREMENTS_CHANGED: 'measurements:changed',
});
