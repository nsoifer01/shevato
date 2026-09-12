/**
 * Shared plumbing for the service-worker freshness guard.
 *
 * `sw.js` precaches a fixed list of files under a name derived from
 * `CACHE_VERSION`. If a precached file changes but the version does not, the
 * installed worker keeps serving the PREVIOUS generation of the app: the first
 * load after a deploy is stale, the offline floor is frozen at the old build,
 * and because no new worker ever reaches "installed" the app's
 * "Update available / Reload now" prompt never fires either.
 *
 * That is invisible in development (the network is up and dev tools usually
 * bypass the worker), so it is caught here instead: this module hashes the
 * CONTENT of every `PRECACHE_URLS` entry into a committed manifest, and
 * `tests/sw-precache-content-version.test.mjs` fails when the content moves
 * without the version moving with it.
 *
 * Refresh the manifest with:
 *   node apps/gym-tracker/scripts/update-precache-manifest.mjs
 *
 * This file deliberately does not match node's test-file glob (*.test.mjs),
 * so `node --test apps/gym-tracker/tests/` never runs it directly.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP_ROOT = new URL('../../', import.meta.url);

export const MANIFEST_PATH = fileURLToPath(new URL('tests/fixtures/sw-precache-manifest.json', APP_ROOT));
export const SW_PATH = fileURLToPath(new URL('sw.js', APP_ROOT));

/** The CACHE_VERSION and PRECACHE_URLS literals, read as text (sw.js never runs here). */
export function readSw(src = readFileSync(SW_PATH, 'utf8')) {
    const version = /const CACHE_VERSION = '([^']+)'/.exec(src);
    if (!version) throw new Error('CACHE_VERSION literal not found in sw.js');
    const list = /const PRECACHE_URLS = (\[[\s\S]*?\]);/.exec(src);
    if (!list) throw new Error('PRECACHE_URLS literal not found in sw.js');
    const urls = JSON.parse(list[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));
    return { cacheVersion: version[1], urls };
}

/** `./` is the navigation request for the shell, which is index.html on disk. */
function fileFor(url) {
    return fileURLToPath(new URL(url === './' ? './index.html' : url, APP_ROOT));
}

/**
 * `{ cacheVersion, files: { "<url>": "<sha256 prefix>" } }` for the tree as it
 * stands. Content hashes, not mtimes: a reformat that changes no bytes must
 * not demand a version bump, and a one-character edit must.
 */
export function computeManifest(sw = readSw()) {
    const files = {};
    for (const url of sw.urls) {
        files[url] = createHash('sha256').update(readFileSync(fileFor(url))).digest('hex').slice(0, 16);
    }
    return { cacheVersion: sw.cacheVersion, files };
}

export function readManifest() {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
}

export function serializeManifest(manifest) {
    return `${JSON.stringify(manifest, null, 2)}\n`;
}
