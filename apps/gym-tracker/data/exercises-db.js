/**
 * Lazy loader for the exercise database.
 *
 * The actual catalog (~75 KB, 513 entries) lives in `exercises-db.json`
 * and is fetched on demand. This module memoizes the Promise so every
 * caller after the first reuses the same in-flight fetch.
 *
 * Why JSON instead of a `.js` constant: shaving 75 KB off the initial
 * JS parse step and decoupling refresh — the precache + browser HTTP
 * cache can revalidate just the data file without forcing an SW
 * precache bump on every entry tweak. The JSON is also smaller than
 * the equivalent JS source (no syntax overhead, no comments).
 *
 * Backwards-compat: legacy code that imported `EXERCISE_DATABASE`
 * directly used to get a populated array on script evaluation. We
 * still export the same name for surface-level compatibility, but it
 * starts empty and is filled by `loadExerciseDatabase()`. Callers that
 * need it populated must await the loader (the gym tracker's `app.init()`
 * does this before the first render).
 */

let _cache = null;
let _inflight = null;

/**
 * Returns a Promise resolving to the exercise array. Idempotent — the
 * second call returns the same memoized array (or the in-flight fetch
 * Promise if a load is already underway).
 */
export async function loadExerciseDatabase() {
    if (_cache) return _cache;
    if (_inflight) return _inflight;

    // Resolve relative to THIS module so the path works regardless of
    // where the consuming page lives.
    const url = new URL('./exercises-db.json', import.meta.url);
    _inflight = fetch(url.href, { credentials: 'omit' })
        .then((res) => {
            if (!res.ok) throw new Error(`Exercise DB fetch failed: ${res.status}`);
            return res.json();
        })
        .then((data) => {
            _cache = Array.isArray(data) ? data : [];
            // Mirror into the legacy export so any synchronous `.length`
            // check on EXERCISE_DATABASE after this point sees real data.
            EXERCISE_DATABASE.length = 0;
            EXERCISE_DATABASE.push(..._cache);
            return _cache;
        })
        .catch((err) => {
            console.error('Failed to load exercise database', err);
            _cache = [];
            _inflight = null;
            return _cache;
        });

    return _inflight;
}

/**
 * Legacy export retained for code that imports the constant directly.
 * Starts empty; populated as a side-effect of `loadExerciseDatabase()`.
 */
export const EXERCISE_DATABASE = [];
