/**
 * A precached file must never change without CACHE_VERSION changing.
 *
 * `sw.js` names its caches `gym-precache-${CACHE_VERSION}` and
 * `gym-runtime-${CACHE_VERSION}`, so the version IS the cache identity. Edit
 * a precached module and leave the version alone and the installed worker has
 * nothing to install: it keeps serving the previous generation of the app
 * shell from the cache it already has. Three consequences, all silent:
 *
 *   1. The first load after the deploy is the OLD build, for every returning
 *      user, until something else evicts the cache.
 *   2. The offline floor freezes at the old build, indefinitely.
 *   3. `app.js` only offers "Update available / Reload now" when a new worker
 *      reaches `installed`. No new worker, no prompt, ever.
 *
 * It happened: 1.15.0 was set on 2026-08-23 and five later commits edited
 * precached js/css/index.html without touching it.
 *
 * `tests/sw-precache-completeness.test.mjs` covers the LIST (is every module
 * on it, does every entry exist). This file covers the CONTENT.
 */
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    computeManifest, readManifest, readSw,
} from './helpers/precache-manifest.mjs';

const UPDATE_CMD = 'node apps/gym-tracker/scripts/update-precache-manifest.mjs';

test('every precached file is accounted for in the manifest', () => {
    const { urls } = readSw();
    const committed = readManifest();
    const missing = urls.filter((u) => !(u in committed.files));
    const extra = Object.keys(committed.files).filter((u) => !urls.includes(u));
    assert.deepEqual({ missing, extra }, { missing: [], extra: [] },
        'PRECACHE_URLS and the committed manifest list different files. '
        + `Bump CACHE_VERSION in apps/gym-tracker/sw.js (MINOR: the list shape changed), then run:\n  ${UPDATE_CMD}`);
});

test('precached content has not changed since CACHE_VERSION was set', () => {
    const current = computeManifest();
    const committed = readManifest();

    const changed = Object.keys(current.files)
        .filter((url) => url in committed.files && committed.files[url] !== current.files[url]);
    const versionMoved = committed.cacheVersion !== current.cacheVersion;

    if (changed.length && !versionMoved) {
        assert.fail(
            `${changed.length} precached file(s) changed while CACHE_VERSION stayed at `
            + `${current.cacheVersion}. Returning users would be served the PREVIOUS build on their `
            + 'next load, would stay on it offline, and would never see the update prompt.\n\n'
            + `Changed:\n  ${changed.join('\n  ')}\n\n`
            + 'Fix, in order:\n'
            + '  1. Bump CACHE_VERSION in apps/gym-tracker/sw.js. Its own header states the rule:\n'
            + '     PATCH for file edits/additions, MINOR if the list shape or a cache strategy\n'
            + '     changed, MAJOR for a back-compat break.\n'
            + `  2. Run: ${UPDATE_CMD}\n`
            + '  3. Commit the refreshed tests/fixtures/sw-precache-manifest.json with your change.'
        );
    }

    assert.deepEqual(current, committed,
        'The committed precache manifest is out of date (the version moved, or the '
        + `content did after a bump). Refresh it and commit the result:\n  ${UPDATE_CMD}`);
});

test('the manifest fixture is a real, populated manifest', () => {
    // A fixture that silently emptied itself would make the guard above pass
    // for every possible tree.
    const committed = readManifest();
    assert.match(committed.cacheVersion, /^\d+\.\d+\.\d+$/);
    assert.ok(Object.keys(committed.files).length >= 50,
        `expected the full precache list, found ${Object.keys(committed.files).length} entries`);
    for (const [url, hash] of Object.entries(committed.files)) {
        assert.match(hash, /^[0-9a-f]{16}$/, `${url} has no usable content hash`);
    }
});
