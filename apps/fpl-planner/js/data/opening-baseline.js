// THE SHIPPED OPENING-SEASON BASELINE, loaded from the app's own files.
//
// `engine/baseline.js` explains why this asset exists: the kept-snapshot
// mechanism can only help a browser that was already running it when the last
// complete payload arrived, and in 2026 no browser was. This module is the
// loader; the engine owns every decision about whether the asset may be used.
//
// It is fetched, not imported, for the same reason the trained model is: it is
// data, it is 60 KB, and it is only relevant in the opening weeks of a season.
// A page that does not need it never pays for it, and a deployment that is
// missing it degrades to "no baseline" rather than to a blank app.

import { validateOpeningBaseline } from '../engine/baseline.js';

// Deliberately NOT named after a season. Which season this asset is for is a
// fact INSIDE it (`appliesToSeason`), checked against the live payload every
// time it is used, so next August's file replaces this one at the same path and
// no code has to be edited. `tests/rules.test.mjs` enforces the same rule for
// every module under js/engine and js/data.
export const OPENING_BASELINE_FILE = 'opening-baseline.json';

// The asset is small but it is parsed from a network response, so a page that
// recalculates several times should not fetch it several times. Cached by URL,
// including the failure, because a missing file will still be missing.
const cache = new Map();

/**
 * Load the shipped baseline. Never throws and never returns a partial object:
 * either the parsed asset, or null with a stated reason.
 *
 * Returns `{ baseline, reason }`.
 */
export async function loadOpeningBaseline({ basePath, fetchImpl } = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? (...a) => fetch(...a) : null);
  if (!doFetch) return { baseline: null, reason: 'no fetch available in this environment' };

  const base = basePath || new URL('../../data/', import.meta.url).href;
  const url = `${base}${OPENING_BASELINE_FILE}`;
  if (cache.has(url)) return cache.get(url);

  let result;
  try {
    const res = await doFetch(url);
    if (!res.ok) result = { baseline: null, reason: `${OPENING_BASELINE_FILE} returned ${res.status}` };
    else {
      const parsed = await res.json();
      result = { baseline: parsed, reason: null };
    }
  } catch (err) {
    result = { baseline: null, reason: `${OPENING_BASELINE_FILE} could not be read: ${err.message}` };
  }

  cache.set(url, result);
  return result;
}

/** Test seam: forget what has been fetched. */
export function resetOpeningBaselineCache() {
  cache.clear();
}

/**
 * Would this payload be helped by the shipped baseline at all?
 *
 * Answered before the fetch so the file is only requested in the state it
 * exists for: a season that has rolled over, whose totals are not yet a season
 * of their own. Outside that window the answer is no and nothing is loaded.
 */
export function openingBaselineApplies(gameState, { assessment, superseded }) {
  if (!gameState || gameState.sample) return false;
  if (assessment && assessment.complete) return false;
  return !superseded;
}

/** Re-export so callers need one import for the whole decision. */
export { validateOpeningBaseline };
