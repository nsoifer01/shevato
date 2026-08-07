/**
 * Gym Tracker's bridge to the shared site analytics helper.
 *
 * The helper itself lives at /assets/js/analytics.js and is installed on
 * window by a deferred classic script, so it cannot be imported directly from
 * an ES module. This wrapper resolves it at call time (not import time,
 * because module evaluation can beat the deferred script) and swallows
 * everything, so a tracking failure can never surface as a broken workout.
 */

/**
 * Calls a method on the shared analytics helper if it is present.
 * @param {string} method one of the shevatoAnalytics API methods
 * @param {...*} args forwarded verbatim
 */
export function track(method, ...args) {
  try {
    const a = typeof window !== 'undefined' ? window.shevatoAnalytics : null;
    if (a && typeof a[method] === 'function') a[method](...args);
  } catch (e) {
    /* analytics must never break the app */
  }
}
